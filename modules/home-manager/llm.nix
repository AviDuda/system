# LLM agent configuration (Claude Code, OpenCode)
{
  config,
  lib,
  pkgs,
  ...
}:
let
  isDarwin = pkgs.stdenvNoCC.isDarwin;

  # Shared paths
  notesDir = "${config.home.homeDirectory}/notes/llm";
  opencodeConfigDir = "${config.xdg.configHome}/opencode";

  # Shared text (used in both Claude Code hooks and OpenCode plugin)
  noNotesReminder = "File naming: YYYY-MM-DD-NN-topic.md (NN = sequence number for the day)\nJournal after orientation, when stuck/surprised, when something clicks, and at session end.";

  journalReminder = "IMPORTANT: Do NOT write journal entries at session start. Only journal after doing actual work.\nGive a brief verbal summary of previous notes if relevant, then proceed with the user's task.\nJournal entries should capture learnings, decisions, and progress - not \"session started\" or orientation notes.";

  compactionReminder = "Capture: what you learned, decisions made, what is unfinished, what the next agent should know.\nThis is part of the work, not extra work.";

  journalSkipMessage = "Journal reading was skipped for this session (NO_JOURNAL=1 environment variable set).\n\nThis means you do not have context from previous sessions. The user intentionally started fresh.\n\nYou should still write journal notes at the end of this session - the skip only affects reading, not writing.";

  # Global instructions (shared between Claude Code and OpenCode)
  globalInstructions = builtins.replaceStrings [ "~/" ] [ "${config.home.homeDirectory}/" ] (
    builtins.readFile ../../config/llm/instructions.md
  );

  # ============================================================================
  # Claude Code
  # ============================================================================

  jq = "${pkgs.jq}/bin/jq";

  # Session start hook: reads recent journal notes and injects as context
  sessionStartScript = pkgs.writeShellScript "claude-session-start" ''
        set -euo pipefail

        # Allow skipping journal reading with NO_JOURNAL=1
        if [[ "''${NO_JOURNAL:-}" == "1" ]]; then
          ${jq} -n --arg msg "${journalSkipMessage}" '{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $msg } }'
          exit 0
        fi

        NOTES_DIR="${notesDir}"
        PROJECT_NAME=$(basename "$PWD")
        PROJECT_NOTES="$NOTES_DIR/$PROJECT_NAME"

        NO_NOTES_REMINDER="${noNotesReminder}"

        output_context() {
          ${jq} -n --arg ctx "$1" '{
            hookSpecificOutput: {
              hookEventName: "SessionStart",
              additionalContext: $ctx
            }
          }'
        }

        # Create directory if missing
        if [[ ! -d "$PROJECT_NOTES" ]]; then
          mkdir -p "$PROJECT_NOTES"
          output_context "No previous session notes for $PROJECT_NAME.
    Notes directory created: $PROJECT_NOTES/

    $NO_NOTES_REMINDER"
          exit 0
        fi

        # Find recent note files (last 3, sorted by name which includes date)
        RECENT_NOTES=$(find "$PROJECT_NOTES" -name "*.md" -type f | sort -r | head -3)

        # No notes yet
        if [[ -z "$RECENT_NOTES" ]]; then
          output_context "No previous session notes for $PROJECT_NAME.
    Notes directory: $PROJECT_NOTES/

    $NO_NOTES_REMINDER"
          exit 0
        fi

        # Build context from recent notes
        CONTEXT="Previous session notes for $PROJECT_NAME:"$'\n\n'
        for note in $RECENT_NOTES; do
          FILENAME=$(basename "$note")
          CONTENT=$(cat "$note")
          CONTEXT+="--- $FILENAME ---"$'\n'"$CONTENT"$'\n\n'
        done

        output_context "$CONTEXT"
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

  # Journal plugin for OpenCode - external file with placeholder substitution
  # Must be a real file (not symlink) so bun can resolve node_modules
  journalPluginContent =
    builtins.replaceStrings
      [ "__NOTES_DIR__" "__NO_NOTES_REMINDER__" "__JOURNAL_REMINDER__" "__COMPACTION_REMINDER__" "__JOURNAL_SKIP_MESSAGE__" ]
      [ notesDir noNotesReminder journalReminder compactionReminder journalSkipMessage ]
      (builtins.readFile ../../config/llm/opencode-journal-plugin.ts);

  journalPluginFile = pkgs.writeText "journal.ts" journalPluginContent;

in
{
  # ============================================================================
  # Shared
  # ============================================================================

  # Ensure notes directory exists
  home.file."notes/llm/.keep".text = "";

  # ============================================================================
  # Claude Code
  # ============================================================================

  home.file.".claude/CLAUDE.md".text = globalInstructions;

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
  xdg.configFile."opencode/AGENTS.md".text = globalInstructions;

  # Plugin must be a real file (not symlink) so bun can resolve node_modules
  # package.json is NOT managed by Nix - opencode needs it writable
  home.activation.opencodePlugin = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    plugin_target="${opencodeConfigDir}/plugins/journal.ts"
    plugin_source="${journalPluginFile}"

    $DRY_RUN_CMD mkdir -p "${opencodeConfigDir}/plugins"

    if [[ -f "$plugin_target" ]] && ! ${pkgs.diffutils}/bin/diff -q "$plugin_source" "$plugin_target" > /dev/null 2>&1; then
      echo "WARNING: opencode plugin differs from Nix-managed version"
      echo "  Target: $plugin_target"
      echo "  Source: $plugin_source"
      echo "Diff (existing vs new):"
      ${pkgs.diffutils}/bin/diff "$plugin_target" "$plugin_source" || true
      echo ""
      echo "Overwriting with Nix-managed version..."
    fi

    $DRY_RUN_CMD cp -f "$plugin_source" "$plugin_target"
    $DRY_RUN_CMD chmod 644 "$plugin_target"
  '';
}
