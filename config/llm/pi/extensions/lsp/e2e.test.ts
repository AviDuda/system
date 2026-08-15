/**
 * Live end-to-end tests: real language servers over the real client.
 *
 * Opt-in — these spawn actual servers and can take a minute:
 *   LSP_E2E=1 bun test extensions/lsp/e2e.test.ts
 * Skipped in the normal `mise pi-check` run and for any server binary not on
 * PATH (add it via nix/homebrew or `nix shell nixpkgs#<pkg>` to include it).
 *
 * Host TS: this repo's root resolves its classic typescript install (classic
 * server, push diagnostics). TS7 native: set LSP_E2E_TS7_ROOT to a devcontainer
 * project on TS7 to exercise `tsc --lsp` (native server, pull diagnostics).
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DocumentSymbol, LspClient } from "./client";
import { createClient, fileToUri, incomingCalls, outgoingCalls, prepareCallHierarchy, syncFile } from "./client";
import { detectTsFlavor, resolveServerTarget } from "./devcontainer";
import { configForTsFlavor, KNOWN_SERVERS } from "./servers";

const E2E = process.env.LSP_E2E === "1";
const d = E2E ? describe : describe.skip;
d("e2e", () => {
  const tmpDirs: string[] = [];
  const clients: LspClient[] = [];
  afterAll(() => {
    for (const c of clients) void c.shutdown();
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function hasBinary(cmd: string): boolean {
    try {
      fs.accessSync(path.join("/usr/bin", cmd));
      return true;
    } catch {}
    const which = Bun.spawnSync(["sh", "-c", `command -v ${cmd}`]);
    return which.exitCode === 0;
  }

  function mkFixture(name: string, files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lsp-e2e-${name}-`));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    return dir;
  }

  async function startServer(serverName: string, cwd: string): Promise<LspClient> {
    const client = await createClient(serverName, KNOWN_SERVERS[serverName], cwd, null);
    clients.push(client);
    return client;
  }

  /** Host-mode classic-TS client. Default root: this repo (walk-up resolves ts-classic). Pass a root to root at a fixture. */
  async function startHostTs(root = path.resolve(import.meta.dir, "..", "..")): Promise<LspClient> {
    const flavor = await detectTsFlavor(root, null);
    expect(flavor).toBe("ts-classic");
    const client = await createClient(
      "typescript-language-server",
      configForTsFlavor(KNOWN_SERVERS["typescript-language-server"], flavor),
      root,
      null,
    );
    clients.push(client);
    return client;
  }

  /** Wait until diagnostics appear for a host file (or timeout). */
  async function waitForDiagnostics(client: LspClient, file: string, minCount = 1, ms = 20000) {
    const uri = fileToUri(file);
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = client.diagnostics.get(uri) ?? [];
      if (found.length >= minCount) return found;
      await new Promise((r) => setTimeout(r, 250));
    }
    return client.diagnostics.get(uri) ?? [];
  }

  test("typescript (host, classic TS ≤6): diagnostics for injected error", async () => {
    const client = await startHostTs();
    expect(client.pullDiagnostics).toBe(false);
    const file = path.join(path.resolve(import.meta.dir, "..", ".."), "extensions", "lsp", "servers.ts");
    await syncFile(client, file); // open (registers interest)
    const src = await fs.promises.readFile(file, "utf-8");
    await syncFile(client, file, `${src}\nconst __e2e_broken: number = "not a number";\n`);
    const diags = await waitForDiagnostics(client, file);
    expect(diags.some((d) => d.message.includes("not assignable"))).toBe(true);
  }, 60_000);

  test("typescript (host, classic): hover with multi-byte UTF-8 does not desync framing", async () => {
    // Regression: the transport once accumulated stdout as a string but
    // sliced frames by Content-Length BYTES — one multi-byte message silently
    // corrupted every response after it ("symbols work, hover times out").
    // A JSDoc with non-ASCII forces multibyte bytes into the hover response;
    // the FOLLOW-UP request proves the stream is still framed.
    const client = await startHostTs();
    const dir = mkFixture("utf8", {
      "unicode.ts":
        '/** Greets with → and ✓ ünïcode */\nexport function hello(nme: string): string {\n  return "héöllo " + nme + " — ✓";\n}\nhello("wörld");\n',
    });
    const file = path.join(dir, "unicode.ts");
    await syncFile(client, file);
    const uri = fileToUri(file);
    const hover = await client.request("textDocument/hover", {
      textDocument: { uri },
      position: { line: 4, character: 1 },
    });
    expect(hover).not.toBeNull();
    // follow-up request on the same connection proves framing survived
    const symbols = (await client.request("textDocument/documentSymbol", {
      textDocument: { uri },
    })) as DocumentSymbol[];
    expect(symbols.length).toBeGreaterThan(0);
  }, 90_000);

  test("typescript (host, classic): didChange updates diagnostics", async () => {
    const client = await startHostTs();
    const dir = mkFixture("didchange", {
      "editable.ts": "export const fine: number = 1;\n",
    });
    const file = path.join(dir, "editable.ts");
    await syncFile(client, file);
    // let the server settle on the clean file, then verify no type error
    await new Promise((r) => setTimeout(r, 3000));
    expect((client.diagnostics.get(fileToUri(file)) ?? []).every((d) => !d.message.includes("not assignable"))).toBe(
      true,
    );
    // introduce an error via didChange (no disk write)
    await syncFile(client, file, 'export const fine: number = "oops";\n');
    const broken = await waitForDiagnostics(client, file);
    expect(broken.some((d) => d.message.includes("not assignable"))).toBe(true);
  }, 90_000);

  test("typescript (host, classic): definition crosses files", async () => {
    // Client rooted AT the fixture (package.json root marker): repo-rooted
    // clients treat tmp files as orphan inferred projects and definition
    // returns only the import statement instead of jumping to target.ts.
    const dir = mkFixture("def", {
      "package.json": '{"name":"e2e-def","type":"module"}',
      "target.ts": "export function targetFn(n: number): number {\n  return n + 1;\n}\n",
      "caller.ts": 'import { targetFn } from "./target";\nexport const r = targetFn(1);\n',
    });
    const client = await startHostTs(dir);
    const file = path.join(dir, "caller.ts");
    await syncFile(client, file);
    await syncFile(client, path.join(dir, "target.ts"));
    // targetFn call site: line 1, char 19
    const def = (await client.request("textDocument/definition", {
      textDocument: { uri: fileToUri(file) },
      position: { line: 1, character: 19 },
    })) as Array<{ uri?: string; targetUri?: string }>;
    const flat = Array.isArray(def) ? def : [def];
    const uris = flat.map((l) => l?.uri ?? l?.targetUri ?? "");
    expect(uris.some((u) => u.endsWith("target.ts"))).toBe(true);
  }, 90_000);

  test("typescript (host, classic): call hierarchy incoming/outgoing", async () => {
    // Validates the call-hierarchy protocol layer the post-edit caller warning
    // is built on: prepareCallHierarchy on a declaration, then incoming/outgoing.
    const dir = mkFixture("ch", {
      "package.json": '{"name":"e2e-ch","type":"module"}',
      "a.ts":
        "export function top(): number {\n  return child();\n}\nexport function child(): number {\n  return 1;\n}\nexport function other(): number {\n  return top();\n}\n",
    });
    const client = await startHostTs(dir);
    const file = path.join(dir, "a.ts");
    await syncFile(client, file);
    const uri = fileToUri(file);

    // Position on `child` in `export function child() {` (line 3 0-based, char 16).
    const items = await prepareCallHierarchy(client, uri, { line: 3, character: 16 });
    expect(items.some((i) => i.name === "child")).toBe(true);
    const child = items.filter((i) => i.name === "child")[0];
    expect(child).toBeTruthy();

    // child() is called from top().
    const inc = await incomingCalls(client, child);
    expect(inc.some((c) => c.from.name === "top")).toBe(true);

    // top() calls child().
    const topItems = await prepareCallHierarchy(client, uri, { line: 0, character: 16 });
    const top = topItems.filter((i) => i.name === "top")[0];
    expect(top).toBeTruthy();
    const out = await outgoingCalls(client, top);
    expect(out.some((c) => c.to.name === "child")).toBe(true);
  }, 90_000);

  const ts7Root = process.env.LSP_E2E_TS7_ROOT ?? "";
  test.skipIf(!ts7Root || !fs.existsSync(ts7Root))(
    "typescript (devcontainer, TS7 native): flavor detect + pull diagnostics",
    async () => {
      const root = ts7Root;
      const target = await resolveServerTarget(root, "typescript-language-server", "tsc");
      if (!target) return; // no devcontainer with tsc running for the TS7 root
      const flavor = await detectTsFlavor(root, target);
      expect(flavor).toBe("ts7");
      const client = await createClient(
        "typescript-language-server",
        configForTsFlavor(KNOWN_SERVERS["typescript-language-server"], flavor),
        root,
        target,
      );
      clients.push(client);
      expect(client.pullDiagnostics).toBe(true);
      const file = path.join(root, "src", "index.ts");
      if (!fs.existsSync(file)) return;
      const src = await fs.promises.readFile(file, "utf-8");
      await syncFile(client, file, `${src}\nconst __e2e_broken: number = "not a number";\n`);
      const diags = await waitForDiagnostics(client, file);
      expect(diags.some((d) => d.message.includes("not assignable"))).toBe(true);
    },
    90_000,
  );

  /** Open `mainRel` from a fixture and assert its document symbols satisfy `check`. */
  async function expectSymbols(
    serverName: string,
    fixtureName: string,
    files: Record<string, string>,
    mainRel: string,
    check: (symbols: DocumentSymbol[]) => boolean = (s) => s.length > 0,
  ): Promise<void> {
    const root = mkFixture(fixtureName, files);
    const client = await startServer(serverName, root);
    const file = path.join(root, mainRel);
    await syncFile(client, file);
    const symbols = (await client.request("textDocument/documentSymbol", {
      textDocument: { uri: fileToUri(file) },
    })) as DocumentSymbol[];
    expect(check(symbols)).toBe(true);
  }

  test.skipIf(!hasBinary("rust-analyzer"))(
    "rust-analyzer: document symbols",
    () =>
      expectSymbols(
        "rust-analyzer",
        "rust",
        {
          "Cargo.toml": '[package]\nname = "e2e"\nversion = "0.1.0"\nedition = "2021"\n',
          "src/main.rs":
            'struct Point { x: u32, y: u32 }\nfn main() { let p = Point { x: 1, y: 2 }; println!("{}", p.x); }\n',
        },
        "src/main.rs",
      ),
    90_000,
  );

  test.skipIf(!hasBinary("gopls"))(
    "gopls: document symbols",
    () =>
      expectSymbols(
        "gopls",
        "go",
        {
          "go.mod": "module e2e\n\ngo 1.23\n",
          "main.go": "package main\n\nfunc main() {}\n\nfunc helper() int { return 42 }\n",
        },
        "main.go",
      ),
    60_000,
  );

  test.skipIf(!hasBinary("nixd"))(
    "nixd: document symbols on a let binding",
    () => expectSymbols("nixd", "nix", { "default.nix": "let\n  answer = 42;\nin\n  answer\n" }, "default.nix"),
    60_000,
  );

  test.skipIf(!hasBinary("bash-language-server"))(
    "bash-language-server: document symbols",
    () =>
      expectSymbols(
        "bashls",
        "bash",
        { "script.sh": "#!/usr/bin/env bash\nmy_func() {\n  echo hi\n}\nmy_func\n" },
        "script.sh",
        (s) => s.some((x) => x.name.includes("my_func")),
      ),
    60_000,
  );

  test.skipIf(!hasBinary("yaml-language-server"))(
    "yaml-language-server: document symbols",
    () =>
      expectSymbols("yamlls", "yaml", { "conf.yaml": "name: e2e\nspec:\n  replicas: 2\n  port: 8080\n" }, "conf.yaml"),
    60_000,
  );

  test.skipIf(!hasBinary("clangd"))(
    "clangd: document symbols (fallback mode, no compile db)",
    () =>
      expectSymbols(
        "clangd",
        "c",
        { "main.c": "struct Point { int x; int y; };\nint main(void) { struct Point p = {1, 2}; return p.x; }\n" },
        "main.c",
        (s) => s.some((x) => x.name === "main"),
      ),
    60_000,
  );

  test.skipIf(!hasBinary("pyright-langserver"))(
    "pyright: diagnostics for a type error",
    async () => {
      const root = mkFixture("py", {
        "main.py": 'def add(a: int, b: int) -> int:\n    return a + b\n\nadd("x", 1)\n',
      });
      const client = await startServer("pyright", root);
      const file = path.join(root, "main.py");
      await syncFile(client, file);
      const diags = await waitForDiagnostics(client, file);
      expect(diags.length).toBeGreaterThan(0);
    },
    60_000,
  );
});
