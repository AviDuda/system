#!/usr/bin/env bash
# Ensure the linux-builder VM is running. Used by nrs/nbi/nbu tasks.
set -euo pipefail

# Quick check: can we SSH to the builder?
if sudo ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o IdentitiesOnly=yes -i /etc/nix/builder_ed25519 -p 31022 \
    -o ConnectTimeout=3 builder@localhost true 2>/dev/null; then
    exit 0
fi

echo "Linux builder not running, starting..."
sudo launchctl bootstrap system /Library/LaunchDaemons/org.nixos.linux-builder.plist 2>/dev/null || true

# Wait for it to be ready (up to 30s)
for _ in $(seq 1 30); do
    if sudo ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o IdentitiesOnly=yes -i /etc/nix/builder_ed25519 -p 31022 \
        -o ConnectTimeout=2 builder@localhost true 2>/dev/null; then
        echo "Linux builder ready."
        exit 0
    fi
    sleep 1
done

echo "ERROR: Linux builder failed to start within 30s" >&2
exit 1
