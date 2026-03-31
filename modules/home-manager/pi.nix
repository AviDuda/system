# Pi coding agent configuration
{
  config,
  lib,
  ...
}:
let
  piConfigDir = "${config.home.homeDirectory}/.pi/agent";

  # Source directory for pi extensions
  piExtSrcDir = "${config.home.homeDirectory}/system/config/llm/pi/extensions";

  # Auto-discover extension directories from source.
  # Dirs with index.ts are extensions; dirs without are shared modules.
  # All are symlinked live — edit + /reload works without nix-switch.
  allExtDirs = builtins.filter
    (name: (builtins.readDir ../../config/llm/pi/extensions).${name} == "directory")
    (builtins.attrNames (builtins.readDir ../../config/llm/pi/extensions));

in
{
  # Pi-specific agent instructions (global instructions injected separately via journal extension)
  home.file.".pi/agent/AGENTS.md".text = ''
    # Pi Agent Instructions

    ## File Editing

    - Use edit (targeted replacement) for existing files, not write (full rewrite). Rewrites lose subtle details and make reviews harder.
    - Only use write for genuinely new files or when the entire file content is changing.
  '';

  # Model roles config for sidecar LLM calls (used by permission gate explain, draft suggestion, etc.)
  # Per-model options: ref (provider/model), thinking (off|minimal|low|medium|high),
  # maxAttempts (retry with filtering, default 1 -- useful for weaker/local models).
  home.file.".pi/agent/roles.json".text = builtins.toJSON {
    explain = {
      models = [
        { ref = "anthropic/claude-haiku-4-5"; thinking = "off"; }
      ];
    };
    draft = {
      models = [
        { ref = "anthropic/claude-haiku-4-5"; thinking = "off"; }
      ];
    };
  };

  # Skills (shared with Claude Code)
  home.file.".pi/agent/skills/avi-init-agents/SKILL.md".source =
    ../../config/llm/skills/avi-init-agents/SKILL.md;
  home.file.".pi/agent/skills/avi-init-agents/checklist.md".source =
    ../../config/llm/skills/avi-init-agents/checklist.md;
  # Symlink to local forepaw checkout. Dangling if repo not cloned -- pi skips missing skills.
  home.file.".pi/agent/skills/forepaw/SKILL.md".source =
    config.lib.file.mkOutOfStoreSymlink
      "${config.home.homeDirectory}/dev/personal/forepaw/.agents/skills/forepaw/SKILL.md";

  # Extensions deployed to ~/.pi/agent/extensions/ for auto-discovery.
  # All are symlinked to live source — edit + /reload works without nix-switch.
  home.activation.piExtensions = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    $DRY_RUN_CMD mkdir -p "${piConfigDir}/extensions"

    # Extension + shared directories (auto-discovered, symlinked to live source)
    # Pi only loads dirs with index.ts as extensions; shared dirs are just for imports.
    ${lib.concatMapStringsSep "\n    " (name: ''
      ext_link="${piConfigDir}/extensions/${name}"
      ext_target="${piExtSrcDir}/${name}"
      if [[ -L "$ext_link" ]] && [[ "$(readlink "$ext_link")" == "$ext_target" ]]; then
        : # already correct
      else
        $DRY_RUN_CMD ln -sfn "$ext_target" "$ext_link"
        echo "pi: linked ${name} -> $ext_target"
      fi
    '') allExtDirs}
  '';
}
