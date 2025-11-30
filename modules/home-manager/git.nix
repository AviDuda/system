# Git configuration with 1Password SSH signing
{ pkgs, pkgs-unstable, ... }: {
  programs.git = {
    enable = true;
    package = pkgs-unstable.git;
    userName = "Avi Duda";
    userEmail = "368677+AviDuda@users.noreply.github.com";
    lfs.enable = true;
    extraConfig = {
      init.defaultBranch = "main";
      pull.rebase = true;
      rebase.autoStash = true;
      push.autoSetupRemote = true;

      # GPG signing with 1Password
      user.signingkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHwxJ/uQQtFgsmDDiUfMTDjlLl/aSihCeAuGukVKBVEA";
      gpg.format = "ssh";
      "gpg.ssh".program = "/Applications/1Password.app/Contents/MacOS/op-ssh-sign";
      commit.gpgsign = true;
    };

    ignores = [
      ".DS_Store"
    ];
  };
}
