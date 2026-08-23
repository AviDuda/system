# Lazygit configuration with delta and difftastic pagers
# Cycle between pagers with | in lazygit
{ pkgs-unstable, ... }:
{
  programs.lazygit = {
    enable = true;
    package = pkgs-unstable.lazygit;

    settings = {
      git = {
        diffRenderers = [
          # Delta: line-based diff with syntax highlighting
          {
            command = "delta --dark --paging=never --line-numbers";
          }
          # Difftastic: structural/syntax-aware diff
          {
            command = "difft --color=always";
            type = "extDiff";
          }
        ];
      };
    };
  };
}
