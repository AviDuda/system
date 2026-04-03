#!/usr/bin/env bash
set -euo pipefail

host="${1:?Usage: mise nbu -- <hostname> [variant]}"
variant="${2:-qemu-efi}"

# GC the builder before building -- with auto-GC disabled, old builds accumulate
echo "Collecting garbage on linux-builder..."
sudo ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o IdentitiesOnly=yes -i /etc/nix/builder_ed25519 -p 31022 \
    builder@localhost 'nix-collect-garbage' 2>/dev/null || true

echo "Building $variant image for $host..."
nix build ".#nixosConfigurations.$host.config.system.build.images.$variant" --print-build-logs

# Find the qcow2 image
image=$(find result/ -name '*.qcow2' -print -quit)
if [[ -z "$image" ]]; then
    echo "Error: No qcow2 image found in result/"
    exit 1
fi
echo "Image: $image ($(du -h "$image" | cut -f1))"

# Check if UTM VM already exists
vm_exists=$(osascript -e 'tell application "UTM" to get name of every virtual machine' 2>/dev/null | tr ',' '\n' | sed 's/^ //' | grep -cx "$host" || true)

if [[ "$vm_exists" -gt 0 ]]; then
    echo "Deleting existing UTM VM '$host'..."
    osascript -e "tell application \"UTM\" to delete virtual machine named \"$host\""
    sleep 2
fi

# AppleScript can't access /nix/store paths -- hardlink to /tmp instead
# (hardlink avoids copying 21GB; works because same APFS volume)
tmp_image="/tmp/${host}.qcow2"
rm -f "$tmp_image"
if ln "$(realpath "$image")" "$tmp_image" 2>/dev/null; then
    echo "Linked image to $tmp_image"
else
    echo "Copying image to $tmp_image (hardlink failed, this may take a moment)..."
    cp "$image" "$tmp_image"
fi
trap 'echo "Cleaning up $tmp_image..."; rm -f "$tmp_image"' EXIT

echo "Creating UTM VM '$host'..."
abs_image="$tmp_image"
osascript - "$host" "$abs_image" <<'APPLESCRIPT'
on run argv
    set vmName to item 1 of argv
    set imgPath to item 2 of argv
    set img to POSIX file imgPath
    tell application "UTM"
        -- serial port (ptty) and shared network are included by default
        make new virtual machine with properties {backend:qemu, configuration:{name:vmName, architecture:"aarch64", hypervisor:true, uefi:true, memory:8192, cpu cores:6, drives:{{source:img}}, displays:{{hardware:"virtio-gpu-gl-pci"}}}}
    end tell
end run
APPLESCRIPT

echo ""
echo "VM '$host' created in UTM. Open UTM to start it."

# Stop the linux-builder to free resources (~8GB RAM)
mise run nixos-builder-stop
