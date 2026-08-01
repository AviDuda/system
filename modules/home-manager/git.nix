# Git configuration with 1Password SSH signing
{ pkgs-unstable, ... }:
{
  programs.git = {
    enable = true;
    package = pkgs-unstable.git;
    lfs.enable = true;

    settings = {
      init.defaultBranch = "main";
      pull.rebase = true;
      rebase.autoStash = true;
      push.autoSetupRemote = true;
      gpg.format = "ssh";
      "gpg.ssh".program = "/Applications/1Password.app/Contents/MacOS/op-ssh-sign";
      commit.gpgsign = true;
      merge.conflictStyle = "zdiff3";
      diff.algorithm = "histogram";
      rerere.enabled = true;
      rebase.autoSquash = true;
      rebase.updateRefs = true;
      fetch.prune = true;
      branch.sort = "-committerdate";
      help.autocorrect = "prompt";
      core.pager = "delta";
      interactive.diffFilter = "delta --color-only";
      delta = {
        dark = true;
        line-numbers = true;
        navigate = true; # n/N to jump between diff sections
        pager = "less --mouse";
      };
    };

    ignores = [
      ".DS_Store"
      ".jj/" # Jujutsu colocated repo state
      "AGENTS.local.md"
      "CLAUDE.local.md"
      "mise.local.toml"
      ".lsp/"
    ];
  };
}
