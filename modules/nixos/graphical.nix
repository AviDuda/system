# Graphical desktop with choice of DE, networking, audio, printing
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.desktop;
in
{
  options.desktop = {
    environments = lib.mkOption {
      type = lib.types.listOf (
        lib.types.enum [
          "gnome"
          "kde"
        ]
      );
      default = [ "gnome" ];
      description = "Desktop environments to install (first is default session)";
    };
  };

  config = {
    # Enable networking
    networking.networkmanager.enable = true;

    # Set your time zone.
    time.timeZone = "Europe/Prague";

    # Enable the X11 windowing system (needed for XWayland and X11 sessions).
    services.xserver.enable = true;

    # Configure keymap in X11
    services.xserver.xkb = {
      layout = "us";
      variant = "";
    };

    # Display manager: SDDM when KDE is present (supports all session types),
    # GDM when GNOME-only
    services.displayManager.sddm.enable = builtins.elem "kde" cfg.environments;
    services.displayManager.gdm.enable =
      builtins.elem "gnome" cfg.environments && !builtins.elem "kde" cfg.environments;

    # Desktop environments
    services.desktopManager.gnome.enable = builtins.elem "gnome" cfg.environments;
    services.desktopManager.plasma6.enable = builtins.elem "kde" cfg.environments;

    # Enable CUPS to print documents.
    services.printing.enable = true;

    # Enable sound with pipewire.
    services.pulseaudio.enable = false;
    security.rtkit.enable = true;
    services.pipewire = {
      enable = true;
      alsa.enable = true;
      alsa.support32Bit = true;
      pulse.enable = true;
    };

    # When both DEs are installed, resolve conflicting defaults
    # KDE's ksshaskpass wins since SDDM is the display manager in that case
    programs.ssh.askPassword = lib.mkIf (
      builtins.elem "kde" cfg.environments && builtins.elem "gnome" cfg.environments
    ) (lib.mkForce "${lib.getExe' pkgs.kdePackages.ksshaskpass "ksshaskpass"}");

    # Install firefox.
    programs.firefox.enable = true;
  };
}
