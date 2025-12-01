# Shell configuration: zsh with powerlevel10k, bash, keybindings, and mise
{ config
, lib
, pkgs
, ...
}: {
  # zoxide: smarter cd that learns your habits
  # Usage: z <partial-path> (e.g., "z proj" jumps to ~/dev/project-name)
  programs.zoxide = {
    enable = true;
    enableZshIntegration = true;
    enableBashIntegration = true;
  };

  programs.zsh = {
    enable = true;

    shellAliases = {
      vault = "cd \"$VAULT_PATH\""; # Jump to Obsidian vault
      nix-switch = "if [[ $TERM_PROGRAM == 'Apple_Terminal' ]]; then (cd ~/system && mise switch); else echo 'Opening Terminal.app to run switch...' && osascript -e 'tell app \"Terminal\" to do script \"cd ~/system && /etc/profiles/per-user/$USER/bin/mise switch\"'; fi"; # Build and activate system config (in Terminal.app to avoid Homebrew killing current terminal)
      nix-build = "(cd ~/system && mise build)"; # Build system config without activating
      nix-diff = "(cd ~/system && mise diff)"; # Show pending changes vs current system
    };

    history = {
      extended = true;
    };

    historySubstringSearch = {
      enable = true;
    };

    initContent = ''
      # p10k instant prompt
      local P10K_INSTANT_PROMPT="${config.xdg.cacheHome}/p10k-instant-prompt-''${(%):-%n}.zsh"
      [[ ! -r "$P10K_INSTANT_PROMPT" ]] || source "$P10K_INSTANT_PROMPT"

      # Preserve macOS UTF-8 handling
      setopt COMBINING_CHARS

      # macOS keybindings for function keys, arrows, etc.
      typeset -g -A key
      key[Home]="''${terminfo[khome]}"
      key[End]="''${terminfo[kend]}"
      key[Delete]="''${terminfo[kdch1]}"
      key[Up]="''${terminfo[kcuu1]}"
      key[Down]="''${terminfo[kcud1]}"
      key[Left]="''${terminfo[kcub1]}"
      key[Right]="''${terminfo[kcuf1]}"
      key[PageUp]="''${terminfo[kpp]}"
      key[PageDown]="''${terminfo[knp]}"

      [[ -n "''${key[Delete]}" ]] && bindkey "''${key[Delete]}" delete-char
      [[ -n "''${key[Home]}" ]] && bindkey "''${key[Home]}" beginning-of-line
      [[ -n "''${key[End]}" ]] && bindkey "''${key[End]}" end-of-line
      [[ -n "''${key[Up]}" ]] && bindkey "''${key[Up]}" up-line-or-search
      [[ -n "''${key[Down]}" ]] && bindkey "''${key[Down]}" down-line-or-search
      [[ -n "''${key[Left]}" ]] && bindkey "''${key[Left]}" backward-char
      [[ -n "''${key[Right]}" ]] && bindkey "''${key[Right]}" forward-char

      # mise activation (full path to avoid race condition during shell init)
      eval "$(/etc/profiles/per-user/$USER/bin/mise activate zsh)"

      ${lib.optionalString pkgs.stdenvNoCC.isDarwin ''
        # OrbStack CLI and completions
        source ~/.orbstack/shell/init.zsh 2>/dev/null || :

        # Check nixpkgs (stable + unstable) and homebrew versions
        # Usage: nixpkgs-check-version <package> [package2] ...
        nixpkgs-check-version() {
          for pkg in "$@"; do
            echo "$pkg:"
            echo "  stable:   $(nix eval --json nixpkgs#$pkg --apply 'p:{version=p.version;darwin=builtins.elem"aarch64-darwin"p.meta.platforms;}' 2>/dev/null || echo 'not found')"
            echo "  unstable: $(nix eval --json github:NixOS/nixpkgs/nixpkgs-unstable#$pkg --apply 'p:{version=p.version;darwin=builtins.elem"aarch64-darwin"p.meta.platforms;}' 2>/dev/null || echo 'not found')"
            brew_ver=$(brew info --json=v2 "$pkg" 2>/dev/null | jq -r '.formulae[0].versions.stable // empty')
            echo "  homebrew: ''${brew_ver:-not found}"
          done
        }
      ''}

      # Fix PATH order: nix paths should come before system paths
      # Must be at end of initContent, after mise and brew which prepend to PATH
      # See: https://github.com/NixOS/nix/issues/4169
      export PATH="/etc/profiles/per-user/$USER/bin:/run/current-system/sw/bin:/nix/var/nix/profiles/default/bin:$PATH"
    '';

    plugins = [
      {
        name = "powerlevel10k";
        src = pkgs.zsh-powerlevel10k;
        file = "share/zsh-powerlevel10k/powerlevel10k.zsh-theme";
      }
      {
        name = "powerlevel10k-config";
        src = lib.cleanSource ./zsh-plugins/p10k;
        file = "p10k.zsh";
      }
      {
        name = "friday";
        src = lib.cleanSource ./zsh-plugins/friday;
        file = "friday.sh";
      }
    ];
  };

  programs.bash = {
    enable = true;
    initExtra = ''
      # mise activation (full path to avoid race condition during shell init)
      eval "$(/etc/profiles/per-user/$USER/bin/mise activate bash)"
    '';
  };
}
