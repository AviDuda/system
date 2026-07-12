# Shared constants for LLM agent configuration (Claude Code, OpenCode, pi)
{ config, android-skills }:
let
  homeDir = config.home.homeDirectory;

  # Skills deployed to all LLM agents (Claude Code, OpenCode, pi).
  # Bundled skills auto-discovered from config/llm/skills/.
  # External skills point at other repos -- dangling symlink is fine if uncloned,
  # agents skip missing skills.
  skillsSrcDir = "${homeDir}/system/config/llm/skills";
  bundledSkills = map (name: {
    inherit name;
    source = "${skillsSrcDir}/${name}";
  }) (builtins.attrNames (builtins.readDir ../../config/llm/skills));
  externalSkills = [
    {
      name = "forepaw";
      source = "${homeDir}/dev/personal/forepaw/.agents/skills/forepaw";
    }
    # Android CLI skill, sourced from the upstream android/skills repo (flake
    # input, pinned in flake.lock; update via `nix flake update android-skills`).
    # Avoids `android init` / `android skills add`, which spray copies into every
    # detected agent dir and clash with these managed symlinks. Target is a store
    # path, so the symlink always resolves on every machine (no init needed).
    {
      name = "android-cli";
      source = "${android-skills}/devtools/android-cli";
    }
  ];
in
{
  notesDir = "${homeDir}/notes/llm";

  noNotesReminder = "File naming: YYYY-MM-DD-NN-topic.md (NN = sequence number for the day)\nJournal after orientation, when stuck/surprised, when something clicks, and at session end.";

  journalReminder = "IMPORTANT: Do NOT write journal entries at session start. Only journal after doing actual work.\nGive a brief verbal summary of previous notes if relevant, then proceed with the user's task.\nJournal entries should capture learnings, decisions, and progress - not \"session started\" or orientation notes.";

  compactionReminder = "Capture: what you learned, decisions made, what is unfinished, what the next agent should know.\nThis is part of the work, not extra work.";

  journalSkipMessage = "Journal reading was skipped for this session (NO_JOURNAL=1 environment variable set).\n\nThis means you do not have context from previous sessions. The user intentionally started fresh.\n\nYou should still write journal notes at the end of this session - the skip only affects reading, not writing.";

  vanillaMessage = "Running in vanilla mode (LLM_VANILLA=1). Custom instructions skipped.";

  # Global instructions with ~ resolved to home dir
  globalInstructions = builtins.replaceStrings [ "~/" ] [ "${homeDir}/" ] (
    builtins.readFile ../../config/llm/instructions.md
  );

  skills = bundledSkills ++ externalSkills;
}
