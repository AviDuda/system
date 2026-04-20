#!/usr/bin/env bash
set -euo pipefail

# windows-utm.sh -- Download Windows 11 ARM64 ISO and create a UTM VM
# with unattended installation (no manual clicks needed).
#
# Usage:
#   ./scripts/windows-utm.sh [options]
#
# Options:
#   --name NAME         VM name in UTM (default: windows-11)
#   --username USER     Windows local account (default: user)
#   --password PASS     Windows local account password (default: password)
#   --disk SIZE         Disk size in GB (default: 64)
#   --memory SIZE       RAM in MB (default: 8192)
#   --cores N           CPU cores (default: 6)
#   --iso PATH          Use existing Windows ISO instead of downloading
#   --emulate           Use QEMU emulation instead of Apple Hypervisor
#   --clean             Remove cached downloads and exit

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="/tmp/windows-utm-build"

# Defaults
VM_NAME="windows-11"
USERNAME="user"
PASSWORD="password"
DISK_GB=64
MEMORY_MB=8192
CPU_CORES=6
ISO_PATH=""
EMULATE=false
CLEAN=false

# URLs
# Resolved dynamically via GitHub API (version is in the filename)
VIRTIO_REPO="qemus/virtiso-arm"
UTM_GUEST_TOOLS_URL="https://getutm.app/downloads/utm-guest-tools-latest.iso"
# massgrave.dev maintains a markdown file with current direct Microsoft CDN links.
# We parse the "default" (recommended) tab at runtime, so when massgrave
# updates the recommended build, we automatically follow.
MASGRAVE_ARM_LINKS="https://raw.githubusercontent.com/massgravel/massgrave.dev/main/docs/windows_arm_links.md"
# We extract the UTM guest tools exe from their ISO (which also ships an
# autounattend.xml that would conflict with ours -- UTM issue #7476).
# VirtIO ARM64 drivers are downloaded separately for the install phase.

usage() {
    sed -n '/^# Usage:/,/^[^#]/p' "$0" | head -n -1 | sed 's/^# \?//'
    exit "${1:-0}"
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --name)      VM_NAME="$2"; shift 2 ;;
            --username)  USERNAME="$2"; shift 2 ;;
            --password)  PASSWORD="$2"; shift 2 ;;
            --disk)      DISK_GB="$2"; shift 2 ;;
            --memory)    MEMORY_MB="$2"; shift 2 ;;
            --cores)     CPU_CORES="$2"; shift 2 ;;
            --iso)       ISO_PATH="$2"; shift 2 ;;
            --emulate)   EMULATE=true; shift ;;
            --clean)     CLEAN=true; shift ;;
            --help|-h)   usage 0 ;;
            *)           echo "Unknown option: $1"; usage 1 ;;
        esac
    done
}

# Resolve the latest Windows ARM64 ISO download URL from massgrave.dev.
# Parses the "default" (recommended) tab from the ARM64 links page,
# which always tracks the current Microsoft CDN download link.
resolve_iso_url() {
    local content
    content="$(curl -sL "$MASGRAVE_ARM_LINKS")"

    # Extract the first <TabItem ... default> block (recommended version)
    # and find the English ISO link from Microsoft's CDN.
    echo "$content" \
        | awk '/<TabItem.*default>/{found=1} found{print} found&&/<\/TabItem>/{exit}' \
        | grep '| English ' \
        | grep -v 'United Kingdom' \
        | grep -o 'https://software-static[^)]*' \
        | head -1
}

# Check if cached file matches current server version via ETag.
# Returns 0 (true) if cache is current, 1 (false) if stale or missing.
check_etag() {
    local dest="$1" url="$2"
    local etag_file="${dest}.etag"

    [[ -f "$dest" && -f "$etag_file" ]] || return 1

    local cached_etag
    cached_etag="$(cat "$etag_file")"
    echo "  Checking if cached ISO is current..."
    local http_code
    http_code="$(curl -s -o /dev/null -w '%{http_code}' \
        -H "If-None-Match: $cached_etag" \
        --head -L "$url")"

    if [[ "$http_code" == "304" ]]; then
        echo "  Cached ISO is current (ETag match), skipping download."
        return 0
    fi
    echo "  Cached ISO is stale, re-downloading."
    return 1
}

# Save ETag and CDN filename from server for future cache checks.
save_etag() {
    local dest="$1" url="$2"
    local etag_file="${dest}.etag"

    local header_file="$WORK_DIR/etag-headers.txt"
    curl -s -D "$header_file" -o /dev/null --head -L "$url" 2>/dev/null || true
    local new_etag
    new_etag="$(grep -i '^etag:' "$header_file" 2>/dev/null | tail -1 \
        | sed 's/^[Ee][Tt][Aa][Gg]: *//; s/\r$//')"
    if [[ -n "$new_etag" ]]; then
        echo "$new_etag" > "$etag_file"
    fi
    rm -f "$header_file"

    # Store CDN filename for hash lookup on cached re-runs
    basename "$url" > "${dest}.cdn_name"
}

# Look up the expected SHA-256 hash for an ISO file from files.rg-adguard.net.
# This is the canonical third-party database of Microsoft file hashes.
# Returns the hash on stdout, or empty string if lookup fails.
lookup_expected_hash() {
    local filename="$1"

    # Step 1: Search by filename to get the detail page URL
    local search_html
    search_html="$(curl -s 'https://files.rg-adguard.net/search' \
        -X POST \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-urlencode "search=$filename")"

    local detail_url
    detail_url="$(echo "$search_html" \
        | grep -o 'files.rg-adguard.net/file/[a-f0-9-]*' \
        | head -1)"

    if [[ -z "$detail_url" ]]; then
        return 0
    fi

    # Step 2: Fetch detail page and extract SHA-256 from meta tag
    local detail_html
    detail_html="$(curl -sL "https://$detail_url")"
    echo "$detail_html" \
        | grep -o 'SHA-256: [a-f0-9]*' \
        | head -1 \
        | cut -d' ' -f2
}

# Compute SHA-256 hash of an ISO file and verify against known-good hash
# from files.rg-adguard.net. Prints result and returns 1 on mismatch.
# $1 = local ISO path, $2 = original CDN filename (for rg-adguard lookup)
verify_iso_hash() {
    local iso="$1" cdn_filename="${2:-}"
    echo "  Computing SHA-256 for integrity verification..."
    local actual_hash
    actual_hash="$(shasum -a 256 "$iso" | cut -d' ' -f1)"
    echo "  SHA-256: $actual_hash"

    # Look up expected hash from rg-adguard database
    local expected_hash
    if [[ -n "$cdn_filename" ]]; then
        expected_hash="$(lookup_expected_hash "$cdn_filename")"
    fi

    if [[ -n "$expected_hash" ]]; then
        echo "  Expected: $expected_hash (from files.rg-adguard.net)"
        if [[ "$actual_hash" == "$expected_hash" ]]; then
            echo "  Hash verified -- ISO is genuine."
        else
            echo "  WARNING: Hash mismatch! File may be corrupted or tampered."
            echo "  Verify manually at: https://files.rg-adguard.net/search"
            return 1
        fi
    else
        echo "  Could not look up expected hash (rg-adguard lookup failed)."
        echo "  Verify manually at: https://files.rg-adguard.net/search"
    fi
}

# Download Windows 11 ARM64 ISO.
# Uses aria2c for multi-connection download (faster) with curl fallback.
# ETag caching avoids re-downloading ~7GB when the cached ISO is current.
download_windows_iso() {
    local dest="$1"

    echo "Resolving Windows 11 ARM64 ISO download link..."
    local download_url
    download_url="$(resolve_iso_url)"

    if [[ -z "$download_url" ]]; then
        echo "ERROR: Could not resolve download URL from massgrave.dev."
        echo "  Download manually from: https://www.microsoft.com/en-us/software-download/windows11arm64"
        echo "  Or find links at: https://massgrave.dev/windows_arm_links"
        echo "  Save as: $dest"
        exit 1
    fi

    local filename
    filename="$(basename "$download_url")"
    echo "  Build: $filename"

    # Check ETag to see if cached ISO is still current
    if check_etag "$dest" "$download_url"; then
        verify_iso_hash "$dest" "$filename"
        return 0
    fi

    echo "  Downloading (~7GB)..."

    if command -v aria2c &>/dev/null; then
        echo "  Using aria2c (16 connections, much faster)"
        # Remove stale aria2 control file from previous partial downloads
        rm -f "${dest}.aria2"
        aria2c --continue=true \
            --max-connection-per-server=16 \
            --split=16 \
            --min-split-size=1M \
            --file-allocation=none \
            --summary-interval=10 \
            --console-log-level=warn \
            --dir="$(dirname "$dest")" \
            --out="$(basename "$dest")" \
            "$download_url" || {
            rm -f "$dest" "${dest}.aria2"
            echo "ERROR: Download failed."
            exit 1
        }
        rm -f "${dest}.aria2"
    else
        echo "  Using curl (single-connection). Install aria2 for faster downloads."
        curl --progress-bar --fail -L -o "$dest" "$download_url" || {
            rm -f "$dest"
            echo "ERROR: Download failed."
            exit 1
        }
    fi

    # Save ETag for future cache checks
    save_etag "$dest" "$download_url"

    echo "  Download complete: $(du -h "$dest" | cut -f1)"
    verify_iso_hash "$dest" "$filename"
}

# Download VirtIO ARM64 drivers ISO (minimal, ~7MB)
download_virtio_iso() {
    local dest="$1"
    if [[ -f "$dest" ]]; then
        echo "Using cached VirtIO ISO: $dest"
        return 0
    fi
    echo "Downloading VirtIO ARM64 drivers..."
    local virtio_url
    virtio_url="$(curl -sL "https://api.github.com/repos/${VIRTIO_REPO}/releases/latest" \
        | jq -r '.assets[] | select(.name | endswith(".iso")) | .browser_download_url')"
    if [[ -z "$virtio_url" ]]; then
        echo "ERROR: Could not resolve VirtIO drivers download URL."
        exit 1
    fi
    curl --progress-bar --fail -L -o "$dest" "$virtio_url"
    echo "  Done: $(du -h "$dest" | cut -f1)"
}

# Download UTM guest tools exe (extracted from their ISO).
# This includes VirtIO GPU display driver + SPICE agent for dynamic resolution
# and clipboard sharing.
download_utm_guest_tools() {
    local dest="$1"
    if [[ -f "$dest" ]]; then
        echo "Using cached UTM guest tools: $dest"
        return 0
    fi
    echo "Downloading UTM guest tools..."
    local iso="$WORK_DIR/utm-guest-tools.iso"
    curl --progress-bar --fail -L -o "$iso" "$UTM_GUEST_TOOLS_URL"

    # Extract the exe from the ISO
    local mount="$WORK_DIR/utm-gt-mount"
    mkdir -p "$mount"
    hdiutil attach -readonly -nobrowse -mountpoint "$mount" "$iso" >/dev/null 2>&1
    local exe
    exe="$(find "$mount" -maxdepth 1 -name 'utm-guest-tools-*.exe' -print -quit)"
    if [[ -z "$exe" ]]; then
        hdiutil detach "$mount" >/dev/null 2>&1 || true
        echo "ERROR: Could not find utm-guest-tools exe in ISO."
        exit 1
    fi
    cp "$exe" "$dest"
    hdiutil detach "$mount" >/dev/null 2>&1 || true
    rm -f "$iso"
    echo "  Done: $(du -h "$dest" | cut -f1)"
}

# Build the unattended installation ISO containing:
# - autounattend.xml (with username/password substituted)
# - firstlogin.ps1
# - VirtIO ARM64 drivers (extracted from virtio-win ISO)
# - SPICE guest tools installer
build_unattended_iso() {
    local virtio_iso="$1"
    local utm_guest_tools="$2"
    local output_iso="$3"

    echo "Building unattended installation ISO..."
    local staging="$WORK_DIR/unattended"
    chmod -R u+w "$staging" 2>/dev/null || true
    rm -rf "$staging"
    mkdir -p "$staging"

    # Copy and customize autounattend.xml
    sed \
        -e "s/__USERNAME__/$USERNAME/g" \
        -e "s/__PASSWORD__/$PASSWORD/g" \
        "$SCRIPT_DIR/config/windows/autounattend.xml" > "$staging/autounattend.xml"

    # Copy firstlogin script
    cp "$SCRIPT_DIR/config/windows/firstlogin.ps1" "$staging/"

    # Extract VirtIO drivers from ISO
    echo "  Extracting VirtIO drivers..."
    local virtio_mount="$WORK_DIR/virtio-mount"
    mkdir -p "$virtio_mount"
    hdiutil attach -readonly -nobrowse -mountpoint "$virtio_mount" "$virtio_iso" >/dev/null 2>&1

    # Copy driver directories that exist.
    # Use rsync to avoid preserving read-only permissions from the ISO mount.
    for driver in viostor NetKVM Balloon vioinput vioser viogpudo viofs; do
        if [[ -d "$virtio_mount/$driver" ]]; then
            rsync -a --chmod=u+w "$virtio_mount/$driver" "$staging/"
        fi
    done

    # Copy guest agent and certs if present
    for extra in guest-agent cert; do
        if [[ -d "$virtio_mount/$extra" ]]; then
            rsync -a --chmod=u+w "$virtio_mount/$extra" "$staging/"
        fi
    done

    hdiutil detach "$virtio_mount" >/dev/null 2>&1 || true

    # Copy UTM guest tools (VirtIO drivers + SPICE agent for resolution + clipboard)
    cp "$utm_guest_tools" "$staging/utm-guest-tools.exe"

    # Build ISO -- no bootloader or startup.nsh needed. The Windows install ISO
    # boots natively via UEFI, and Windows Setup automatically discovers
    # autounattend.xml on any attached drive. This ISO is purely a data payload
    # with the answer file, drivers, and guest tools.

    # Build ISO using hdiutil (built into macOS, no extra packages needed)
    rm -f "$output_iso"
    hdiutil makehybrid -iso -joliet -o "$output_iso" "$staging/" >/dev/null

    echo "  Unattended ISO: $(du -h "$output_iso" | cut -f1)"
    rm -rf "$staging"
}

# Create UTM VM via AppleScript
create_utm_vm() {
    local win_iso="$1"
    local unattended_iso="$2"

    echo "Creating UTM VM '$VM_NAME'..."

    # Delete existing VM if present
    local vm_exists
    vm_exists=$(osascript -e 'tell application "UTM" to get name of every virtual machine' 2>/dev/null \
        | tr ',' '\n' | sed 's/^ //' | grep -cx "$VM_NAME" || true)

    if [[ "$vm_exists" -gt 0 ]]; then
        echo "  Deleting existing VM '$VM_NAME'..."
        osascript -e "tell application \"UTM\" to delete virtual machine named \"$VM_NAME\""
        sleep 2
    fi

    # Create empty sparse disk image (raw format, zero actual disk usage).
    # UTM converts to qcow2 internally on import.
    local tmp_disk="/tmp/${VM_NAME}-disk.raw"
    rm -f "$tmp_disk"
    truncate -s "${DISK_GB}G" "$tmp_disk"

    # Determine hypervisor setting
    local hypervisor="true"
    if $EMULATE; then
        hypervisor="false"
    fi

    osascript - "$VM_NAME" "$win_iso" "$unattended_iso" "$tmp_disk" "$MEMORY_MB" "$CPU_CORES" "$hypervisor" <<'APPLESCRIPT'
on run argv
    set vmName to item 1 of argv
    set winISO to POSIX file (item 2 of argv)
    set unattendedISO to POSIX file (item 3 of argv)
    set diskImg to POSIX file (item 4 of argv)
    set vmMemory to (item 5 of argv) as integer
    set vmCores to (item 6 of argv) as integer
    set useHypervisor to (item 7 of argv) = "true"

    tell application "UTM"
        -- Configuration matches UTM's Windows 11 wizard template.
        -- virtio-ramfb-gl renders UEFI firmware output (unlike virtio-gpu-gl-pci).
        -- NVMe disk, TPM device, and Secure Boot UEFI are required by Windows 11.
        -- Drive order: Windows ISO (bootindex 0), unattended ISO, NVMe disk.
        set vm to make new virtual machine with properties {backend:qemu, configuration:{name:vmName, architecture:"aarch64", hypervisor:useHypervisor, uefi:true, memory:vmMemory, cpu cores:vmCores, drives:{{source:winISO, removable:true}, {source:unattendedISO, removable:true}, {source:diskImg}}, displays:{{hardware:"virtio-ramfb-gl"}}, network interfaces:{{hardware:"virtio-net-pci"}}}}
    end tell
end run
APPLESCRIPT

    # Clean up temp disk (UTM already imported it)
    rm -f "$tmp_disk"

    echo ""
    echo "VM '$VM_NAME' created in UTM."
    echo ""
    echo "To install Windows:"
    echo "  1. Open UTM and start the VM"
    echo "  2. When prompted, press any key to boot from CD"
    echo "     (startup.nsh should handle this automatically)"
    echo "  3. Windows will install (~20-30 min)"
    echo "  4. After install completes, eject ISOs in UTM settings"
    echo ""
    echo "Login: $USERNAME / $PASSWORD"
}

main() {
    parse_args "$@"

    # Handle --clean: remove cached downloads and exit
    if $CLEAN; then
        echo "Cleaning cached downloads in $WORK_DIR..."
        local size
        size="$(du -sh "$WORK_DIR" 2>/dev/null | cut -f1)" || size="0B"
        rm -rf "$WORK_DIR"
        echo "  Freed $size from $WORK_DIR"
        exit 0
    fi

    echo "=== Windows 11 ARM64 UTM VM Builder ==="
    echo "  VM Name:  $VM_NAME"
    echo "  User:     $USERNAME"
    echo "  Disk:     ${DISK_GB}GB"
    echo "  Memory:   ${MEMORY_MB}MB"
    echo "  Cores:    $CPU_CORES"
    echo "  Emulate:  $EMULATE"
    echo ""

    # Check dependencies
    for cmd in curl jq osascript hdiutil; do
        if ! command -v "$cmd" &>/dev/null; then
            echo "ERROR: Required command '$cmd' not found."
            exit 1
        fi
    done

    mkdir -p "$WORK_DIR"

    # Step 1: Get Windows ISO
    local win_iso
    if [[ -n "$ISO_PATH" ]]; then
        win_iso="$ISO_PATH"
        if [[ ! -f "$win_iso" ]]; then
            echo "ERROR: ISO not found: $win_iso"
            exit 1
        fi
        echo "Using provided ISO: $win_iso"
    else
        win_iso="$WORK_DIR/windows11-arm64.iso"
        download_windows_iso "$win_iso"
    fi

    # Step 2: Download VirtIO drivers
    local virtio_iso="$WORK_DIR/virtio-win-arm64.iso"
    download_virtio_iso "$virtio_iso"

    # Step 3: Download UTM guest tools (display driver + SPICE agent)
    local utm_guest_tools="$WORK_DIR/utm-guest-tools.exe"
    download_utm_guest_tools "$utm_guest_tools"

    # Step 4: Build unattended ISO
    local unattended_iso="$WORK_DIR/unattended.iso"
    build_unattended_iso "$virtio_iso" "$utm_guest_tools" "$unattended_iso"

    # Step 6: Create UTM VM
    create_utm_vm "$win_iso" "$unattended_iso"

    # Clean up staging dir (downloaded ISOs kept in WORK_DIR for ETag caching)
    chmod -R u+w "$WORK_DIR/unattended" 2>/dev/null || true
    rm -rf "$WORK_DIR/unattended" "$WORK_DIR/iso-headers.txt" "$WORK_DIR/etag-headers.txt"
}

main "$@"
