#!/usr/bin/env bash
set -euo pipefail

# windows-test.sh -- Clone a template VM for disposable testing.
#
# UTM clones use APFS copy-on-write, so cloning is instant (~0.25s)
# regardless of disk image size. Writes in the clone create new blocks;
# the template stays pristine.
#
# The hostname is always set (unique names prevent mDNS/SMB conflicts
# when running multiple VMs). With --name, the hostname is derived from
# it. Without --name, a random word pair is chosen from /usr/share/dict/words
# (e.g. "swift-fox", "bold-arch"). Hostname setting adds ~60s for a reboot.
#
# Usage:
#   windows-test.sh                                # random hostname, clone + boot
#   windows-test.sh --name forepaw                 # hostname FOREPAW, UTM windows-forepaw-timestamp
#   windows-test.sh --name forepaw --no-stamp      # windows-forepaw (no timestamp)
#   windows-test.sh --source forepaw-base          # clone from forepaw-base
#   windows-test.sh --source forepaw-base --name test-foo
#   windows-test.sh --no-rename                    # skip hostname (no reboot)
#   windows-test.sh cleanup                        # stop + delete all clones
#   windows-test.sh cleanup forepaw                # only delete windows-forepaw*
#   windows-test.sh cleanup --dry-run              # show what would be deleted
#
# The source VM must be in stopped state. Defaults to "windows-11".

TEMPLATE="windows-11"
STAMP=true
CLONE_NAME=""
SOURCE=""
HOSTNAME=""
RENAME=true
VM_USER="${WINRUN_USER:-user}"
VM_SUBNET="${VM_SUBNET:-192.168.64}"

# SSH options matching winrun.sh -- VM rebuilds cause host key churn,
# so accept changed keys and don't pollute known_hosts.
ssh_common_opts=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o IdentitiesOnly=yes -i "$HOME/.ssh/vm")

ssh_probe() {
    # SSH probe with short timeout and batch mode (for IP discovery / readiness checks)
    ssh "${ssh_common_opts[@]}" -o BatchMode=yes -o ConnectTimeout="${1:-3}" "${2:-}" "${3:-echo ok}" 2>/dev/null
}

# Parse flags before the original arg parsing
TEMP_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --name)     CLONE_NAME="$2"; shift 2 ;;
        --no-stamp) STAMP=false; shift ;;
        --source)   SOURCE="$2"; shift 2 ;;
        --no-rename) RENAME=false; shift ;;
        *)          TEMP_ARGS+=("$1"); shift ;;
    esac
done
set -- "${TEMP_ARGS[@]}"

get_vm_uuid() {
    local name="$1"
    utmctl list | awk -v n="^${name}$" '$3 ~ n { print $1; exit }'
}

get_vm_status() {
    local name="$1"
    utmctl list | awk -v n="^${name}$" '$3 ~ n { print $2; exit }'
}

get_vm_ip() {
    local name="$1"
    utmctl ip-address "$name" 2>/dev/null | head -1 || true
}

scan_vm_ip() {
    # Parallel SSH scan of vmnet subnet.
    # utmctl needs qemu-ga which is often not running on clones.
    # Only call this once -- it spawns ~250 SSH connections.
    local found
    found=$(for i in $(seq 2 254); do
        ssh "${ssh_common_opts[@]}" -o BatchMode=yes -o ConnectTimeout=1 \
            -o ControlMaster=no -S none \
            "${VM_USER}@${VM_SUBNET}.$i" "echo ${VM_SUBNET}.$i" 2>/dev/null &
    done | head -1 | tr -d '\r')
    wait 2>/dev/null
    echo "$found"
}

ssh_ready() {
    local ip="$1"
    ssh_probe 3 "${VM_USER}@${ip}" &>/dev/null
}

pick_random_hostname() {
    # Pick two short lowercase words from the system dictionary.
    # Result like "swift-fox" -- memorable, unique, under 15 chars.
    local words
    words=$(grep -E '^[a-z]{3,6}$' /usr/share/dict/words | shuf -n 2)
    local w1 w2
    w1=$(echo "$words" | head -1)
    w2=$(echo "$words" | tail -1)
    echo "${w1}-${w2}"
}

set_hostname() {
    local ip="$1"
    local vm_name="$2"
    local hostname="$3"

    echo "Setting hostname to '$hostname' (requires reboot)..."
    ssh "${ssh_common_opts[@]}" -o BatchMode=yes -o ConnectTimeout=5 \
        "${VM_USER}@${ip}" \
        "powershell -Command \"Rename-Computer -NewName $hostname -Force; Restart-Computer -Force\"" 2>/dev/null || true

    echo "Waiting for VM to reboot..."
    sleep 10
    local attempts=0
    local max_attempts=30  # 2.5 minutes
    local new_ip_from_scan=""
    while [[ $attempts -lt $max_attempts ]]; do
        attempts=$((attempts + 1))
        if [[ $attempts -le 15 ]]; then
            sleep 2
        else
            sleep 5
        fi
        local new_ip
        new_ip=$(get_vm_ip "$vm_name") || true
        if [[ -z "$new_ip" || "$new_ip" == "0.0.0.0" ]]; then
            # No guest agent -- scan once, reuse result
            if [[ -z "$new_ip_from_scan" ]]; then
                printf "  [%d/%d] no guest agent, scanning subnet...\n" "$attempts" "$max_attempts"
                new_ip_from_scan=$(scan_vm_ip) || true
            fi
            new_ip="$new_ip_from_scan"
        fi
        if [[ -n "$new_ip" && "$new_ip" != "0.0.0.0" ]]; then
            printf "  [%d/%d] trying %s\n" "$attempts" "$max_attempts" "$new_ip"
            if ssh_ready "$new_ip"; then
                echo "Rebooted. Hostname: $hostname.local, IP: $new_ip"
                echo "  SSH: ssh ${VM_USER}@${hostname}.local"
                echo "  winrun: WINRUN_HOST=${VM_USER}@${new_ip} winrun -i <script>"
                return 0
            fi
        else
            printf "  [%d/%d] no IP yet\n" "$attempts" "$max_attempts"
        fi
    done
    echo ""
    echo "WARNING: Hostname set but SSH not reachable after reboot."
    echo "  Try manually: ssh -i ~/.ssh/vm ${VM_USER}@${ip}"
}

clone() {
    local source_vm="${SOURCE:-$TEMPLATE}"

    # Build clone name and determine hostname
    local suffix hostname_word
    if [[ -z "$CLONE_NAME" ]]; then
        # No --name: pick random hostname, use it in UTM name too
        hostname_word=$(pick_random_hostname)
        suffix="${hostname_word}-$(date +%Y%m%d-%H%M%S)"
    elif $STAMP; then
        hostname_word="$CLONE_NAME"
        suffix="${CLONE_NAME}-$(date +%Y%m%d-%H%M%S)"
    else
        hostname_word="$CLONE_NAME"
        suffix="$CLONE_NAME"
    fi
    local clone_name
    if [[ -n "$SOURCE" ]]; then
        local source_prefix
        source_prefix=${SOURCE#windows-}
        clone_name="windows-${source_prefix}-${suffix}"
    else
        clone_name="windows-${suffix}"
    fi

    if $RENAME; then
        HOSTNAME=$(echo "$hostname_word" | tr '[:lower:]' '[:upper:]' | tr -d '-')
        if [[ ${#HOSTNAME} -gt 15 ]]; then
            echo "WARNING: Hostname '$HOSTNAME' exceeds 15 chars (NetBIOS limit)."
            echo "  Windows will truncate it. Consider a shorter --name."
        fi
    fi

    local template_uuid
    template_uuid=$(get_vm_uuid "$source_vm")
    if [[ -z "$template_uuid" ]]; then
        echo "ERROR: Source VM '$source_vm' not found. Run 'mise nwu' first."
        exit 1
    fi

    local template_status
    template_status=$(get_vm_status "$source_vm")
    if [[ "$template_status" != "stopped" ]]; then
        echo "ERROR: Source VM '$source_vm' is $template_status. Stop it before cloning."
        exit 1
    fi

    # Check if a clone with this name already exists
    local existing_uuid
    existing_uuid=$(get_vm_uuid "$clone_name")
    if [[ -n "$existing_uuid" ]]; then
        echo "VM '$clone_name' already exists (UUID: $existing_uuid). Cleaning up..."
        utmctl stop "$existing_uuid" 2>/dev/null || true
        sleep 1
        utmctl delete "$existing_uuid"
        sleep 1
    fi

    echo "Cloning '$source_vm' → '$clone_name'..."
    utmctl clone "$template_uuid" --name "$clone_name"
    local clone_uuid
    clone_uuid=$(get_vm_uuid "$clone_name")
    echo "Cloned. UUID: $clone_uuid"

    # Randomize MAC address (UTM clone copies it verbatim from template).
    # Use PlistBuddy to modify in-place -- avoids jq/plutil roundtrip breakage.
    local clone_config="$HOME/Library/Containers/com.utmapp.UTM/Data/Documents/${clone_name}.utm/config.plist"
    if [[ -f "$clone_config" ]]; then
        local new_mac
        new_mac=$(printf '%02X' $((0x02 | (RANDOM % 256) & 0xFC)); for _ in $(seq 5); do printf ':%02X' $((RANDOM % 256)); done; echo)
        /usr/libexec/PlistBuddy -c "Set :Network:0:MacAddress $new_mac" "$clone_config" 2>/dev/null && \
            echo "MAC randomized: $new_mac" || \
            echo "WARNING: Could not randomize MAC (PlistBuddy failed)"
    fi

    echo "Starting '$clone_name'..."
    utmctl start "$clone_name"

    echo "Waiting for VM to boot and get an IP..."
    echo "  (Windows takes ~30-60s to boot, then SSH needs another ~10s to start)"
    local ip=""
    local ip_from_scan=""
    local attempts=0
    local max_attempts=60  # 5 minutes
    while [[ $attempts -lt $max_attempts ]]; do
        attempts=$((attempts + 1))
        # Fast poll (2s) for first 15 attempts, then 5s
        if [[ $attempts -le 15 ]]; then
            sleep 2
        else
            sleep 5
        fi
        # Try guest agent first
        ip=$(get_vm_ip "$clone_name") || true
        if [[ -n "$ip" && "$ip" != "0.0.0.0" ]]; then
            printf "  [%d/%d] guest agent: %s\n" "$attempts" "$max_attempts" "$ip"
        else
            # No guest agent -- scan subnet once, then reuse the result
            if [[ -z "$ip_from_scan" ]]; then
                printf "  [%d/%d] no guest agent, scanning subnet...\n" "$attempts" "$max_attempts"
                ip_from_scan=$(scan_vm_ip) || true
                if [[ -n "$ip_from_scan" ]]; then
                    printf "  [%d/%d] scan found: %s\n" "$attempts" "$max_attempts" "$ip_from_scan"
                else
                    printf "  [%d/%d] scan: no VMs responding yet\n" "$attempts" "$max_attempts"
                    continue
                fi
            fi
            ip="$ip_from_scan"
            printf "  [%d/%d] trying scan result: %s\n" "$attempts" "$max_attempts" "$ip"
        fi
        printf "  [%d/%d] connecting to %s...\n" "$attempts" "$max_attempts" "$ip"
        if ssh_probe 3 "${VM_USER}@${ip}" &>/dev/null; then
            echo ""
            echo "VM '$clone_name' is ready."
            echo "  IP:  $ip"
            echo "  SSH: WINRUN_HOST=${VM_USER}@${ip} winrun -i <script>"

            # Set hostname (requires reboot, ~60s)
            if $RENAME && [[ -n "$HOSTNAME" ]]; then
                set_hostname "$ip" "$clone_name" "$HOSTNAME"
            else
                echo ""
                echo "When done, clean up: $0 cleanup"
            fi

            return 0
        fi
    done

    echo ""
    echo "WARNING: VM started but SSH not reachable after 5 minutes."
    echo "  VM may still be booting. Try manually:"
    echo "  utmctl ip-address '$clone_name'"
    echo "  ssh -i ~/.ssh/vm ${VM_USER}@<ip>"
    echo ""
    echo "Clean up when done: $0 cleanup"
}

cleanup() {
    local dry_run=false
    local filter=""
    for arg in "$@"; do
        case "$arg" in
            --dry-run|-n) dry_run=true ;;
            *) filter="$arg" ;;
        esac
    done

    # Build list of VMs to delete. Exclude the template and any --source base VMs.
    # Default: all windows-* VMs except the template ($TEMPLATE).
    # With filter: windows-*FILTER* (still excludes template).
    local pattern
    if [[ -n "$filter" ]]; then
        pattern="windows-.*${filter}"
    else
        pattern='windows-'
    fi

    local candidates=()
    while IFS= read -r line; do
        local name
        name=$(echo "$line" | awk '{print $3}')
        # Skip the template
        [[ "$name" == "$TEMPLATE" ]] && continue
        # Match pattern
        [[ "$name" =~ $pattern ]] || continue
        candidates+=("$line")
    done < <(utmctl list)

    if [[ ${#candidates[@]} -eq 0 ]]; then
        echo "No clones found to clean up."
        echo ""
        echo "All VMs:"
        utmctl list | awk '{printf "  %-40s %s\n", $3, $2}'
        return 0
    fi

    for line in "${candidates[@]}"; do
        local uuid name
        uuid=$(echo "$line" | awk '{print $1}')
        name=$(echo "$line" | awk '{print $3}')
        if $dry_run; then
            echo "Would delete: $name ($uuid)"
        else
            echo "Stopping '$name' ($uuid)..."
            utmctl stop "$uuid" 2>/dev/null || true
            sleep 1
            echo "Deleting '$name'..."
            utmctl delete "$uuid"
        fi
    done

    local found=${#candidates[@]}
    if $dry_run; then
        echo "Would delete $found clone(s). Run without --dry-run to confirm."
    else
        echo "Cleaned up $found clone(s)."
    fi
}

# Main
if [[ $# -eq 0 ]]; then
    clone
elif [[ "$1" == "cleanup" || "$1" == "--cleanup" ]]; then
    shift
    cleanup "$@"
else
    echo "Usage: $0 [--name NAME] [--no-stamp] [--source VM] [--no-rename] [cleanup [FILTER]]"
    echo "  (no args)          Clone template and wait for SSH"
    echo "  --name NAME        Clone with custom name (windows-NAME-timestamp)"
    echo "  --no-stamp         Omit timestamp from clone name"
    echo "  --source VM        Clone from VM instead of default '$TEMPLATE'"
    echo "  --no-rename        Skip hostname setting (no reboot)"
    echo "  cleanup [FILTER]   Stop and delete clones (optional name filter)"
    exit 1
fi
