# Claude Code managed settings - shared definition
# Used by darwin and nixos modules for platform-specific placement
#
# Managed settings have highest precedence and cannot be overridden by user settings
# See: https://docs.anthropic.com/en/docs/claude-code/settings
{ pkgs }:
let
  # Hook scripts path (scripts installed via home-manager llm.nix)
  hookScriptsPath = "~/.claude/hooks";

  settings = {
    # Disable auto-memory, using journal context instead
    autoMemoryEnabled = false;

    hooks = {
      # Runs at session start - injects journal context split across hooks
      # to stay under the 10K char per-hook output limit
      SessionStart = builtins.map (part: {
        hooks = [
          {
            type = "command";
            command = "${hookScriptsPath}/session-start.sh ${part}";
          }
        ];
      }) [
        "instructions"
        "metadata"
        "journal:0"
        "journal:1"
        "journal:2"
      ];
      # Runs before context compaction - reminder to journal
      PreCompact = [
        {
          hooks = [
            {
              type = "command";
              command = "${hookScriptsPath}/pre-compact.sh";
            }
          ];
        }
      ];
      # Runs when subagent spawns - tells it not to journal
      SubagentStart = [
        {
          hooks = [
            {
              type = "command";
              command = "${hookScriptsPath}/subagent-start.sh";
            }
          ];
        }
      ];
    };
  };
in
pkgs.writeText "claude-managed-settings.json" (builtins.toJSON settings)
