import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ContainerInfo, ContainerTarget, DockerTransport } from "./devcontainer";
import {
  detectTsFlavor,
  findDevcontainerRoot,
  findMountForHost,
  hasDevcontainer,
  normalizeHost,
  pathFromServer,
  pathToServer,
  readDevcontainerOverride,
  readServerContainerConfig,
  resolveContainerForServer,
  resolveServerTarget,
  translatePath,
} from "./devcontainer";

describe("translatePath", () => {
  test("exact match swaps to target", () => {
    expect(translatePath("/host/root", "/host/root", "/work/root")).toBe("/work/root");
  });

  test("child path carries suffix", () => {
    expect(translatePath("/host/root/src/a.ts", "/host/root", "/work/root")).toBe("/work/root/src/a.ts");
  });

  test("non-matching prefix returns null", () => {
    expect(translatePath("/other/place", "/host/root", "/work/root")).toBeNull();
  });

  test("sibling prefix that merely starts with the same chars does not match", () => {
    // /host/root-extra must NOT be treated as inside /host/root
    expect(translatePath("/host/root-extra/x", "/host/root", "/work/root")).toBeNull();
  });
});

describe("pathToServer / pathFromServer", () => {
  const map = { hostRoot: "/host/root", containerRoot: "/work/root", extra: [] };

  test("null map is identity", () => {
    expect(pathToServer("/anywhere/x.ts", null)).toBe("/anywhere/x.ts");
    expect(pathFromServer("/anywhere/x.ts", null)).toBe("/anywhere/x.ts");
  });

  test("host→container swaps prefix", () => {
    expect(pathToServer("/host/root/src/config.ts", map)).toBe("/work/root/src/config.ts");
  });

  test("container→host swaps prefix (reverse)", () => {
    expect(pathFromServer("/work/root/src/config.ts", map)).toBe("/host/root/src/config.ts");
  });

  test("extra maps are consulted when the primary prefix misses", () => {
    const mapWithExtra = {
      hostRoot: "/host/root",
      containerRoot: "/work/root",
      extra: [{ host: "/host/dep-cache", container: "/data/dep-cache" }],
    };
    expect(pathToServer("/host/dep-cache/pkg/1.0/lib/pkg.dll", mapWithExtra)).toBe(
      "/data/dep-cache/pkg/1.0/lib/pkg.dll",
    );
  });

  test("unmatched path passes through untranslated", () => {
    expect(pathToServer("/totally/elsewhere", map)).toBe("/totally/elsewhere");
  });
});

describe("findMountForHost", () => {
  const container = (mounts: Array<{ Type?: string; Source?: string; Destination?: string }>): ContainerInfo => ({
    Name: "/test-container",
    Mounts: mounts,
    Config: { Labels: { "com.docker.compose.service": "server" } },
    State: { Running: true },
  });

  test("exact bind-mount source matches", () => {
    const c = container([{ Type: "bind", Source: "/host/root", Destination: "/work/root" }]);
    expect(findMountForHost(c, normalizeHost("/host/root"))).toEqual({
      hostRoot: "/host/root",
      containerRoot: "/work/root",
    });
  });

  test("ancestor mount covers a deeper hostRoot", () => {
    // Server root is /host/root/sub but the mount is at /host/root
    const c = container([{ Type: "bind", Source: "/host/root", Destination: "/work/root" }]);
    expect(findMountForHost(c, "/host/root/sub")).toEqual({
      hostRoot: "/host/root",
      containerRoot: "/work/root",
    });
  });

  test("longest (most specific) matching source wins", () => {
    const c = container([
      { Type: "bind", Source: "/host", Destination: "/work" },
      { Type: "bind", Source: "/host/root", Destination: "/work/root" },
    ]);
    expect(findMountForHost(c, "/host/root/src")).toEqual({
      hostRoot: "/host/root",
      containerRoot: "/work/root",
    });
  });

  test("returns null when no bind mount covers hostRoot", () => {
    const c = container([{ Type: "bind", Source: "/somewhere/else", Destination: "/x" }]);
    expect(findMountForHost(c, "/host/root")).toBeNull();
  });

  test("ignores non-bind mounts (named volumes have no host Source to translate)", () => {
    const c = container([
      { Type: "volume", Source: "app-node-modules", Destination: "/work/root/node_modules" },
      { Type: "bind", Source: "/host/root", Destination: "/work/root" },
    ]);
    // The bind mount is the one that maps the host source; the volume is ignored.
    expect(findMountForHost(c, "/host/root")).toEqual({
      hostRoot: "/host/root",
      containerRoot: "/work/root",
    });
  });
});

describe("findDevcontainerRoot", () => {
  test("walks up to an ancestor .devcontainer", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-dc-"));
    try {
      fs.mkdirSync(path.join(tmp, ".devcontainer"));
      fs.writeFileSync(path.join(tmp, ".devcontainer", "devcontainer.json"), "{}");
      const sub = path.join(tmp, "sub", "deep");
      fs.mkdirSync(sub, { recursive: true });
      expect(findDevcontainerRoot(sub)).toBe(tmp);
      expect(findDevcontainerRoot(tmp)).toBe(tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns null when no devcontainer anywhere up the tree", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-dc-"));
    try {
      expect(findDevcontainerRoot(tmp)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolveServerTarget reads .lsp/ from the devcontainer root, not the server root", () => {
  test(".lsp/<server>.json at git root is found when cwd is a subproject", async () => {
    // Layout: tmp/.devcontainer/devcontainer.json, tmp/.lsp/my-ls.json (_containerInstall),
    // server cwd = tmp/sub (no .lsp there). Config must still be picked up.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-dc-"));
    try {
      fs.mkdirSync(path.join(tmp, ".devcontainer"));
      fs.writeFileSync(path.join(tmp, ".devcontainer", "devcontainer.json"), "{}");
      fs.mkdirSync(path.join(tmp, ".lsp"));
      fs.writeFileSync(path.join(tmp, ".lsp", "my-ls.json"), JSON.stringify({ _containerInstall: "install my-ls" }));
      const sub = path.join(tmp, "sub");
      fs.mkdirSync(sub, { recursive: true });

      // Mock transport: no containers running → resolveServerTarget returns null,
      // but we assert the config was READ (via a spy on resolveContainerForServer
      // would be ideal; instead, drive with a container that needs install and
      // confirm the install string from the git-root file is used).
      const installCalls: string[] = [];
      const mockTransport = {
        async listRunningContainers() {
          return [
            {
              Name: "/app",
              Mounts: [{ Type: "bind", Source: tmp, Destination: "/work" }],
              Config: { Labels: {} },
              State: { Running: true },
            },
          ];
        },
        async run(_container: string, script: string) {
          if (script.includes("command -v")) throw new Error("not found");
          installCalls.push(script);
          return "";
        },
      };
      // Sub passes no _containerInstall of its own; the git-root file must supply it.
      // To make the install appear to succeed so a target is returned, flip behavior.
      let installed = false;
      const wrapped = {
        listRunningContainers: mockTransport.listRunningContainers,
        async run(container: string, script: string) {
          if (script.includes("command -v") && installed) return "ok";
          if (!script.includes("command -v")) installed = true;
          return mockTransport.run(container, script);
        },
      };
      const target = await resolveServerTarget(sub, "my-ls", "my-ls", wrapped as unknown as DockerTransport);
      expect(installCalls).toEqual(["install my-ls"]);
      expect(target?.containerName).toBe("app");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("hasDevcontainer / config readers", () => {
  test("hasDevcontainer detects .devcontainer/devcontainer.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-dc-"));
    try {
      expect(hasDevcontainer(tmp)).toBe(false);
      fs.mkdirSync(path.join(tmp, ".devcontainer"));
      fs.writeFileSync(path.join(tmp, ".devcontainer", "devcontainer.json"), "{}");
      expect(hasDevcontainer(tmp)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("readDevcontainerOverride parses disabled + extraMaps; missing file = empty", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-dc-"));
    try {
      expect(readDevcontainerOverride(tmp)).toEqual({});
      fs.mkdirSync(path.join(tmp, ".lsp"));
      fs.writeFileSync(
        path.join(tmp, ".lsp", "devcontainer.json"),
        JSON.stringify({
          disabled: true,
          extraMaps: [{ host: "/h", container: "/c" }],
          ignoredField: "x",
        }),
      );
      expect(readDevcontainerOverride(tmp)).toEqual({
        disabled: true,
        extraMaps: [{ host: "/h", container: "/c" }],
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("readServerContainerConfig reads _containerInstall as string or array, and _container", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-dc-"));
    try {
      fs.mkdirSync(path.join(tmp, ".lsp"));
      fs.writeFileSync(
        path.join(tmp, ".lsp", "my-ls.json"),
        JSON.stringify({
          _comment: "ignored",
          _containerInstall: "npm install -g my-ls",
          _container: "frontend",
          someSetting: true,
        }),
      );
      expect(readServerContainerConfig(tmp, "my-ls")).toEqual({
        container: "frontend",
        install: "npm install -g my-ls",
      });

      // _command / _args escape hatch
      fs.writeFileSync(
        path.join(tmp, ".lsp", "cmd-ls.json"),
        JSON.stringify({ _command: "tsc", _args: ["--lsp", "--stdio", 42] }),
      );
      expect(readServerContainerConfig(tmp, "cmd-ls")).toEqual({
        command: "tsc",
        args: ["--lsp", "--stdio"], // non-strings filtered
      });

      // Array form for _containerInstall
      fs.writeFileSync(
        path.join(tmp, ".lsp", "other-ls.json"),
        JSON.stringify({ _containerInstall: ["step one", "step two"] }),
      );
      expect(readServerContainerConfig(tmp, "other-ls")).toEqual({
        container: undefined,
        install: ["step one", "step two"],
      });

      // Missing server file
      expect(readServerContainerConfig(tmp, "nope")).toEqual({});
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolveContainerForServer (mock transport)", () => {
  const mkTransport = (opts: {
    containers: ContainerInfo[];
    /** container name -> "has binary" boolean. Absent = probe fails. */
    present?: Record<string, boolean>;
    /** records install command strings that ran. */
    installCalls?: string[];
  }): DockerTransport & { runCalls: Array<{ container: string; script: string; positional?: string[] }> } => {
    const runCalls: Array<{ container: string; script: string; positional?: string[] }> = [];
    return {
      runCalls,
      async listRunningContainers() {
        return opts.containers;
      },
      async run(container, script, positional) {
        runCalls.push({ container, script, positional });
        if (script.includes("command -v") && script.includes("echo ok")) {
          if (opts.present?.[container]) return "ok";
          throw new Error("not found");
        }
        // Otherwise it's an install command (user shell string) — record and succeed.
        opts.installCalls?.push(script);
        return "";
      },
    };
  };

  const mkContainer = (name: string, mountSrc: string, mountDst: string, service?: string): ContainerInfo => ({
    Name: `/${name}`,
    Mounts: [{ Type: "bind", Source: mountSrc, Destination: mountDst }],
    Config: { Labels: service ? { "com.docker.compose.service": service } : {} },
    State: { Running: true },
  });

  test("returns the container that already has the binary", async () => {
    const t = mkTransport({
      containers: [mkContainer("app", "/host/root", "/work/root")],
      present: { app: true },
    });
    const target = await resolveContainerForServer("/host/root", "my-ls", { transport: t });
    expect(target?.containerName).toBe("app");
    expect(target?.pathMap).toEqual({
      hostRoot: "/host/root",
      containerRoot: "/work/root",
      extra: [],
    });
  });

  test("falls back to install when binary missing and install declared", async () => {
    const installCalls: string[] = [];
    const t = mkTransport({
      containers: [mkContainer("app", "/host/root", "/work/root")],
      present: { app: false },
      installCalls,
    });
    // Simulate install succeeding: after the install runs, the next probe hits.
    const originalRun = t.run.bind(t);
    let installed = false;
    t.run = async (container, script, positional) => {
      if (script.includes("command -v") && installed) return "ok";
      if (!script.includes("command -v")) installed = true;
      return originalRun(container, script, positional);
    };
    const target = await resolveContainerForServer("/host/root", "my-ls", {
      transport: t,
      install: "npm install -g my-ls",
    });
    expect(installCalls).toEqual(["npm install -g my-ls"]);
    expect(target?.containerName).toBe("app");
  });

  test("multi-service: skips the service without the binary, uses the one that has it", async () => {
    const t = mkTransport({
      containers: [
        mkContainer("backend", "/host/root", "/work/root", "backend"),
        mkContainer("frontend", "/host/root", "/work/root", "frontend"),
      ],
      present: { backend: false, frontend: true },
    });
    const target = await resolveContainerForServer("/host/root", "my-ls", { transport: t });
    expect(target?.containerName).toBe("frontend");
  });

  test("forceContainer override pins a specific service even if another has the binary", async () => {
    const t = mkTransport({
      containers: [
        mkContainer("backend", "/host/root", "/work/root", "backend"),
        mkContainer("frontend", "/host/root", "/work/root", "frontend"),
      ],
      present: { backend: true, frontend: true },
    });
    const target = await resolveContainerForServer("/host/root", "my-ls", {
      transport: t,
      forceContainer: "frontend",
    });
    expect(target?.containerName).toBe("frontend");
  });

  test("returns null when no container mounts the host root", async () => {
    const t = mkTransport({
      containers: [mkContainer("unrelated", "/somewhere/else", "/x")],
      present: { unrelated: true },
    });
    const target = await resolveContainerForServer("/host/root", "my-ls", { transport: t });
    expect(target).toBeNull();
  });

  test("returns null when no container has the binary and no install declared", async () => {
    const t = mkTransport({
      containers: [mkContainer("app", "/host/root", "/work/root")],
      present: { app: false },
    });
    const target = await resolveContainerForServer("/host/root", "my-ls", { transport: t });
    expect(target).toBeNull();
  });

  test("extraMaps flow into the resolved pathMap", async () => {
    const t = mkTransport({
      containers: [mkContainer("app", "/host/root", "/work/root")],
      present: { app: true },
    });
    const target = await resolveContainerForServer("/host/root", "my-ls", {
      transport: t,
      extraMaps: [{ host: "/host/dep-cache", container: "/data/dep-cache" }],
    });
    expect(target?.pathMap.extra).toEqual([{ host: "/host/dep-cache", container: "/data/dep-cache" }]);
  });

  test("probe passes the command as a positional, never interpolated into the shell string", async () => {
    const t = mkTransport({
      containers: [mkContainer("app", "/host/root", "/work/root")],
      present: { app: true },
    });
    // A hostile command name must not reach the shell script body.
    await resolveContainerForServer("/host/root", "evil;rm -rf /", { transport: t });
    const probeCall = t.runCalls.find((c) => c.script.includes("command -v"));
    expect(probeCall?.script.includes("evil")).toBe(false);
    expect(probeCall?.script.includes("rm")).toBe(false);
    expect(probeCall?.positional).toEqual(["bash", "evil;rm -rf /"]);
  });
});

describe("detectTsFlavor (host)", () => {
  const mkTs = (root: string, flavor: "ts5" | "ts7") => {
    const pkg = path.join(root, "node_modules", "typescript");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "typescript" }));
    fs.mkdirSync(path.join(pkg, "lib"), { recursive: true });
    if (flavor === "ts5") fs.writeFileSync(path.join(pkg, "lib", "tsserver.js"), "");
  };

  test("tsserver.js present => ts-classic; absent => ts7", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-ts-"));
    try {
      mkTs(tmp, "ts5");
      expect(await detectTsFlavor(tmp, null)).toBe("ts-classic");
      fs.rmSync(path.join(tmp, "node_modules", "typescript", "lib", "tsserver.js"));
      expect(await detectTsFlavor(tmp, null)).toBe("ts7");
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
  });

  test("walks up to the nearest typescript (subproject without its own install)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-ts-"));
    try {
      mkTs(tmp, "ts7"); // repo root on TS7
      const sub = path.join(tmp, "packages", "a");
      fs.mkdirSync(sub, { recursive: true });
      expect(await detectTsFlavor(sub, null)).toBe("ts7");
      // A nested TS5 package closer to the file wins.
      mkTs(sub, "ts5");
      expect(await detectTsFlavor(sub, null)).toBe("ts-classic");
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
  });

  test("no typescript anywhere => ts-classic (safe default; native needs positive evidence)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-ts-"));
    try {
      expect(await detectTsFlavor(tmp, null)).toBe("ts-classic");
    } finally {
      fs.rmSync(tmp, { recursive: true });
    }
  });
});

describe("detectTsFlavor (container)", () => {
  test("probes the container at the translated root; failure falls back to ts7", async () => {
    const calls: Array<{ script: string; positional?: string[] }> = [];
    const t: DockerTransport = {
      async listRunningContainers() {
        return [];
      },
      async run(_c, script, positional) {
        calls.push({ script, positional });
        return "ts-classic";
      },
    };
    const target: ContainerTarget = {
      containerName: "app",
      pathMap: { hostRoot: "/host/root", containerRoot: "/work/root", extra: [] },
    };
    expect(await detectTsFlavor("/host/root/sub", target, t)).toBe("ts-classic");
    expect(calls[0]?.positional).toEqual(["bash", "/work/root/sub"]);

    // Container probe fails (transport throws) => safe default ts-classic.
    const broken: DockerTransport = {
      async listRunningContainers() {
        return [];
      },
      async run() {
        throw new Error("docker down");
      },
    };
    expect(await detectTsFlavor("/host/root", target, broken)).toBe("ts-classic");
  });
});
