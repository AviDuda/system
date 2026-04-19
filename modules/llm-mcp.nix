# Shared MCP server definitions for LLM agents (Claude Code, OpenCode, ...)
#
# One canonical server list; each tool consumes it via the transformer
# matching its config schema.
#
# Usage:
#   let m = import ../llm-mcp.nix { inherit pkgs; mcpDir = "/path/to/config/llm/mcp"; };
#   in m.toClaudeMcp     # { mcpServers = {...}; }  -- for managed-mcp.json / .claude.json / .mcp.json
#      m.toOpenCodeMcp   # { mcp = {...}; }         -- merges into opencode.json
#
# Adding a server: append one entry to `servers` below.

{ pkgs, mcpDir }:
let
  servers = [
    {
      name = "web-search";
      command = "${pkgs.bun}/bin/bun";
      args = [ "${mcpDir}/web-search/index.ts" ];
      env = { };
    }
  ];

  # Claude Code (`mcpServers` object, stdio type, command+args split)
  toClaudeMcp = {
    mcpServers = builtins.listToAttrs (
      map (s: {
        inherit (s) name;
        value = {
          type = "stdio";
          inherit (s) command args env;
        };
      }) servers
    );
  };

  # OpenCode (`mcp` object, "local" type, command is one array, env is "environment")
  toOpenCodeMcp = {
    mcp = builtins.listToAttrs (
      map (s: {
        inherit (s) name;
        value = {
          type = "local";
          command = [ s.command ] ++ s.args;
          environment = s.env;
          enabled = true;
        };
      }) servers
    );
  };
in
{
  inherit servers toClaudeMcp toOpenCodeMcp;
}
