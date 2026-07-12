---
name: netcoredbg-dap
description: Debug a .NET/C# application from the shell using Samsung's netcoredbg over the Debug Adapter Protocol — set a breakpoint, launch, inspect locals and the call stack at the stop. Use when debugging .NET/C# without an IDE (terminals, devcontainers, CI, agents), when vsdbg isn't usable (non-Microsoft VS Code builds, Linux), or when an agent needs to read actual runtime state instead of adding print statements.
---

# Debug .NET with netcoredbg (DAP)

Drive netcoredbg over the Debug Adapter Protocol from the shell to set a breakpoint, run to it, and read runtime state (call stack, locals, evaluated expressions). No IDE, no MCP, no print statements. The bundled script `scripts/dap-run.py` is one shot per invocation: set breakpoint(s) → launch or attach → stop → dump stack/locals → disconnect. For watching state evolve across lines, add `--steps`; for an already-running server, `--attach`.

## Prerequisites

- `netcoredbg` on PATH (`netcoredbg --version`). On Linux, >=3.2.0 needs glibc 2.38 — if the binary errors with `GLIBC_2.38 not found`, pin to 3.1.3.
- `python3` (stdlib only).
- A **Debug** build of the target DLL, with its **PDB** alongside it. Without the PDB, netcoredbg can't map source lines and breakpoints never hit. The script runs with Just-My-Code on (netcoredbg's DAP default); a Release build will still hit breakpoints but stepping/eval is degraded, and the script exposes no JMC toggle — use Debug.

## The single-shot run

```bash
python3 SKILL_DIR/scripts/dap-run.py \
  --config "Debug App" \
  --source src/Program.cs --line 42
```

`SKILL_DIR` is this skill's directory. `--config` reads that name from `.vscode/launch.json` and pulls `program` / `cwd` / `env` (with `${workspaceFolder}` resolved to the repo root). That's the clean path when the project already has a launch.json — reuse it rather than re-deriving paths.

If there's no launch.json (or you want to override), pass the target explicitly:

```bash
python3 SKILL_DIR/scripts/dap-run.py \
  --program bin/Debug/net8.0/App.dll \
  --cwd    bin/Debug/net8.0 \
  --source src/Program.cs --line 42
```

Add `--env KEY=VAL` (repeatable) and `--expressions "obj.Field"` (repeatable, evaluated at the stop) as needed.

## Gotchas (the parts that aren't obvious)

- **`setBreakpoints` returns `verified: false` — that is not a failure.** netcoredbg resolves breakpoints lazily once the debuggee loads the module; the breakpoint still hits at runtime. Do not treat the initial `verified=false` as a reason to abort.
- **`netcoredbg --server=PORT` accepts exactly one client.** A raw TCP probe, a second connect, or a crashed first client poisons the listener (symptom: "Address already in use" on relaunch). The bundled script avoids this entirely by using **stdio** (subprocess), not TCP. Use `--server` only when an *external* DAP client (an editor, nvim-dap, a bridge) will attach — and connect it cleanly the first time.
- **A breakpoint at the first statement of `Main` runs before config files, DB connections, or auth are wired.** Use it to inspect pure startup logic. To inspect behavior that depends on those (a request handler, an OIDC path), set the breakpoint at the relevant line and drive the app to it — and make sure the launch `env` carries whatever the runtime needs (connection strings, token issuers), which is exactly what launch.json captures.
- **Launch terminates the debuggee on disconnect; attach does not (by default).** In launch mode the script kills the debuggee when it finishes. In attach mode it detaches and leaves the process running — pass `--kill-on-exit` to terminate it. If you Ctrl-C the script, netcoredbg (and in launch mode the debuggee) may linger. Clean up (`pkill -f netcoredbg`, or the debuggee's process name) if a port or DLL is unexpectedly locked.
- **Paths match netcoredbg's view of the filesystem, not the script's.** `--netcoredbg` is shlex-split, so it can be a prefixed command (`docker exec -i CN netcoredbg`, `ssh host netcoredbg`). When netcoredbg runs remotely, pass its filesystem's paths for `--workspace` and `--source`, and resolve `${workspaceFolder}` against that same root (e.g. container paths when the prefix is `docker exec`). The script reads `launch-json` locally but hands resolved paths to netcoredbg — keep the two views straight.

## Stepping and attaching

Beyond the basic breakpoint-and-dump, the script supports:

- **`--steps N --step-mode next|step|finish`** — after the breakpoint stop, step N times (next=over, step=into, finish=out of current frame), printing the line after each step and a final locals/stack dump. Lets an agent watch state evolve across consecutive lines without a held session.
- **`--attach PID`** — attach to an already-running .NET process instead of launching. Use to debug a server that's already serving traffic: set a breakpoint in a request handler, attach with `--stop-timeout >0`, then drive the app to it (curl, click the UI, run the failing flow). The breakpoint resolves against the live process. `--kill-on-exit` terminates the debuggee on disconnect; by default attach leaves the process running. Find the PID from inside the container via `/proc`: `for d in /proc/[0-9]*; do grep -ql "App.dll" "$d/cmdline" && echo $(basename $d); done`.

Find a reachable breakpoint line (one the running process will actually hit) before attaching — a line in an HTTP handler, a service entry point, the failing code path. A breakpoint past the current execution point (e.g. `Main` on a booted server) will never hit.

## Breakpoint kinds (and netcoredbg caveats)

The breakpoint kinds compose — pass several at once (e.g. a line bp plus exception filtering). At least one is required.

- **Line: `--source FILE --line N`** — the default. Reliable.
- **Conditional line: add `--when EXPR`** — stops only when the C# expression evaluates true (e.g. `--when "i == 5"`). **Caveat:** if the expression *errors* during evaluation (a variable not in scope at that instruction, a type problem), netcoredbg stops anyway rather than skipping — and does not report the error. So a condition that silently never works looks identical to one that's correctly false. Keep conditions simple and reference only variables certain to be in scope at the line; if a conditional bp stops when it shouldn't, suspect an eval error.
- **Function: `--function FUNC` (repeatable)** — break by name (`Namespace.Class.Method`), no line needed; survives refactors. **Caveat:** works in launch mode; in attach mode netcoredbg rejects it (`configurationDone` E_INVALIDARG on some versions) and the script exits with a clear message. Use a line bp for attach.
- **Exception: `--break-on all|user-unhandled` (repeatable)** — break when an exception is thrown. `user-unhandled` = caught outside user code; `all` = every throw (noisy — internal library exceptions included). Reliable.

**netcoredbg breaks on unhandled exceptions by default**, even with no `--break-on` set — so a program that throws during startup will stop at the throw site (stop `reason=exception`) before reaching your breakpoint. That's usually what you want; if a launch stops somewhere unexpected with `reason=exception`, that's a real exception, not a breakpoint misfiring.

Add `-v` / `--verbose` to log the full DAP traffic (each request sent, each response with success/error, events) to stderr — essential when breakpoint setup silently fails or a stop isn't where you expected.

## When this skill isn't enough

For **interactive step-through across many turns** (set bp, step, inspect, set another bp, continue, repeat), the stateless run-per-invocation model is awkward — re-launching/re-attaching each turn is slow and loses the session. Options for that:
- `roblourens/dap-cli` — stateless shell commands over a persistent DAP session, reuses launch.json, ships its own skill. Generic; .NET/netcoredbg needs a custom-adapter config. Worth checking if it has matured.
- netcoredbg's own `--interpreter=cli` — a GDB-like REPL (`break file:line`, `next`, `print var`, `bt`); drive it by piping commands to stdin.
- An MCP-over-DAP bridge (`debugmcp/mcp-debugger` and similar) if MCP is acceptable in the environment.

## Building the target first

The script launches an already-built DLL — it does not build. Run the project's build first (the launch.json `preLaunchTask` names it, or use the project's standard build command). A stale build means the breakpoint's line won't match the running code. (Attach mode skips this — the process is already built and running.)

## Resolve `SKILL_DIR`

This file's directory. From a shell: `SKILL_DIR="$(dirname "$(readlink -f SKILL.md)")"`. In an agent context the skill path is known at load time; pass it through.
