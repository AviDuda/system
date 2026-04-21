# Pi coding agent configuration
{
  config,
  lib,
  ...
}:
let
  piConfigDir = "${config.home.homeDirectory}/.pi/agent";

  # Source directory for pi extensions
  piExtSrcDir = "${config.home.homeDirectory}/system/config/llm/pi/extensions";

  # Auto-discover extension directories from source.
  # Dirs with index.ts are extensions; dirs without are shared modules.
  # All are symlinked live — edit + /reload works without nix-switch.
  allExtDirs = builtins.filter
    (name: (builtins.readDir ../../config/llm/pi/extensions).${name} == "directory")
    (builtins.attrNames (builtins.readDir ../../config/llm/pi/extensions));

  # Shared skills list (bundled + external like forepaw)
  shared = import ./llm-shared.nix { inherit config; };
  inherit (shared) skills;

in
{
  home.file = lib.mkMerge [ {
  # Pi-specific agent instructions (global instructions injected separately via journal extension)
  ".pi/agent/AGENTS.md".text = ''
    # Pi Agent Instructions

    ## File Editing

    - Use edit (targeted replacement) for existing files, not write (full rewrite). Rewrites lose subtle details and make reviews harder.
    - Only use write for genuinely new files or when the entire file content is changing.
  '';

  # Custom model providers (LM Studio local models, etc.)
  # Pi reloads this on /model -- no restart needed.
  # Models defined here are available as both main models (in pi's model picker)
  # and sidecar models (via roles.json refs like "provider/model-id").
  ".pi/agent/models.json".text = builtins.toJSON {
    providers = {
      # z.ai GLM Coding plan -- direct provider (not via OpenRouter)
      # API key stored in sops: sops secrets/llm.yaml -> glm_pi
      zai = {
        baseUrl = "https://api.z.ai/api/coding/paas/v4";
        api = "openai-completions";
        apiKey = "!cat /run/secrets/glm_pi";
        models = [
          {
            id = "glm-5.1";
            name = "GLM-5.1 (z.ai)";
            reasoning = true;
            input = [ "text" ];
            contextWindow = 204800;
            maxTokens = 131072;
            cost = { input = 0; output = 0; cacheRead = 0; cacheWrite = 0; };
            compat = {
              supportsDeveloperRole = false;
              thinkingFormat = "zai";
            };
          }
          {
            id = "glm-4.7-flash";
            name = "GLM-4.7 Flash (z.ai)";
            reasoning = true;
            input = [ "text" ];
            contextWindow = 200000;
            maxTokens = 131072;
            cost = { input = 0; output = 0; cacheRead = 0; cacheWrite = 0; };
            compat = {
              supportsDeveloperRole = false;
              thinkingFormat = "zai";
            };
          }
          {
            id = "glm-4.6v-flash";
            name = "GLM-4.6V Flash (z.ai)";
            reasoning = false;
            input = [ "text" "image" ];
            contextWindow = 128000;
            maxTokens = 4096;
            cost = { input = 0; output = 0; cacheRead = 0; cacheWrite = 0; };
            compat = {
              supportsDeveloperRole = false;
              thinkingFormat = "zai";
            };
          }
        ];
      };
      lmstudio = {
        baseUrl = "http://127.0.0.1:1234/v1";
        api = "openai-completions";
        apiKey = "lm-studio";
        compat = {
          supportsDeveloperRole = false;
          supportsReasoningEffort = false;
          thinkingFormat = "qwen-chat-template";
        };
        models = [
          {
            id = "qwen/qwen3.5-9b";
            name = "Qwen3.5 9B (Local)";
            reasoning = true;
            input = [ "text" "image" ];
            contextWindow = 262144;
            maxTokens = 8192;
            cost = { input = 0; output = 0; cacheRead = 0; cacheWrite = 0; };
          }
        ];
      };
      # oMLX: MLX inference server with tiered KV cache, continuous batching.
      # Shares ~/.lmstudio/models/ with LM Studio. Auto-starts via brew service.
      # Model entries use requestParams for per-role thinking control:
      #   explain/draft: chat_template_kwargs.enable_thinking=false (skip CoT)
      #   vision: thinking_budget=1024 (capped thinking for image descriptions)
      omlx = {
        baseUrl = "http://127.0.0.1:8124/v1";
        api = "openai-completions";
        apiKey = "not-needed";
        models = [
          {
            id = "Qwen3.6-35B-A3B-UD-MLX-4bit";
            name = "Qwen 3.6 35B A3B UD (oMLX)";
            reasoning = true;
            input = [ "text" "image" ];
            contextWindow = 262144;
            maxTokens = 8192;
            cost = { input = 0; output = 0; cacheRead = 0; cacheWrite = 0; };
          }
          {
            id = "Qwen3.5-9B-4bit";
            name = "Qwen 3.5 9B (oMLX)";
            reasoning = true;
            input = [ "text" "image" ];
            contextWindow = 262144;
            maxTokens = 8192;
            cost = { input = 0; output = 0; cacheRead = 0; cacheWrite = 0; };
          }
        ];
      };
      # OpenRouter: backup models for when Claude is down.
      # ZDR enforced at account level -- data never retained by providers.
      # Two providers with separate API keys for cost tracking:
      #   openrouter-main: backup main models (higher spend cap)
      #   openrouter-sidecar: cheap fallback for explain/draft roles (tight cap)
      # Create keys: security add-generic-password -s openrouter-pi-main -a $USER -w 'sk-or-...'
      #              security add-generic-password -s openrouter-pi-sidecar -a $USER -w 'sk-or-...'
      # Model info: curl -s https://openrouter.ai/api/v1/models | jq '.data[] | select(.id == "MODEL_ID") | {id, context_length, max_completion: .top_provider.max_completion_tokens, pricing}'
      openrouter-main = {
        baseUrl = "https://openrouter.ai/api/v1";
        api = "openai-completions";
        apiKey = "!security find-generic-password -s openrouter-pi-main -w";
        models = [
          # Auto-router: picks best model per prompt from allowed set.
          # Configure allowed models in OpenRouter Settings > Plugins > Auto Router.
          # Suggested patterns: z-ai/*, deepseek/*, moonshotai/*, qwen/*
          {
            id = "openrouter/auto";
            name = "Auto (OpenRouter)";
            reasoning = true;
            input = [ "text" "image" ];
            contextWindow = 2000000;
            maxTokens = 16384;
            cost = { input = 0.5; output = 2; cacheRead = 0; cacheWrite = 0; };
          }
          {
            id = "z-ai/glm-5";
            name = "GLM 5 (OpenRouter)";
            reasoning = false;
            input = [ "text" ];
            contextWindow = 80000;
            maxTokens = 16384;
            cost = { input = 0.72; output = 2.3; cacheRead = 0; cacheWrite = 0; };
          }
          {
            id = "moonshotai/kimi-k2.5";
            name = "Kimi K2.5 (OpenRouter)";
            reasoning = true;
            input = [ "text" "image" ];
            contextWindow = 262144;
            maxTokens = 65535;
            cost = { input = 0.42; output = 2.2; cacheRead = 0; cacheWrite = 0; };
          }
          {
            id = "deepseek/deepseek-v3.2";
            name = "DeepSeek V3.2 (OpenRouter)";
            reasoning = false;
            input = [ "text" ];
            contextWindow = 163840;
            maxTokens = 16384;
            cost = { input = 0.26; output = 0.38; cacheRead = 0; cacheWrite = 0; };
          }
        ];
      };
      openrouter-sidecar = {
        baseUrl = "https://openrouter.ai/api/v1";
        api = "openai-completions";
        apiKey = "!security find-generic-password -s openrouter-pi-sidecar -w";
        models = [
          {
            id = "deepseek/deepseek-v3.2";
            name = "DeepSeek V3.2 (Sidecar)";
            reasoning = false;
            input = [ "text" ];
            contextWindow = 163840;
            maxTokens = 4096;
            cost = { input = 0.26; output = 0.38; cacheRead = 0; cacheWrite = 0; };
          }
        ];
      };
    };
  };

  # Model roles config for sidecar LLM calls (used by permission gate explain, draft suggestion, etc.)
  # Per-model options: ref (provider/model), thinking (off|minimal|low|medium|high),
  # maxAttempts (retry with filtering, default 1 -- useful for weaker/local models).
  # requestParams: per-model extra API params injected via pi's onPayload hook.
  #   Used for provider-specific options (e.g. oMLX thinking control).
  #   chat_template_kwargs.enable_thinking=false: skip CoT for fast responses
  #   thinking_budget=N: cap thinking tokens (max_tokens includes thinking)
  ".pi/agent/roles.json".text = builtins.toJSON {
    explain = {
      maxTokens = 256;
      models = [
        { ref = "omlx/Qwen3.6-35B-A3B-UD-MLX-4bit"; thinking = "off"; maxAttempts = 2; requestParams = { chat_template_kwargs = { enable_thinking = false; }; }; }
        { ref = "zai/glm-4.5-air"; thinking = "off"; }
        { ref = "zai/glm-4.7-flash"; thinking = "off"; }
        { ref = "anthropic/claude-haiku-4-5"; thinking = "off"; }
        { ref = "openrouter-sidecar/deepseek/deepseek-v3.2"; thinking = "off"; }
        { ref = "lmstudio/qwen/qwen3.5-9b"; thinking = "off"; maxAttempts = 2; }
      ];
    };
    draft = {
      maxTokens = 128;
      models = [
        { ref = "omlx/Qwen3.6-35B-A3B-UD-MLX-4bit"; thinking = "off"; maxAttempts = 2; requestParams = { chat_template_kwargs = { enable_thinking = false; }; }; }
        { ref = "zai/glm-4.5-air"; thinking = "off"; }
        { ref = "zai/glm-4.7-flash"; thinking = "off"; }
        { ref = "anthropic/claude-haiku-4-5"; thinking = "off"; }
        { ref = "openrouter-sidecar/deepseek/deepseek-v3.2"; thinking = "off"; }
        { ref = "lmstudio/qwen/qwen3.5-9b"; thinking = "off"; maxAttempts = 2; }
      ];
    };
    vision = {
      maxTokens = 3072;
      models = [
        { ref = "omlx/Qwen3.6-35B-A3B-UD-MLX-4bit"; thinking = "off"; maxAttempts = 2; requestParams = { thinking_budget = 1024; }; }
        { ref = "zai/glm-4.6v-flash"; thinking = "off"; }
      ];
    };
  };

  }

  # Skills: whole-directory symlinks to live sources (shared list defined in llm-shared.nix).
  (lib.listToAttrs (
    map (s: {
      name = ".pi/agent/skills/${s.name}";
      value.source = config.lib.file.mkOutOfStoreSymlink s.source;
    }) skills
  )) ];

  # Extensions deployed to ~/.pi/agent/extensions/ for auto-discovery.
  # All are symlinked to live source — edit + /reload works without nix-switch.
  home.activation.piExtensions = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    $DRY_RUN_CMD mkdir -p "${piConfigDir}/extensions"

    # Extension + shared directories (auto-discovered, symlinked to live source)
    # Pi only loads dirs with index.ts as extensions; shared dirs are just for imports.
    ${lib.concatMapStringsSep "\n    " (name: ''
      ext_link="${piConfigDir}/extensions/${name}"
      ext_target="${piExtSrcDir}/${name}"
      if [[ -L "$ext_link" ]] && [[ "$(readlink "$ext_link")" == "$ext_target" ]]; then
        : # already correct
      else
        $DRY_RUN_CMD ln -sfn "$ext_target" "$ext_link"
        echo "pi: linked ${name} -> $ext_target"
      fi
    '') allExtDirs}
  '';
}
