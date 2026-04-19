# Claude Code system-level configuration (macOS)
# Places managed-settings.json + managed-mcp.json in /Library/Application Support/ClaudeCode/
{ pkgs, config, ... }:
let
  claudeManaged = import ../claude-code/settings.nix { inherit pkgs config; };
in
{
  system.activationScripts.postActivation.text = ''
    echo "Setting up Claude Code managed settings..."
    mkdir -p "/Library/Application Support/ClaudeCode"
    ln -sf ${claudeManaged.settings} "/Library/Application Support/ClaudeCode/managed-settings.json"
    ln -sf ${claudeManaged.mcp} "/Library/Application Support/ClaudeCode/managed-mcp.json"
  '';
}
