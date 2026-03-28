# Shared constants for LLM agent configuration (Claude Code, OpenCode, pi)
{ config }:
let
  homeDir = config.home.homeDirectory;
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

  # Escaped for shell embedding (single quotes escaped)
  globalInstructionsShell = builtins.replaceStrings [ "'" ] [ "'\"'\"'" ] (
    builtins.replaceStrings [ "~/" ] [ "${homeDir}/" ] (
      builtins.readFile ../../config/llm/instructions.md
    )
  );
}
