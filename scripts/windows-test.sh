#!/usr/bin/env bash
set -euo pipefail

# windows-test.sh -- Clone the Windows template VM for disposable testing.
#
# UTM clones use APFS copy-on-write, so cloning is instant (~0.25s)
# regardless of disk image size. Writes in the clone create new blocks;
# the template stays pristine.
#
# Usage:
#   mise windows-test          # clone + boot + wait for SSH
#   mise windows-test-cleanup  # stop + delete the clone
#
# The template VM must be named "windows-11" and be in stopped state.

TEMPLATE="windows-11"

get_vm_uuid() {
    local name="$1"
    utmctl list | awk -v n="^${name}$" '$3 ~ n { print $1; exit }'
}

get_vm_status() {
    local name="$1"
    utmctl list | awk -v n="^${name}$" '$3 ~ n { print $2; exit }'
}

get_vm_ip() {
    # Try mDNS first (UTM uses Apple's vmnet.framework)
    # Fall back to ARP table
    local name="$1"
    local ip
    ip=$(dns-sd -G v4 "${name}.local" 2>/dev/null | head -5 | tail -1 | awk '{print $NF}') || true
    if [[ -z "$ip" && "$ip" != "0.0.0.0" ]]; then
        ip=$(arp -a | grep -i "(${name}.local)" | head -1 | sed 's/.*(\([^)]*\)).*/\1/') || true
    fi
    echo "${ip:-}"
}

clone() {
    local suffix="${1:-test-$(date +%Y%m%d-%H%M%S)}"
    local clone_name="windows-${suffix}"

    local template_uuid
    template_uuid=$(get_vm_uuid "$TEMPLATE")
    if [[ -z "$template_uuid" ]]; then
        echo "ERROR: Template VM '$TEMPLATE' not found. Run 'mise nwu' first."
        exit 1
    fi

    local template_status
    template_status=$(get_vm_status "$TEMPLATE")
    if [[ "$template_status" != "stopped" ]]; then
        echo "ERROR: Template VM '$TEMPLATE' is $template_status. Stop it before cloning."
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

    echo "Cloning '$TEMPLATE' → '$clone_name'..."
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
    local attempts=0
    local max_attempts=60  # 5 minutes
    while [[ $attempts -lt $max_attempts ]]; do
        sleep 5
        attempts=$((attempts + 1))
        # Refresh mDNS cache
        ip=$(get_vm_ip "$clone_name") || true
        if [[ -n "$ip" && "$ip" != "0.0.0.0" ]]; then
            # Try SSH connection
            if ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes \
                "avi@${ip}" "echo ok" &>/dev/null; then
                echo ""
                echo "VM '$clone_name' is ready."
                echo "  IP:  $ip"
                echo "  SSH: ssh avi@${ip}"
                echo ""
                echo "When done, clean up: mise windows-test-cleanup"
                return 0
            fi
        fi
        printf "  [%d/%d] waiting...\r" "$attempts" "$max_attempts"
    done

    echo ""
    echo "WARNING: VM started but SSH not reachable after 5 minutes."
    echo "  VM may still be booting. Try manually:"
    echo "  utmctl list   # check status"
    echo "  ssh avi@${clone_name}.local"
    echo ""
    echo "Clean up when done: mise windows-test-cleanup"
}

cleanup() {
    # Find and remove all clone VMs (match "windows-test-*" and "windows-session-*")
    local found=0
    while IFS= read -r line; do
        local uuid name
        uuid=$(echo "$line" | awk '{print $1}')
        name=$(echo "$line" | awk '{print $3}')
        echo "Stopping '$name' ($uuid)..."
        utmctl stop "$uuid" 2>/dev/null || true
        sleep 1
        echo "Deleting '$name'..."
        utmctl delete "$uuid"
        found=$((found + 1))
    done < <(utmctl list | grep -E 'windows-(test|session)-')

    # Also clean up "windows-11 2" if present (UTM's default clone name)
    while IFS= read -r line; do
        local uuid name
        uuid=$(echo "$line" | awk '{print $1}')
        name=$(echo "$line" | awk '{print $3}')
        echo "Stopping '$name' ($uuid)..."
        utmctl stop "$uuid" 2>/dev/null || true
        sleep 1
        echo "Deleting '$name'..."
        utmctl delete "$uuid"
        found=$((found + 1))
    done < <(utmctl list | grep -E '^.*windows-11 2$')

    if [[ $found -eq 0 ]]; then
        echo "No test clones found to clean up."
    else
        echo "Cleaned up $found clone(s)."
    fi
}

# Main
if [[ $# -eq 0 ]]; then
    clone
elif [[ "$1" == "cleanup" || "$1" == "--cleanup" ]]; then
    cleanup
elif [[ "$1" == "--name" && $# -ge 2 ]]; then
    clone "$2"
else
    echo "Usage: $0 [--name SUFFIX | cleanup]"
    echo "  (no args)    Clone template and wait for SSH"
    echo "  --name NAME  Clone with custom name (windows-NAME)"
    echo "  cleanup      Stop and delete all test clones"
    exit 1
fi
