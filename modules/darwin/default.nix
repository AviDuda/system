# Shared darwin (macOS) configuration for all machines
{ ... }: {
  imports = [
    ../common.nix
    ./rosetta.nix
    ./brew.nix
    ./core.nix
    ./preferences.nix
  ];
}
