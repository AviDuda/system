# oMLX: wired GPU memory limit
# nix-darwin has no built-in sysctl option — use activation script
# Uses extraActivation (the standard nix-darwin hook for user customization)
{ config, lib, ... }:
let
  cfg = config.services.omlx.gpuLimitMb;
in
{
  options.services.omlx.gpuLimitMb = lib.mkOption {
    type = lib.types.int;
    default = 40960;
    defaultText = lib.literalExpression "40960";
    description = ''
      Wired GPU memory limit in MB for oMLX.
      Default on 48 GB Mac is ~36 GB. The oMLX memory guard ceiling is 40 GB.
      Setting this higher prevents the memory guard from blocking prefill scheduling.
    '';
  };

  config.system.activationScripts.extraActivation.text = lib.mkAfter ''
    # oMLX: wired GPU memory limit
    TARGET_MB=${toString cfg}
    CURRENT_MB=$(sysctl -n iogpu.wired_limit_mb 2>/dev/null || echo 0)
    if [ "$CURRENT_MB" != "$TARGET_MB" ]; then
      echo "Setting iogpu.wired_limit_mb=${toString cfg} (was: $CURRENT_MB)"
      sudo sysctl -w iogpu.wired_limit_mb=${toString cfg}
    fi
  '';
}
