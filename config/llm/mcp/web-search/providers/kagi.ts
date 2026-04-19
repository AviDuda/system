/**
 * Kagi provider adapter — wraps pi's kagi.ts in the MCP SearchProvider interface.
 * Shared implementation lives in pi; this file only adapts types.
 */

import { KagiApiError, search as kagiSearch, loadApiKey } from "../../../pi/extensions/web-search/providers/kagi";
import type { SearchProvider } from "../providers";

export const kagiProvider: SearchProvider = {
  name: "kagi",

  isAvailable() {
    try {
      loadApiKey();
      return true;
    } catch {
      return false;
    }
  },

  async search(query, { limit, signal }) {
    try {
      const result = await kagiSearch(query, { limit, signal });
      return {
        hits: result.sources.map((s) => ({
          title: s.title,
          url: s.url,
          snippet: s.snippet,
          publishedDate: s.publishedDate,
        })),
        relatedQuestions: result.relatedQuestions,
      };
    } catch (err) {
      if (err instanceof KagiApiError) throw new Error(err.message);
      throw err;
    }
  },
};
