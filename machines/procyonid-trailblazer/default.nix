# MacBook Pro M4 Pro, 48 GB RAM, 1 TB SSD, nanotexture
{ config, ... }: {
  imports = [
    ../../profiles/personal.nix
    ../../modules/darwin
  ];

  # Machine-specific settings
  networking.hostName = "procyonid-trailblazer";

  # Home-manager modules
  hm.imports = [
    ../../modules/home-manager
  ];
}
