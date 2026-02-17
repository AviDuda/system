# Lazygit configuration with delta and difftastic pagers
# Cycle between pagers with | in lazygit
{ pkgs-unstable, ... }:
{
  programs.lazygit = {
    enable = true;
    package = pkgs-unstable.lazygit;

    settings = {
      git = {
        pagers = [
          # Delta: line-based diff with syntax highlighting
          {
            pager = "delta --dark --paging=never --line-numbers";
          }
          # Difftastic: structural/syntax-aware diff
          {
            externalDiffCommand = "difft --color=always";
          }
        ];
      };
    };
  };
}
