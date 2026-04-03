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
#   --skip-download     Skip ISO download (use cached copy)

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
SKIP_DOWNLOAD=false

# URLs
# Resolved dynamically via GitHub API (version is in the filename)
VIRTIO_REPO="qemus/virtiso-arm"
UTM_GUEST_TOOLS_URL="https://getutm.app/downloads/utm-guest-tools-latest.iso"
# massgrave.dev maintains a markdown file with current direct Microsoft CDN links.
# We parse this at runtime to always get the latest build URL.
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
            --skip-download) SKIP_DOWNLOAD=true; shift ;;
            --help|-h)   usage 0 ;;
            *)           echo "Unknown option: $1"; usage 1 ;;
        esac
    done
}

# Download Windows 11 ARM64 ISO.
# Resolves the latest direct CDN link from massgrave.dev's maintained link list
# (parsed from their GitHub repo). These are genuine Microsoft-hosted files.
# Uses ETag caching to skip re-download if the cached ISO is current.
download_windows_iso() {
    local dest="$1"

    if [[ -f "$dest" ]] && $SKIP_DOWNLOAD; then
        echo "Using cached ISO: $dest (--skip-download)"
        return 0
    fi

    echo "Resolving Windows 11 ARM64 ISO download link..."
    local download_url
    download_url="$(curl -sL "$MASGRAVE_ARM_LINKS" \
        | sed -n '/Windows 11 Consumer 25H2/,/^<\/TabItem>/p' \
        | grep '| English ' \
        | grep -v 'United Kingdom' \
        | sed 's/.*(\(https:\/\/software-static[^)]*\)).*/\1/' \
        | head -1)"

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
    local etag_file="${dest}.etag"
    if [[ -f "$dest" && -f "$etag_file" ]]; then
        local cached_etag
        cached_etag="$(cat "$etag_file")"
        echo "  Checking if cached ISO is current..."
        local http_code
        http_code="$(curl -s -o /dev/null -w '%{http_code}' \
            -H "If-None-Match: $cached_etag" \
            --head -L "$download_url")"
        if [[ "$http_code" == "304" ]]; then
            echo "  Cached ISO is current (ETag match), skipping download."
            return 0
        fi
        echo "  Cached ISO is stale, re-downloading."
    fi

    echo "  Downloading (~7GB, this will take a while)..."
    # Download and capture response headers to extract ETag
    local header_file="$WORK_DIR/iso-headers.txt"
    curl --progress-bar --fail -L -D "$header_file" -o "$dest" "$download_url" || {
        rm -f "$dest" "$header_file"
        echo "ERROR: Download failed."
        exit 1
    }

    # Save ETag for future cache checks
    local new_etag
    new_etag="$(grep -i '^etag:' "$header_file" | tail -1 | sed 's/^[Ee][Tt][Aa][Gg]: *//; s/\r$//')"
    if [[ -n "$new_etag" ]]; then
        echo "$new_etag" > "$etag_file"
    fi
    rm -f "$header_file"

    echo "  Download complete: $(du -h "$dest" | cut -f1)"
}

# Download VirtIO ARM64 drivers ISO (minimal, ~7MB)
download_virtio_iso() {
    local dest="$1"
    if [[ -f "$dest" ]] && $SKIP_DOWNLOAD; then
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
    if [[ -f "$dest" ]] && $SKIP_DOWNLOAD; then
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

    # Add startup.nsh -- tells the UEFI shell to boot from the Windows ISO.
    # Without this, UEFI shows "Press any key to boot from CD" which times out
    # and drops to the shell. startup.nsh auto-executes after 1 second.
    printf '%s\n' 'FS0:\efi\boot\bootaa64.efi' > "$staging/startup.nsh"

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

    # Copy ISOs to /tmp -- AppleScript can't access arbitrary paths
    local tmp_win="/tmp/${VM_NAME}-install.iso"
    local tmp_unattended="/tmp/${VM_NAME}-unattended.iso"

    echo "  Copying ISOs to /tmp..."
    if ! ln -f "$win_iso" "$tmp_win" 2>/dev/null; then
        cp "$win_iso" "$tmp_win"
    fi
    cp "$unattended_iso" "$tmp_unattended"

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

    osascript - "$VM_NAME" "$tmp_win" "$tmp_unattended" "$tmp_disk" "$MEMORY_MB" "$CPU_CORES" "$hypervisor" <<'APPLESCRIPT'
on run argv
    set vmName to item 1 of argv
    set winISO to POSIX file (item 2 of argv)
    set unattendedISO to POSIX file (item 3 of argv)
    set diskImg to POSIX file (item 4 of argv)
    set vmMemory to (item 5 of argv) as integer
    set vmCores to (item 6 of argv) as integer
    set useHypervisor to (item 7 of argv) = "true"

    tell application "UTM"
        -- virtio-gpu-gl-pci gives proper dynamic resolution post-install.
        -- UEFI boot screen is invisible with this GPU but startup.nsh on the
        -- unattended ISO auto-boots Windows from the UEFI shell.
        set vm to make new virtual machine with properties {backend:qemu, configuration:{name:vmName, architecture:"aarch64", hypervisor:useHypervisor, uefi:true, memory:vmMemory, cpu cores:vmCores, drives:{{source:diskImg}, {source:winISO, removable:true}, {source:unattendedISO, removable:true}}, displays:{{hardware:"virtio-gpu-gl-pci"}}, network interfaces:{{hardware:"virtio-net-pci"}}}}
    end tell
end run
APPLESCRIPT

    # UTM's AppleScript imports disk images into the .utm bundle but only
    # references removable drives (ISOs) by path. Copy ISOs into the bundle
    # and update the config so they persist regardless of /tmp cleanup.
    local utm_bundle="$HOME/Library/Containers/com.utmapp.UTM/Data/Documents/${VM_NAME}.utm"
    local utm_data="$utm_bundle/Data"
    if [[ -d "$utm_data" ]]; then
        echo "  Copying ISOs into VM bundle..."
        cp "$tmp_win" "$utm_data/${VM_NAME}-install.iso"
        cp "$tmp_unattended" "$utm_data/${VM_NAME}-unattended.iso"

        # Update config.plist to reference the bundled ISOs by name
        local config="$utm_bundle/config.plist"
        plutil -convert json "$config" -o /tmp/utm-wincfg.json
        # Find CD drives (ImageType=CD) and assign ImageName values
        jq --arg iso1 "${VM_NAME}-install.iso" --arg iso2 "${VM_NAME}-unattended.iso" '
            .Drive |= [.[0]] + [.[1] + {ImageName: $iso1}] + [.[2] + {ImageName: $iso2}]
        ' /tmp/utm-wincfg.json > /tmp/utm-wincfg-fixed.json
        plutil -convert xml1 /tmp/utm-wincfg-fixed.json -o "$config"
        rm -f /tmp/utm-wincfg.json /tmp/utm-wincfg-fixed.json

        # Clean up /tmp copies
        rm -f "$tmp_win" "$tmp_unattended"
    fi

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
    rm -rf "$WORK_DIR/unattended" "$WORK_DIR/iso-headers.txt"
}

main "$@"
