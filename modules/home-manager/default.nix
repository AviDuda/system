# Home-manager configuration
{ config, lib, pkgs, pkgs-unstable, ... }:
{
  imports = [
    ./1password.nix
    ./direnv.nix
    ./git.nix
    ./shell.nix
  ];

  # WARNING: Do not change without reading Home Manager release notes first.
  # This helps avoid breakage when HM introduces backwards incompatible changes.
  # https://nix-community.github.io/home-manager/release-notes.xhtml
  home.stateVersion = "24.11";

  # Prefer Nix packages here over Homebrew (brew.nix) when possible
  # See docs/homebrew-vs-nixpkgs.md for details and version checking
  home.packages =
    # Stable packages
    (with pkgs; [
      devenv # Development environments
      nixpkgs-fmt # Nix code formatter
      nvd # Nix version diff tool
    ])
    ++
    # Stable packages (versions match homebrew)
    (with pkgs; [
      age # Encryption tool
      binwalk # Firmware analysis
      curl # HTTP client
      ffmpeg # Video processing
      gnupg # GPG encryption
      google-cloud-sdk # GCloud CLI
      mosh # Mobile shell
      nil # Nix language server
      rsync # File transfer
      speedtest-cli # Internet speed test
      wget # Downloader
    ])
    ++
    # Unstable packages (stable too outdated)
    (with pkgs-unstable; [
      act # GitHub Actions local runner
      coreutils # GNU core utilities
      csvkit # CSV tools
      exiftool # Image metadata editor
      fastfetch # System info
      fswatch # File system watcher
      gh # GitHub CLI
      htop # Process viewer
      imagemagick # Image processing
      jq # JSON processor
      lynx # Text-based web browser
      mise # Runtime manager
      mtr # Network diagnostic tool
      mysql80 # MySQL client
      ncdu # Disk usage analyzer
      neovim # Vim fork
      nmap # Network scanner
      pandoc # Markdown to PDF converter
      poppler # PDF rendering library
      pv # Pipe viewer
      rclone # Remote storage
      ripgrep # Search tool
      scc # Code complexity analyzer
      tree # Directory tree viewer
      watch # Execute a command periodically
      yt-dlp # YouTube downloader
      yubikey-manager # YubiKey manager
    ]);

  # Dotfiles managed by Home Manager (symlinked from Nix store)
  home.file = {
    # Example: ".screenrc".source = ./dotfiles/screenrc;
  };

  # Environment variables for user session
  home.sessionVariables = lib.mkIf pkgs.stdenvNoCC.isDarwin {
    # Obsidian vault path (iCloud)
    VAULT_PATH = "${config.home.homeDirectory}/Library/Mobile Documents/iCloud~md~obsidian/Documents/raccoon-life";
  };

  # Enable Home Manager to manage itself
  programs.home-manager.enable = true;
}
