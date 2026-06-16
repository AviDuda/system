/**
 * Re-export shim. The registry lives in ./providers/registry.ts so it's
 * reachable by the pi extension via the bridge symlink (pi can only import
 * siblings under providers/, not files at this level). The MCP server imports
 * from here unchanged.
 */

export type { SearchProvider } from "./providers/registry";
export {
  availableProviders,
  formatOutcome,
  listProviders,
  providerLabel,
  providerNames,
  resolveProvider,
  type SearchOutcome,
} from "./providers/registry";
