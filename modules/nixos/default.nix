# Shared NixOS configuration for all machines
{ ... }:
{
  imports = [
    ../common.nix
    ./core.nix
    ./graphical.nix
  ];
}
