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
      ui = {
        "default-command" = "log"; # bare `jj` shows the log
        paginate = "never"; # agents (and humans) never hang on the pager
        "show-cryptographic-signatures" = true;
      };
    };
  };
}
