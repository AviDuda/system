#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
    echo "Error: this task only runs on macOS"
    exit 1
fi

echo "Stopping linux-builder..."
sudo launchctl bootout system/org.nixos.linux-builder 2>/dev/null || true

echo "Removing old disk image..."
sudo rm -f /var/lib/linux-builder/nixos.qcow2

echo "Starting linux-builder..."
sudo launchctl bootstrap system /Library/LaunchDaemons/org.nixos.linux-builder.plist

echo "Waiting for builder to boot..."
for _ in $(seq 1 30); do
    if sudo ssh -o ConnectTimeout=2 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o IdentitiesOnly=yes -i /etc/nix/builder_ed25519 -p 31022 builder@localhost true 2>/dev/null; then
        echo "Builder is up."
        sudo ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
            -o IdentitiesOnly=yes -i /etc/nix/builder_ed25519 -p 31022 builder@localhost \
            'echo "Disk:"; df -h /; echo "Memory:"; free -h; echo "Nix GC settings:"; grep -E "min-free|max-free|auto-optimise" /etc/nix/nix.conf' 2>/dev/null
        exit 0
    fi
    sleep 2
done
echo "Error: builder did not come up in 60s"
exit 1
