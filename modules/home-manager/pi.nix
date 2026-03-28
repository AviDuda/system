# Pi coding agent configuration
{
  config,
  lib,
  pkgs,
  ...
}:
let
  piConfigDir = "${config.home.homeDirectory}/.pi/agent";

  # Shared LLM constants
  shared = import ./llm-shared.nix { inherit config; };
  inherit (shared)
    notesDir
    noNotesReminder
    journalReminder
    compactionReminder
    journalSkipMessage
    vanillaMessage
    globalInstructionsJS
    ;

  # ── Journal extension ──

  journalExtContent =
    builtins.replaceStrings
      [
        "__NOTES_DIR__"
        "__NO_NOTES_REMINDER__"
        "__JOURNAL_REMINDER__"
        "__COMPACTION_REMINDER__"
        "__JOURNAL_SKIP_MESSAGE__"
        "__VANILLA_MESSAGE__"
        "__GLOBAL_INSTRUCTIONS__"
      ]
      [
        notesDir
        noNotesReminder
        journalReminder
        compactionReminder
        journalSkipMessage
        vanillaMessage
        globalInstructionsJS
      ]
      (builtins.readFile ../../config/llm/pi/extensions/journal-extension.ts);

  journalExtRaw = pkgs.writeText "pi-journal-raw.ts" journalExtContent;
  journalExtFile = pkgs.runCommand "pi-journal.ts" {
    nativeBuildInputs = [ pkgs.esbuild ];
  } ''
    esbuild --bundle --external:@mariozechner/pi-coding-agent --platform=node --outfile=/dev/null ${journalExtRaw}
    cp ${journalExtRaw} $out
  '';

  # Source directory for pi extensions
  piExtSrcDir = "${config.home.homeDirectory}/system/config/llm/pi/extensions";

  # Auto-discover extension directories (contain index.ts) from source.
  # These are symlinked live — edit + /reload works without nix-switch.
  # Journal extension is excluded (needs Nix substitution, handled separately).
  extensionDirs = builtins.filter (name: builtins.pathExists (../../config/llm/pi/extensions + "/${name}/index.ts"))
    (builtins.attrNames (builtins.readDir ../../config/llm/pi/extensions));

in
{
  # Empty AGENTS.md - instructions injected via extension for conditional loading
  home.file.".pi/agent/AGENTS.md".text = "";

  # Skills (shared with Claude Code)
  home.file.".pi/agent/skills/avi-init-agents/SKILL.md".source =
    ../../config/llm/skills/avi-init-agents/SKILL.md;
  home.file.".pi/agent/skills/avi-init-agents/checklist.md".source =
    ../../config/llm/skills/avi-init-agents/checklist.md;

  # Extensions deployed to ~/.pi/agent/extensions/ for auto-discovery.
  #
  # Journal: Nix-substituted placeholders → must copy from store (real file, not symlink).
  # Permission gate: pure TS → symlink to live source. Edit + /reload works without nix-switch.
  home.activation.piExtensions = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    $DRY_RUN_CMD mkdir -p "${piConfigDir}/extensions"

    # Journal extension (copy from store)
    ext_target="${piConfigDir}/extensions/journal.ts"
    ext_source="${journalExtFile}"
    if [[ -f "$ext_target" ]] && ! ${pkgs.diffutils}/bin/diff -q "$ext_source" "$ext_target" > /dev/null 2>&1; then
      echo "pi: overwriting journal.ts with Nix-managed version"
    fi
    $DRY_RUN_CMD cp -f "$ext_source" "$ext_target"
    $DRY_RUN_CMD chmod 644 "$ext_target"

    # Extension directories (auto-discovered, symlinked to live source)
    ${lib.concatMapStringsSep "\n    " (name: ''
      ext_link="${piConfigDir}/extensions/${name}"
      ext_target="${piExtSrcDir}/${name}"
      if [[ -L "$ext_link" ]] && [[ "$(readlink "$ext_link")" == "$ext_target" ]]; then
        : # already correct
      else
        $DRY_RUN_CMD ln -sfn "$ext_target" "$ext_link"
        echo "pi: linked ${name} -> $ext_target"
      fi
    '') extensionDirs}
  '';
}
