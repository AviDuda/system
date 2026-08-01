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
      # `trunk()` resolves to the repo's mainline (auto-set to main@origin at `jj git init`;
      # per-repo override possible). sync never moves bookmarks: `bookmark move` is
      # unconditional (no fast-forward check), so a divergent local bookmark would silently
      # orphan its commits. Bookmarkless push (`--change @-`) publishes the stack as a branch.
      # jj refuses to shadow builtins (warning + builtin wins) — when native `jj sync`
      # ships, this alias gets rejected with a warning on every command; delete it then.
      aliases = {
        pull = [
          "git"
          "fetch"
        ];
        sync = [
          "util"
          "exec"
          "--"
          "sh"
          "-c"
          "jj git fetch && jj rebase -d 'trunk()'"  # quotes: sh would eat the ()
        ];
        push = [
          "git"
          "push"
          "--change"
          "@-"
        ];
      };
      ui = {
        "default-command" = "log"; # bare `jj` shows the log
        paginate = "never"; # agents (and humans) never hang on the pager
        "show-cryptographic-signatures" = true;
      };
    };
  };
}
