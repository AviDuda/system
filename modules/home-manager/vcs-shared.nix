# Shared VCS user identity for git.nix and jj.nix (name, email, signing key)
{ ... }:
let
  user = {
    name = "aviraccoon";
    email = "368677+aviraccoon@users.noreply.github.com";
    # SSH key used for commit signing via 1Password; registered as a GitHub signing key
    signingKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHwxJ/uQQtFgsmDDiUfMTDjlLl/aSihCeAuGukVKBVEA";
  };
in
{
  programs.git.settings.user = {
    name = user.name;
    email = user.email;
    signingkey = user.signingKey;
  };
  programs.jujutsu.settings.user = {
    name = user.name;
    email = user.email;
  };
  programs.jujutsu.settings.signing.key = user.signingKey;
}
