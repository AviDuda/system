# LLM agent configuration (Claude Code, OpenCode)
{
  config,
  lib,
  pkgs,
  ...
}:
let
  isDarwin = pkgs.stdenvNoCC.isDarwin;

  # Shared LLM constants (used by Claude Code, OpenCode, pi)
  shared = import ./llm-shared.nix { inherit config; };
  inherit (shared)
    notesDir
    noNotesReminder
    journalReminder
    compactionReminder
    journalSkipMessage
    vanillaMessage
    globalInstructions
    ;

  # Shared journal config consumed by pi extension and OpenCode plugin at runtime.
  # Avoids __PLACEHOLDER__ substitution -- extensions read JSON directly.
  journalConfig = builtins.toJSON {
    inherit notesDir noNotesReminder journalReminder compactionReminder
      journalSkipMessage vanillaMessage globalInstructions;
  };

  opencodeConfigDir = "${config.xdg.configHome}/opencode";

  # ============================================================================
  # Claude Code
  # ============================================================================

  jq = "${pkgs.jq}/bin/jq";

  bun = "${pkgs.bun}/bin/bun";
  journalContextScript = "${config.home.homeDirectory}/system/config/llm/pi/extensions/shared/journal-context.ts";

  # Session start hook: calls shared journal-context builder
  # Env vars:
  #   LLM_VANILLA=1 - skip all custom context (truly vanilla experience)
  #   NO_JOURNAL=1  - skip journal reading only (fresh session, no prior context)
  sessionStartScript = pkgs.writeShellScript "claude-session-start" ''
    set -euo pipefail
    CONTEXT=$(${bun} "${journalContextScript}" "$PWD")
    ${jq} -n --arg ctx "$CONTEXT" '{
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: $ctx
      }
    }'
  '';

  # Subagent start hook: tells subagents not to write journal entries
  subagentStartScript = pkgs.writeShellScript "claude-subagent-start" ''
    ${jq} -n '{
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
        additionalContext: "You are a subagent. Do not write journal entries - the parent agent handles journaling. You may read journal files if needed for your task."
      }
    }'
  '';

  # Pre-compact hook: reminds to journal before context is lost
  preCompactScript = pkgs.writeShellScript "claude-pre-compact" ''
    set -euo pipefail

    PROJECT_NAME=$(basename "$PWD")
    PROJECT_NOTES="${notesDir}/$PROJECT_NAME"

    ${jq} -n --arg dir "$PROJECT_NOTES" '{
      hookSpecificOutput: {
        hookEventName: "PreCompact",
        additionalContext: ("CONTEXT COMPACTION IMMINENT - Journal now!\n\nWrite session notes to: " + $dir + "/\n${compactionReminder}")
      }
    }'
  '';

  # Browser extension native messaging config (for Helium)
  nativeMessagingConfig = builtins.toJSON {
    name = "com.anthropic.claude_browser_extension";
    description = "Claude Browser Extension Native Host";
    path = "/Applications/Claude.app/Contents/Helpers/chrome-native-host";
    type = "stdio";
    allowed_origins = [
      "chrome-extension://dihbgbndebgnbjfmelmegjepbnkhlgni/"
      "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/"
      "chrome-extension://dngcpimnedloihjnnfngkgjoidhnaolf/"
    ];
  };

  heliumSupport = "Library/Application Support/net.imput.helium";
  chromeSupport = "Library/Application Support/Google/Chrome";
  claudeExtensionId = "fcoeoabgfenejglbffodgkkbkcdhcgfn";

  # ============================================================================
  # OpenCode
  # ============================================================================

  opencodeConfig = {
    "$schema" = "https://opencode.ai/config.json";
    # AGENTS.md is read automatically by precedence rules
    # AGENTS.local.md needs to be explicitly included for per-project private context
    instructions = [ "AGENTS.local.md" ];
    permission = {
      "*" = "ask";
      read = "allow";
      glob = "allow";
      grep = "allow";
      list = "allow";
      todoread = "allow";
      todowrite = "allow";
      read_journal = "allow"; # Custom tool from journal plugin
    };
    provider = {
      lmstudio = {
        npm = "@ai-sdk/openai-compatible";
        name = "LM Studio (local)";
        options = {
          baseURL = "http://127.0.0.1:1234/v1";
        };
        models = {
          "zai-org/glm-4.7-flash" = {
            name = "GLM 4.7 Flash (local)";
            variants = {
              high = {
                reasoningEffort = "high";
                textVerbosity = "low";
                reasoningSummary = "auto";
              };
              low = {
                reasoningEffort = "low";
                textVerbosity = "low";
                reasoningSummary = "auto";
              };
            };
          };
          "openai/gpt-oss-20b" = {
            name = "GPT OSS 20b (local)";
          };
        };
      };
    };
  };

  # OpenCode plugin source -- must be copied (not symlinked) so bun resolves
  # node_modules from ~/.config/opencode/ rather than the source tree.
  opencodePluginSrc = ../../config/llm/opencode-journal-plugin/index.ts;

in
{
  # ============================================================================
  # Shared
  # ============================================================================

  # Ensure notes directory exists
  home.file."notes/llm/.keep".text = "";

  # Shared journal config -- read at runtime by pi extension and OpenCode plugin
  xdg.configFile."llm/journal.json".text = journalConfig;

  # ============================================================================
  # Claude Code
  # ============================================================================

  # Empty - instructions injected via SessionStart hook for conditional loading
  home.file.".claude/CLAUDE.md".text = "";

  home.file.".claude/hooks/session-start.sh" = {
    source = sessionStartScript;
    executable = true;
  };

  home.file.".claude/hooks/pre-compact.sh" = {
    source = preCompactScript;
    executable = true;
  };

  home.file.".claude/hooks/subagent-start.sh" = {
    source = subagentStartScript;
    executable = true;
  };

  # Custom skills
  home.file.".claude/skills/avi-init-agents/SKILL.md".source =
    ../../config/llm/skills/avi-init-agents/SKILL.md;
  home.file.".claude/skills/avi-init-agents/checklist.md".source =
    ../../config/llm/skills/avi-init-agents/checklist.md;

  # Helium browser integration (macOS only)
  # Claude Code hardcodes Chrome's config path for extension detection.
  # Symlink extension from Helium to Chrome's path to trick detection.
  # See: https://github.com/anthropics/claude-code/issues/14391
  home.file."${heliumSupport}/NativeMessagingHosts/com.anthropic.claude_browser_extension.json" =
    lib.mkIf isDarwin
      {
        text = nativeMessagingConfig;
      };

  home.activation.claudeCodeHeliumSetup = lib.mkIf isDarwin (
    lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      HELIUM_EXT="$HOME/${heliumSupport}/Default/Extensions/${claudeExtensionId}"
      CHROME_EXT="$HOME/${chromeSupport}/Default/Extensions/${claudeExtensionId}"

      if [[ -d "$HELIUM_EXT" ]]; then
        mkdir -p "$(dirname "$CHROME_EXT")"
        if [[ ! -e "$CHROME_EXT" ]]; then
          $DRY_RUN_CMD ln -sf "$HELIUM_EXT" "$CHROME_EXT"
          $VERBOSE_ECHO "Created Claude extension symlink for Claude Code detection"
        fi
      fi
    ''
  );

  # ============================================================================
  # OpenCode
  # ============================================================================

  xdg.configFile."opencode/opencode.json".text = builtins.toJSON opencodeConfig;
  # Empty - instructions injected via plugin for conditional loading
  xdg.configFile."opencode/AGENTS.md".text = "";

  # OpenCode journal plugin -- copied (not symlinked) so bun resolves node_modules
  # from ~/.config/opencode/ rather than the source tree.
  # package.json is NOT managed by Nix - opencode needs it writable.
  home.activation.opencodePlugin = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    $DRY_RUN_CMD mkdir -p "${opencodeConfigDir}/plugins"

    plugin_target="${opencodeConfigDir}/plugins/journal.ts"
    # Substitute __HOME__ placeholder with actual home directory
    plugin_content=$(${pkgs.gnused}/bin/sed "s|__HOME__|${config.home.homeDirectory}|g" "${opencodePluginSrc}")
    if [[ -f "$plugin_target" ]] && [[ "$(cat "$plugin_target")" == "$plugin_content" ]]; then
      : # already up to date
    else
      $DRY_RUN_CMD printf '%s' "$plugin_content" > "$plugin_target"
      $DRY_RUN_CMD chmod 644 "$plugin_target"
      echo "opencode: updated journal.ts plugin"
    fi
  '';
}
