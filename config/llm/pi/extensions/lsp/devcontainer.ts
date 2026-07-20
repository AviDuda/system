/**
 * Devcontainer discovery: find the running container that should host a given
 * language server, derive the host↔container path mapping from bind mounts,
 * and ensure the server binary is installed (via `.lsp/<server>.json` `_containerInstall`).
 *
 * Multi-service aware: scans ALL running containers that bind-mount the project
 * root and picks the one that has (or can install) the server binary — not just
 * the devcontainer.json `service`. Handles split devcontainers (e.g. a separate
 * frontend container that owns node_modules) where the primary service can't see
 * the language's deps.
 *
 * Path mapping comes from `docker inspect` Mounts (the real bind mounts), not
 * from devcontainer.json's `workspaceFolder`, so each candidate container gets
 * its own correct host↔container root pair.
 */

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(cp.execFile);

// ── Types ──

export interface PathMap {
  /** Mount source on host (realpath'd). Translation prefix for host→container. */
  hostRoot: string;
  /** Mount destination in container. */
  containerRoot: string;
  /** Additional host↔container pairs (e.g. dep caches mounted separately). */
  extra: Array<{ host: string; container: string }>;
}

export interface ContainerTarget {
  containerName: string;
  pathMap: PathMap;
}

interface ContainerMount {
  Type?: string;
  Source?: string;
  Destination?: string;
}

export interface ContainerInfo {
  /** Container name with leading "/" (as returned by docker inspect). */
  Name: string;
  Mounts: ContainerMount[];
  Config?: { Labels?: Record<string, string> | null } | null;
  State?: { Running?: boolean } | null;
}

/** Docker I/O surface — injectable for tests. */
export interface DockerTransport {
  listRunningContainers(): Promise<ContainerInfo[]>;
  /**
   * Run a `bash -lc` script in the container. `positional` become $0, $1, $2 ... in
   * the script (bash convention: first positional is $0). Pass user values as
   * positionals and reference them as `"$1"` / `"$@"` in the script — Node's argv
   * carries them verbatim, so no shell quoting is needed and nothing can inject.
   */
  run(container: string, script: string, positional?: string[]): Promise<string>;
}

// ── Real docker transport ──

const DOCKER_TIMEOUT_MS = 8000;
const INSTALL_TIMEOUT_MS = 120_000;

const realTransport: DockerTransport = {
  async listRunningContainers(): Promise<ContainerInfo[]> {
    try {
      const { stdout: namesOut } = await execFile("docker", ["ps", "-q", "--format", "{{.Names}}"], {
        timeout: DOCKER_TIMEOUT_MS,
      });
      const names = namesOut
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length === 0) return [];
      const { stdout: json } = await execFile("docker", ["inspect", ...names], {
        timeout: DOCKER_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      });
      const parsed = JSON.parse(json) as ContainerInfo[];
      // Sanity-filter to running containers (inspect includes all by name; ps already filtered, but be safe).
      return parsed.filter((c) => c.State?.Running !== false);
    } catch {
      // docker not installed, daemon down, or parse failure — treat as "no containers".
      return [];
    }
  },

  async run(container: string, script: string, positional: string[] = []): Promise<string> {
    const { stdout } = await execFile("docker", ["exec", container, "bash", "-lc", script, ...positional], {
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  },
};

// ── Pure helpers ──

/** Strip the leading "/" docker inspect prepends to container names. */
function cleanName(n: string): string {
  return n.replace(/^\//, "");
}

/** Normalize a host path for mount matching: realpath + resolve. Falls back to resolved path. */
export function normalizeHost(p: string): string {
  try {
    return path.resolve(fs.realpathSync(p));
  } catch {
    return path.resolve(p);
  }
}

/**
 * Find the bind mount in `container` whose Source covers `hostRoot` (exact, or
 * mount is an ancestor of hostRoot). Returns the mount-root pair, preferring the
 * longest (most specific) matching Source. Returns null if no bind mount covers it.
 *
 * Returns mount-root (Source/Destination), NOT the precise hostRoot pair — so
 * translation works for any file under the mount, covering the server root and
 * anything the server might reference (deps, generated files) within the mount.
 */
export function findMountForHost(
  container: ContainerInfo,
  hostRoot: string,
): { hostRoot: string; containerRoot: string } | null {
  // Only bind mounts map host paths into the container; named/anonymous volumes
  // don't have a host Source we can translate. Tolerate a missing Type (older
  // docker) by also accepting a mount that has both Source and Destination.
  const mounts = (container.Mounts ?? []).filter(
    (m) => m.Source && m.Destination && (m.Type === "bind" || m.Type === undefined || m.Type === null),
  );
  let best: { src: string; dst: string } | null = null;
  for (const m of mounts) {
    // Normalize the Source the same way hostRoot is normalized (realpath), so
    // symlinked paths (e.g. macOS /var → /private/var) match. Falls back to the
    // raw path if realpath fails (shouldn't for a real bind-mount source).
    let src: string;
    try {
      src = path.resolve(fs.realpathSync(m.Source as string));
    } catch {
      src = path.resolve(m.Source as string);
    }
    // exact, or hostRoot is inside src
    if (src === hostRoot || hostRoot.startsWith(src + path.sep)) {
      if (!best || src.length > best.src.length) best = { src, dst: m.Destination as string };
    }
  }
  return best ? { hostRoot: best.src, containerRoot: best.dst } : null;
}

/**
 * Translate a path by swapping a prefix. Returns the translated path, or null if
 * `p` does not start with `from`. Handles exact-match and child paths.
 */
export function translatePath(p: string, from: string, to: string): string | null {
  if (p === from) return to;
  if (from === "") return null;
  if (p.startsWith(from + path.sep)) return to + p.slice(from.length);
  return null;
}

/** Host path → container path via a PathMap (tries hostRoot then extra). Untranslated if no match. */
export function pathToServer(filePath: string, map: PathMap | null): string {
  if (!map) return filePath;
  let t = translatePath(filePath, map.hostRoot, map.containerRoot);
  if (t !== null) return t;
  for (const e of map.extra) {
    t = translatePath(filePath, e.host, e.container);
    if (t !== null) return t;
  }
  return filePath;
}

/** Container path → host path via a PathMap (tries containerRoot then extra). Untranslated if no match. */
export function pathFromServer(filePath: string, map: PathMap | null): string {
  if (!map) return filePath;
  let t = translatePath(filePath, map.containerRoot, map.hostRoot);
  if (t !== null) return t;
  for (const e of map.extra) {
    t = translatePath(filePath, e.container, e.host);
    if (t !== null) return t;
  }
  return filePath;
}

/** True if `cwd` itself contains a devcontainer definition (does not walk up). */
export function hasDevcontainer(cwd: string): boolean {
  if (fs.existsSync(path.join(cwd, ".devcontainer", "devcontainer.json"))) return true;
  // Alternate layouts: .devcontainer.json at root, or .devcontainer/<name>.json
  if (fs.existsSync(path.join(cwd, ".devcontainer.json"))) return true;
  try {
    const dcDir = path.join(cwd, ".devcontainer");
    if (fs.statSync(dcDir).isDirectory()) {
      const entries = fs.readdirSync(dcDir);
      if (entries.some((f) => f.endsWith(".json"))) return true;
    }
  } catch {
    // not a directory or missing
  }
  return false;
}

/**
 * Walk up from `cwd` to find the nearest directory containing a devcontainer
 * definition. A devcontainer at the repo root covers subprojects inside it
 * (e.g. a frontend in a subdirectory under a repo root that owns the container),
 * so the server root need not be the devcontainer root. Returns the root or null.
 */
export function findDevcontainerRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  while (true) {
    if (hasDevcontainer(dir)) return dir;
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ── .lsp/ config readers ──

export interface DevcontainerOverride {
  /** Disable devcontainer mode entirely for this project (force host). */
  disabled?: boolean;
  /** Extra host↔container path pairs beyond the auto-detected mount. */
  extraMaps?: Array<{ host: string; container: string }>;
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Read project-wide devcontainer overrides from `.lsp/devcontainer.json`. */
export function readDevcontainerOverride(cwd: string): DevcontainerOverride {
  const parsed = readJsonFile(path.join(cwd, ".lsp", "devcontainer.json"));
  if (!parsed) return {};
  const extraMaps = Array.isArray(parsed.extraMaps)
    ? (parsed.extraMaps as Array<{ host: string; container: string }>).filter(
        (e) => e && typeof e.host === "string" && typeof e.container === "string",
      )
    : [];
  return { disabled: parsed.disabled === true, extraMaps };
}

export interface ServerContainerConfig {
  /** Force a specific compose service or container name for this server. */
  container?: string;
  /** Install command(s) to run in the container when the binary probe fails. */
  install?: string | string[];
}

/** Read per-server container config from `.lsp/<server>.json` (`_container`, `_containerInstall`). */
export function readServerContainerConfig(cwd: string, serverName: string): ServerContainerConfig {
  const parsed = readJsonFile(path.join(cwd, ".lsp", `${serverName}.json`));
  if (!parsed) return {};
  const container = typeof parsed._container === "string" ? parsed._container : undefined;
  const install =
    typeof parsed._containerInstall === "string" || Array.isArray(parsed._containerInstall)
      ? (parsed._containerInstall as string | string[])
      : undefined;
  return { container, install };
}

// ── Discovery orchestration ──

export interface ResolveOptions {
  /** Force a specific compose service or container name (from `_container`). */
  forceContainer?: string;
  /** Install commands (from `_containerInstall`). */
  install?: string | string[];
  /** Extra path maps (from `.lsp/devcontainer.json`). */
  extraMaps?: Array<{ host: string; container: string }>;
  /** Injectable transport (tests). */
  transport?: DockerTransport;
  /** Sink for explainable-fallback warnings (wired to ctx.ui.notify by the extension). */
  onWarn?: (message: string) => void;
}

interface Candidate {
  name: string;
  hostRoot: string;
  containerRoot: string;
  /** compose service label, for stable ordering preference. */
  service?: string;
}

/**
 * Resolve which container should host `serverCommand` for a project at `hostProjectRoot`.
 *
 * Algorithm:
 * 1. List running containers; keep those that bind-mount hostProjectRoot (or an ancestor).
 * 2. Order: forced container first (if `_container` set), then by preference.
 * 3. Probe each for the binary (`command -v`). First hit wins.
 * 4. If none have it but `_containerInstall` is declared, try installing in each candidate
 *    (first success where the binary then resolves wins).
 * 5. Otherwise null (caller falls back to host).
 *
 * Returns null silently on any failure (no docker, no mounts, no binary, install
 * failed) — the caller treats null as "host mode".
 */
export async function resolveContainerForServer(
  hostProjectRoot: string,
  serverCommand: string,
  opts: ResolveOptions = {},
): Promise<ContainerTarget | null> {
  const transport = opts.transport ?? realTransport;
  const warn = opts.onWarn ?? (() => {});
  const hostRoot = normalizeHost(hostProjectRoot);
  const containers = await transport.listRunningContainers();
  if (containers.length === 0) return null;

  // Build candidates: containers whose bind mounts cover hostRoot.
  const candidates: Candidate[] = [];
  for (const c of containers) {
    const mount = findMountForHost(c, hostRoot);
    if (!mount) continue;
    candidates.push({
      name: cleanName(c.Name),
      hostRoot: mount.hostRoot,
      containerRoot: mount.containerRoot,
      service: c.Config?.Labels?.["com.docker.compose.service"] ?? undefined,
    });
  }

  if (candidates.length === 0) return null;

  // Order: forced container first, then the rest (stable: by service name then container name).
  let ordered = [...candidates];
  if (opts.forceContainer) {
    const forced = candidates.find((c) => c.name === opts.forceContainer || c.service === opts.forceContainer);
    if (forced) {
      ordered = [forced, ...candidates.filter((c) => c !== forced)];
    }
    // If forced container isn't mounted (e.g. same-path mount with no Source match),
    // still try it with an identity map as a last resort.
    if (!forced) {
      // Look it up among ALL containers (even non-mounted) — the forced container
      // may legitimately use a same-path mount our prefix logic didn't catch.
      const allMatch = containers.find(
        (c) =>
          cleanName(c.Name) === opts.forceContainer ||
          c.Config?.Labels?.["com.docker.compose.service"] === opts.forceContainer,
      );
      if (allMatch) {
        const mount = findMountForHost(allMatch, hostRoot);
        ordered = [
          {
            name: cleanName(allMatch.Name),
            hostRoot: mount?.hostRoot ?? hostRoot,
            containerRoot: mount?.containerRoot ?? hostRoot,
            service: allMatch.Config?.Labels?.["com.docker.compose.service"],
          },
          ...candidates,
        ];
      }
    }
  }

  const probe = async (name: string): Promise<boolean> => {
    try {
      // `"$1"` is serverCommand, passed as a positional — Node argv carries it
      // verbatim, so there is no shell-quoting / injection surface.
      const out = await transport.run(name, 'command -v "$1" >/dev/null 2>&1 && echo ok', ["bash", serverCommand]);
      return out.trim() === "ok";
    } catch {
      return false;
    }
  };

  // Pass 1: binary already present.
  for (const cand of ordered) {
    if (await probe(cand.name)) {
      return toTarget(cand, opts.extraMaps);
    }
  }

  // Pass 2: install, then re-probe. Install commands are user-authored shell
  // strings (from `.lsp/<server>.json` `_containerInstall`), run verbatim via `bash -lc`.
  // Track failures so a container that mounts the root but can't get the binary
  // is surfaced — otherwise this silently falls back to host and the user never
  // learns why their devcontainer LSP isn't engaging.
  const installFailures: string[] = [];
  if (opts.install) {
    const cmds = Array.isArray(opts.install) ? opts.install : [opts.install];
    for (const cand of ordered) {
      let ok = true;
      let lastErr = "";
      for (const cmd of cmds) {
        try {
          await transport.run(cand.name, cmd);
        } catch (e) {
          ok = false;
          lastErr = e instanceof Error ? e.message : String(e);
          break;
        }
      }
      if (!ok) {
        installFailures.push(`${cand.name}: ${lastErr}`);
        continue;
      }
      if (await probe(cand.name)) {
        return toTarget(cand, opts.extraMaps);
      }
    }
  }

  // Surface why container mode didn't engage (when there WAS a candidate) so the
  // fallback to host is explainable instead of silent.
  if (candidates.length > 0) {
    const names = ordered.map((c) => c.name).join(", ");
    if (opts.install && installFailures.length > 0) {
      warn(
        `[lsp] devcontainer: container(s) ${names} mount the project root, but the _containerInstall command failed:\n  ${installFailures.join("\n  ")}\nFalling back to host. Common cause: the non-root container user can't write the global install prefix — try a user-local prefix or prefix the _containerInstall command with 'sudo'.`,
      );
    } else if (opts.install) {
      warn(
        `[lsp] devcontainer: _containerInstall ran in ${names} but ${serverCommand} was still not found; falling back to host. Check that the _containerInstall command actually puts ${serverCommand} on the container's PATH.`,
      );
    } else {
      warn(
        `[lsp] devcontainer: ${serverCommand} is not installed in container(s) ${names} and no _containerInstall is declared in .lsp/<server>.json; falling back to host.`,
      );
    }
  }

  return null;
}

function toTarget(cand: Candidate, extra?: Array<{ host: string; container: string }>): ContainerTarget {
  return {
    containerName: cand.name,
    pathMap: {
      hostRoot: normalizeHost(cand.hostRoot),
      containerRoot: cand.containerRoot,
      extra: (extra ?? []).map((e) => ({ host: normalizeHost(e.host), container: e.container })),
    },
  };
}

/**
 * Top-level entry for the extension: read `.lsp/` overrides + decide whether to
 * use a container for `serverName`/`serverCommand` at `cwd`. Returns a target or
 * null (host mode).
 */
export async function resolveServerTarget(
  cwd: string,
  serverName: string,
  serverCommand: string,
  transport?: DockerTransport,
  onWarn?: (message: string) => void,
): Promise<ContainerTarget | null> {
  // The devcontainer may be at an ancestor (repo root) of the server root (a
  // subproject); walk up to find it. The container mounts the repo root, which
  // findMountForHost resolves as an ancestor of the server root.
  const dcRoot = findDevcontainerRoot(cwd);
  if (!dcRoot) return null;
  // `.lsp/` lives at the devcontainer root (git root), not the server root — one
  // config location for the whole repo, even when the server root is a subproject.
  const override = readDevcontainerOverride(dcRoot);
  if (override.disabled) return null;
  const srv = readServerContainerConfig(dcRoot, serverName);
  return resolveContainerForServer(dcRoot, serverCommand, {
    forceContainer: srv.container,
    install: srv.install,
    extraMaps: override.extraMaps,
    transport,
    onWarn,
  });
}
