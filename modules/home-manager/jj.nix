# Jujutsu (jj) configuration with 1Password SSH signing
# User identity + signing key come from vcs-shared.nix.
{
  pkgs-unstable,
  lib,
  pkgs,
  ...
}:
{
  programs.jujutsu = {
    enable = true;
    package = pkgs-unstable.jujutsu;
    settings = {
      # signatures via 1Password, same program as git.nix. behavior="drop" +
      # git.sign-on-push = commits get signed in bulk when pushed (one 1Password
      # approval per push). "own" signs every auto-snapshot commit (prompt per
      # command after an edit) — snapshots are throwaway states, not worth signing.
      signing = lib.mkIf pkgs.stdenv.isDarwin {
        behavior = "drop";
        backend = "ssh";
        backends.ssh.program = "/Applications/1Password.app/Contents/MacOS/op-ssh-sign";
      };
      git = {
        "sign-on-push" = lib.mkIf pkgs.stdenv.isDarwin true;
        # Refuse to push machine-local changes (see the jj skill, "Keep machine-local changes out of pushes")
        "private-commits" = "description('LOCAL:*') | description('wip:*') | description('private:*')";
      };
      # Aliases: jj aliases run a single command; multi-step flows wrap `jj util exec`.
      # `jj sync` rebases work onto `trunk()` (the repo's mainline, auto-set at `jj git init`).
      # `jj push` advances the nearest ancestor bookmark to the stack and pushes it: in
      # direct-to-trunk repos that is main/master; in PR-based repos it is the feature
      # bookmark (create it first — the PR needs a branch anyway). advance is forward-only.
      # jj refuses to shadow builtins (warning + builtin wins) — when native `jj sync`
      # ships, this alias gets rejected with a warning on every command; delete it then.
      aliases = {
        fetch = [
          "git"
          "fetch"
        ];
        sync = [
          "util"
          "exec"
          "--"
          "sh"
          "-c"
          "jj git fetch && jj rebase -d 'trunk()'" # quotes: sh would eat the ()
        ];
        # "push": standalone script -- advance trunk to the top public commit,
        # re-sign+stamp the commits being pushed so GitHub shows the real author
        # dates (committer restored to author time), then push. Private commits
        # are never pushed. --dry-run reports without mutating.
        push = [
          "util"
          "exec"
          "--"
          "jj-push"
        ];
        # "reorder": standalone script -- stack ALL local commits (LOCAL/wip/private)
        # above the public ones, advance the trunk() bookmark to the topmost public
        # commit, and dry-run the push (no remote mutation). A plain
        # `jj git push --bookmark <bm>` after reviewing the dry-run completes it.
        # Implemented in the jj-reorder script, built to PATH from this config.
        reorder = [
          "util"
          "exec"
          "--"
          "jj-reorder"
        ];
        # "stamp": rewrite a commit's committer timestamp (set to its author time,
        # or to an explicit RFC 3339 time). Reused by reorder. See jj-stamp.
        stamp = [
          "util"
          "exec"
          "--"
          "jj-stamp"
        ];
      };
      # `jj bookmark advance` moves the nearest bookmark to the committed stack, not the
      # empty working-copy change (docs-recommended for squash workflows).
      revsets."bookmark-advance-to" = "@-";
      ui = {
        "default-command" = "log"; # bare `jj` shows the log
        paginate = "never"; # agents (and humans) never hang on the pager
        "show-cryptographic-signatures" = true;
      };
      # git-log-like default: the working copy plus the 30 newest commits in
      # its own ancestry. Full history (teammates' pushed work included, no
      # elision) without dumping the whole history or unrelated branches.
      # Works on any branch: `::@` is HEAD's ancestry, like `git log`.
      revsets."log" = "@ | latest(::@, 30)";
    };
  };
}
