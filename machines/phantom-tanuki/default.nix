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
      "ydotool" # input injection via ydotool
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

    # Python + AT-SPI2 bindings for prototyping
    (python3.withPackages (
      ps: with ps; [
        pyatspi # AT-SPI2 Python bindings
        pygobject3 # GObject introspection (required by pyatspi)
        pytesseract # Tesseract OCR wrapper
      ]
    ))
    gobject-introspection # GI typelibs (Atspi-2.0, etc.)
    tesseract # OCR engine

    # Screen capture
    # spectacle is installed by KDE; also useful from scripts:
    grim # wlroots Wayland screenshotter (Sway/Hyprland, not KDE)
    imagemagick # import command, image conversion

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

  # ydotool: kernel-level input injection (works on any Wayland compositor)
  # Runs ydotoold daemon, creates ydotool group, sets up /dev/uinput access
  programs.ydotool.enable = true;

  # Disable screen locking and screensaver -- dev VM, no need
  # GNOME
  hm.dconf.settings."org/gnome/desktop/screensaver" = {
    lock-enabled = false;
    idle-activation-enabled = false;
  };
  hm.dconf.settings."org/gnome/desktop/session" = {
    idle-delay = 0;
  };

  # Enable AT-SPI2 accessibility tree for all GTK/Qt apps.
  # Without this, AT-SPI2 bus exists but IsEnabled=false and apps don't
  # expose their accessibility trees to automation tools.
  hm.dconf.settings."org/gnome/desktop/interface" = {
    toolkit-accessibility = true;
  };

  # Firefox: force accessibility tree (like Electron's AXManualAccessibility).
  # Without this, Firefox only builds the a11y tree when a screen reader is detected.
  environment.variables.MOZ_ENABLE_ACCESSIBILITY = "1";

  # GObject Introspection typelib path -- needed for pyatspi to find Atspi-2.0, DBus-1.0, etc.
  # NixOS puts typelibs in system-path but doesn't set GI_TYPELIB_PATH by default.
  environment.variables.GI_TYPELIB_PATH = "/run/current-system/sw/lib/girepository-1.0";
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
