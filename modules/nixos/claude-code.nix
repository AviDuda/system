# Claude Code system-level configuration (NixOS)
# Places managed-settings.json + managed-mcp.json in /etc/claude-code/
{ pkgs, config, ... }:
let
  claudeManaged = import ../claude-code/settings.nix { inherit pkgs config; };
in
{
  environment.etc."claude-code/managed-settings.json".source = claudeManaged.settings;
  environment.etc."claude-code/managed-mcp.json".source = claudeManaged.mcp;
}
