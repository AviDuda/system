# NixOS VM in UTM on Apple Silicon (aarch64)
{
  config,
  lib,
  pkgs,
  ...
}:
{
  imports = [
    ../../profiles/personal.nix
    ../../modules/nixos
    ./hardware.nix
  ];

  # Machine-specific settings
  networking.hostName = "phantom-tanuki";

  # Trust the user for remote deployments (nix copy from macOS host)
  nix.settings.trusted-users = [ "avi" ];

  # NOPASSWD sudo -- it's a local dev VM, no need for password prompts
  security.sudo.wheelNeedsPassword = false;

  # Both DEs: GNOME (Wayland-only) and KDE (X11 + Wayland sessions at login)
  desktop.environments = [
    "gnome"
    "kde"
  ];

  # User account (password set on first boot with `passwd`)
  users.users.${config.user.name} = {
    isNormalUser = true;
    initialPassword = "hunter2"; # change on first login with `passwd`
    extraGroups = [
      "wheel"
      "networkmanager"
    ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILeICDvqKcsiX7LH08C5biV5cenFsbAOm49dbNP74tUs nixos-vm-deploy"
    ];
  };

  # Accessibility testing tools for forepaw
  environment.systemPackages = with pkgs; [
    # AT-SPI2 and accessibility
    at-spi2-core # AT-SPI2 D-Bus accessibility
    accerciser # Interactive accessibility explorer

    # Development
    git
    vim
    swiftPackages.swift # Swift toolchain

    # Clipboard tools (for testing)
    wl-clipboard # wl-copy, wl-paste for Wayland
    xclip # X11 clipboard access (works with XWayland)

    # Useful in VM
    htop
    file
    unzip
  ];

  users.users.root.initialPassword = "hunter2";

  # Enable AT-SPI2 D-Bus accessibility service
  services.gnome.at-spi2-core.enable = true;

  # Disable screen locking and screensaver -- dev VM, no need
  # GNOME
  hm.dconf.settings."org/gnome/desktop/screensaver" = {
    lock-enabled = false;
    idle-activation-enabled = false;
  };
  hm.dconf.settings."org/gnome/desktop/session" = {
    idle-delay = 0;
  };
  # KDE
  hm.xdg.configFile."kscreenlockerrc".text = ''
    [Daemon]
    Autolock=false
    LockOnResume=false
  '';

  # Suppress IBus autostart -- pulled in by GNOME/KDE deps but not needed
  # (no CJK input), and spams a Wayland config warning on every login
  environment.etc."xdg/autostart/ibus-daemon.desktop".source = lib.mkForce (
    pkgs.writeText "ibus-daemon.desktop" ""
  );

  # VM guest services
  services.qemuGuest.enable = true;

  # SPICE clipboard sharing (vdagent user service + Wayland→X11 bridge)
  services.spice-clipboard.enable = true;

  # Enable SSH for easy access from host
  # mDNS so the VM is reachable as phantom-tanuki.local from the host
  services.avahi = {
    enable = true;
    nssmdns4 = true;
    publish = {
      enable = true;
      addresses = true;
    };
  };

  services.openssh = {
    enable = true;
    settings.PasswordAuthentication = true; # needed until SSH keys are deployed
  };

  # Home-manager modules
  hm.imports = [
    ../../modules/home-manager
  ];
}
