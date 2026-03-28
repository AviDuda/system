/**
 * @ mention resolution logic, separated for testability.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface AtMentionResult {
  /** What was resolved */
  type: "file" | "directory";
  /** The original mention path */
  mention: string;
  /** Content to inject */
  content: string;
}

/**
 * Resolve an @path mention: read the file or list directory contents.
 * Uses the same <file> tag format as pi's CLI file-processor.
 */
export function resolveAtMention(mention: string, cwd: string): AtMentionResult | null {
  const abs = resolve(cwd, mention);
  if (!existsSync(abs)) return null;

  try {
    const stat = statSync(abs);

    if (stat.isDirectory()) {
      const entries = readdirSync(abs, { withFileTypes: true });
      const listing = entries
        .map((e) => {
          const suffix = e.isDirectory() ? "/" : "";
          return `${e.name}${suffix}`;
        })
        .join("\n");
      return {
        type: "directory",
        mention,
        content: `<directory-listing name="${mention}">\n${listing}\n</directory-listing>`,
      };
    }

    const content = readFileSync(abs, "utf-8");
    return {
      type: "file",
      mention,
      content: `<file name="${mention}">\n${content}\n</file>`,
    };
  } catch {
    return null;
  }
}
