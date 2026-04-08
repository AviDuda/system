# Core darwin settings: nix config, shell, locale, binary caches
{ config, ... }:
{
  # sops-nix: use age key for decryption (not SSH host keys)
  # Key location on macOS - see docs/secrets.md for setup
  sops.age.keyFile = "/Users/${config.user.name}/Library/Application Support/sops/age/keys.txt";

  # GitHub token for nix flake operations (avoids API rate limits)
  # Requires age key to be set up first - see docs/secrets.md
  sops.secrets.github_access_token = {
    sopsFile = ../../secrets/github.yaml;
    key = "access_token";
  };

  # Kagi API key for web search (used by pi extension, needs user read access)
  sops.secrets.kagi_api_key = {
    sopsFile = ../../secrets/kagi.yaml;
    key = "api_key";
    owner = config.user.name;
  };

  # z.ai GLM Coding plan for Pi agent
  sops.secrets.glm_pi = {
    sopsFile = ../../secrets/llm.yaml;
    key = "glm_pi";
    owner = config.user.name;
  };

  sops.templates."nix-github.conf" = {
    owner = config.user.name;
    content = ''
      access-tokens = github.com=${config.sops.placeholder.github_access_token}
    '';
  };
  nix.extraOptions = ''
    !include ${config.sops.templates."nix-github.conf".path}
  '';
  # Required in nix-darwin 25.05+: specifies which user system options apply to
  system.primaryUser = config.user.name;

  # Match existing Nix installation GID (changed from 30000 to 350 in newer installs)
  ids.gids.nixbld = 350;
  # if you use zsh (the default on new macOS installations),
  # you'll need to enable this so nix-darwin creates a zshrc sourcing needed environment changes
  programs.zsh.enable = true;
  # bash is enabled by default

  # Set default locale
  environment.variables.LANG = "C.UTF-8";

  # nix-daemon is now managed automatically via nix.enable (default: true) in 25.05+
  # services.nix-daemon.enable is deprecated

  nix.settings = {
    # Necessary for using flakes on this system.
    experimental-features = "nix-command flakes";

    substituters = [
      "https://devenv.cachix.org"
      # "https://cache.lix.systems"  # Disabled: frequently times out
    ];

    trusted-public-keys = [
      "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw="
      # "cache.lix.systems:aBnZUw8zA7H35Cz2RyKFVs3H4PlGTLawyY5KRbvJR8o="
    ];
  };

  # Weekly garbage collection: delete generations older than 60 days
  nix.gc = {
    automatic = true;
    interval = {
      Weekday = 0;
      Hour = 21;
      Minute = 0;
    }; # Sunday 9pm
    options = "--delete-older-than 60d";
  };

  # Used for backwards compatibility, please read the changelog before changing.
  # $ darwin-rebuild changelog
  system.stateVersion = 4;
}
