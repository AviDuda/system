# SPICE clipboard sharing for Wayland guests in QEMU/UTM VMs.
#
# The upstream spice-vdagent.desktop has X-systemd-skip=true, which prevents
# KDE Plasma 6 (and other systemd-managed DEs) from autostarting the per-user
# spice-vdagent process. Without the user agent, the daemon never opens the
# virtio-port and clipboard sharing doesn't work.
#
# Additionally, spice-vdagent only monitors the X11 clipboard. On Wayland,
# clipboard changes from native apps don't propagate to XWayland automatically.
# A bridge (wl-paste --watch | xclip) forwards Wayland clipboard to X11.
#
# Usage: import this module on any QEMU/UTM VM with Wayland and SPICE.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.spice-clipboard;
in
{
  options.services.spice-clipboard = {
    enable = lib.mkEnableOption "SPICE clipboard sharing with Wayland bridge";
  };

  config = lib.mkIf cfg.enable {
    # Ensure the system-level SPICE daemon and guest agent are present
    services.spice-vdagentd.enable = true;
    environment.systemPackages = [ pkgs.spice-vdagent ];

    # Per-user spice-vdagent: must run in the graphical session so logind
    # associates it with the correct seat (not an SSH session).
    hm.systemd.user.services.spice-vdagent = {
      Unit = {
        Description = "SPICE guest agent (clipboard, resolution)";
        After = [ "graphical-session.target" ];
        PartOf = [ "graphical-session.target" ];
      };
      Service = {
        ExecStart = "${pkgs.spice-vdagent}/bin/spice-vdagent -x";
        Restart = "on-failure";
        RestartSec = 5;
      };
      Install = {
        WantedBy = [ "graphical-session.target" ];
      };
    };

    # Bridge: Wayland clipboard -> X11 clipboard for spice-vdagent.
    # spice-vdagent only monitors X11 selections, but Wayland apps write to
    # the Wayland clipboard which doesn't automatically propagate to XWayland.
    #
    # On KDE: monitor Klipper via D-Bus signal, read with qdbus, write with xclip.
    # wl-paste --watch doesn't work on KDE (needs wlr-data-control protocol;
    # KDE uses ext-data-control which wl-clipboard 2.2.1 doesn't support yet).
    hm.systemd.user.services.wayland-clipboard-bridge = {
      Unit = {
        Description = "Wayland to X11 clipboard bridge for SPICE";
        After = [ "graphical-session.target" ];
        PartOf = [ "graphical-session.target" ];
      };
      Service = {
        ExecStart = toString (
          pkgs.writeShellScript "wayland-clipboard-bridge" ''
            # Wait for Klipper to be available on D-Bus
            for i in $(seq 1 30); do
              ${pkgs.dbus}/bin/dbus-send --session --print-reply \
                --dest=org.kde.klipper /klipper \
                org.kde.klipper.klipper.getClipboardContents >/dev/null 2>&1 && break
              sleep 1
            done

            # Monitor Klipper clipboard changes via D-Bus and forward to X11.
            # dbus-monitor emits multi-line output per signal; we trigger on the signal line.
            ${pkgs.dbus}/bin/dbus-monitor --session \
              "type='signal',interface='org.kde.klipper.klipper',member='clipboardHistoryUpdated'" |
            while read -r line; do
              case "$line" in
                *clipboardHistoryUpdated*)
                  # Read clipboard content via dbus-send, extract the string value
                  content=$(${pkgs.dbus}/bin/dbus-send --session --print-reply \
                    --dest=org.kde.klipper /klipper \
                    org.kde.klipper.klipper.getClipboardContents 2>/dev/null \
                    | sed -n 's/^   string "\(.*\)"$/\1/p')
                  if [ -n "$content" ]; then
                    printf '%s' "$content" | ${pkgs.xclip}/bin/xclip -selection clipboard 2>/dev/null
                  fi
                  ;;
              esac
            done
          ''
        );
        Environment = [
          "DISPLAY=:0"
        ];
        Restart = "on-failure";
        RestartSec = 5;
      };
      Install = {
        WantedBy = [ "graphical-session.target" ];
      };
    };
  };
}
