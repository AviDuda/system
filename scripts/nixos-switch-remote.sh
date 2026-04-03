#!/usr/bin/env bash
set -euo pipefail

host="${1:?Usage: mise nrs -- <hostname> [target]}"
target="${2:-${host}.local}"
ssh_target="avi@$target"
ssh_key="$HOME/.ssh/nixos-vm"
ssh_opts=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o IdentitiesOnly=yes -i "$ssh_key")

echo "Building NixOS config '$host'..."
toplevel=$(nix build ".#nixosConfigurations.$host.config.system.build.toplevel" --print-out-paths --print-build-logs)

echo "Copying closure to $target..."
# Use ssh:// (not ssh-ng://) to copy via the user's nix-store, bypassing daemon trust
NIX_SSHOPTS="${ssh_opts[*]}" nix copy --to "ssh://$ssh_target" "$toplevel"

echo "Activating on $target..."
ssh -tt "${ssh_opts[@]}" "$ssh_target" "sudo nix-env -p /nix/var/nix/profiles/system --set $toplevel && sudo $toplevel/bin/switch-to-configuration switch"

echo ""
echo "Done. Config '$host' applied to $target."
