/**
 * API-key resolution helper for host-neutral providers.
 *
 * Pure module. Providers that take a host-resolvable key (readable from a file
 * on disk, no per-host auth plumbing) share this resolution chain so the logic
 * lives once. Hosts that resolve keys differently (e.g. pi's modelRegistry for
 * z.ai) inject the key directly and don't use this.
 *
 * Resolution order:
 *   1. <envVar>          (direct value)
 *   2. <fileEnvVar>      (path to a file containing the key)
 *   3. <defaultPath>     (e.g. sops-deployed /run/secrets/<name>)
 */

import { readFileSync } from "node:fs";

export function loadKey(opts: { envVar: string; fileEnvVar: string; defaultPath: string; label: string }): string {
  const direct = process.env[opts.envVar];
  if (direct) return direct;

  const filePath = process.env[opts.fileEnvVar] ?? opts.defaultPath;
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch {
    throw new Error(
      `Cannot load ${opts.label}: set ${opts.envVar} env var, or ${opts.fileEnvVar} to a readable path, or deploy ${opts.defaultPath}.`,
    );
  }
}
