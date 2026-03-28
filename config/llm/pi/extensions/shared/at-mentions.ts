/**
 * Shared @-mention parsing. Used by both agents-loader and at-mentions extensions.
 */

/**
 * Extract @path references from user input text.
 * Handles both @path and @"path with spaces" forms.
 * Skips bare @words without path separators or dots (person mentions).
 */
export function extractAtMentions(text: string): string[] {
  const paths: string[] = [];
  const regex = /@"([^"]+)"|@(\S+)/g;
  let match: RegExpExecArray | null;
  match = regex.exec(text);
  while (match !== null) {
    const path = match[1] ?? match[2];
    if (!path.includes("/") && !path.includes(".")) {
      match = regex.exec(text);
      continue;
    }
    paths.push(path);
    match = regex.exec(text);
  }
  return paths;
}
