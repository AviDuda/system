# direnv with nix-direnv for automatic Nix devShell loading
# Only activates when a .envrc file exists in a directory (e.g., "use flake")
# Works alongside mise - direnv for Nix shells, mise for tool versions
{ config, ... }: {
  programs.direnv = {
    enable = true;
    nix-direnv.enable = true;
  };
}
