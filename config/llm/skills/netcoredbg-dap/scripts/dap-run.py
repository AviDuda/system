#!/usr/bin/env python3
"""Single-shot .NET debugger over the Debug Adapter Protocol, driven through
Samsung's netcoredbg over stdio. Sets a breakpoint, launches (or attaches),
stops, and prints stack + locals (+ optional --expressions). With --steps
it walks N lines after the stop; with --attach PID it debugs an already-
running process. No IDE, no MCP.

Target resolution (later flags win):
  --config NAME   read the named config from --launch-json (default .vscode/launch.json)
                  and use its program / cwd / env, with ${workspaceFolder} resolved
                  against --workspace (default: current dir). Launch mode only.
  --program PATH  DLL to launch (used if --config is absent, or to override it).
  --cwd PATH      working directory (likewise).
  --attach PID    attach to a running .NET process instead of launching.

The breakpoint (--source + --line) is always required.
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
import time


def strip_jsonc(text):
    """Remove // and /* */ comments from JSONC while preserving them inside strings.
    A naive regex can't do this — 'http://...' contains '//' inside a string."""
    out = []
    i = 0
    n = len(text)
    in_str = False
    str_quote = ''
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == '\\\\':  # escape next char literally (e.g. "\\"", "\\n")
                if i + 1 < n:
                    out.append(text[i + 1])
                    i += 2
                    continue
            elif c == str_quote:
                in_str = False
            i += 1
            continue
        if c in ('"', "'"):
            in_str = True
            str_quote = c
            out.append(c)
            i += 1
            continue
        if c == '/' and i + 1 < n:
            nxt = text[i + 1]
            if nxt == '/':  # line comment
                i += 2
                while i < n and text[i] not in '\n\r':
                    i += 1
                continue
            if nxt == '*':  # block comment
                i += 2
                while i + 1 < n and not (text[i] == '*' and text[i + 1] == '/'):
                    i += 1
                i += 2
                continue
        out.append(c)
        i += 1
    return ''.join(out)


def subst(value, workspace):
    if isinstance(value, str):
        return value.replace("${workspaceFolder}", workspace).replace(
            "${workspaceFolderBasename}", os.path.basename(workspace)
        )
    return value


def load_launch_config(path, name, workspace):
    with open(path) as f:
        data = json.loads(strip_jsonc(f.read()))
    for cfg in data.get("configurations", []):
        if cfg.get("name") == name:
            return {
                "program": subst(cfg.get("program"), workspace),
                "cwd": subst(cfg.get("cwd"), workspace),
                "env": {k: subst(v, workspace) for k, v in (cfg.get("env") or {}).items()},
            }
    raise SystemExit("config '%s' not found in %s" % (name, path))


def main():
    ap = argparse.ArgumentParser(description="Single-shot .NET DAP debug run via netcoredbg.")
    ap.add_argument("--config", help="launch.json config name to pull program/cwd/env from")
    ap.add_argument("--workspace", default=os.getcwd(), help="repo root for ${workspaceFolder}")
    ap.add_argument("--launch-json", default=".vscode/launch.json")
    ap.add_argument("--program", help="DLL path (launch mode; overrides --config)")
    ap.add_argument("--cwd", help="working dir (launch mode; overrides --config)")
    ap.add_argument("--attach", type=int, metavar="PID",
                    help="attach to a running .NET process by PID (launch mode flags ignored)")
    ap.add_argument("--kill-on-exit", action="store_true",
                    help="(attach) terminate the debuggee on disconnect. Default: leave it running.")
    # Breakpoint kinds — at least one required. They compose (e.g. a line bp
    # plus exception breakpoints).
    bp = ap.add_argument_group("breakpoints (at least one required)")
    bp.add_argument("--source", help="source file path (with --line for a line breakpoint)")
    bp.add_argument("--line", type=int, help="line number for --source")
    bp.add_argument("--when", dest="condition", metavar="EXPR",
                    help="condition for the line breakpoint (e.g. 'i == 5'); stops only when true")
    bp.add_argument("--function", action="append", default=[], metavar="FUNC",
                    help="function breakpoint, e.g. 'Namespace.Class.Method' (repeatable)")
    bp.add_argument("--break-on", action="append", default=[], metavar="FILTER",
                    choices=["all", "user-unhandled"],
                    help="exception filter: 'user-unhandled' or 'all' (repeatable)")
    bp.add_argument("--steps", type=int, default=0,
                    help="after the breakpoint stop, step this many more times before the final dump")
    ap.add_argument("--step-mode", choices=["next", "step", "finish"], default="next",
                    help="stepping command for --steps (next=over, step=into, finish=out of frame)")
    ap.add_argument("--env", action="append", default=[], help="KEY=VAL (repeatable)")
    ap.add_argument("--expressions", action="append", default=[], help="exprs to eval at stop")
    ap.add_argument("--stop-timeout", type=int, default=45)
    ap.add_argument("--netcoredbg", default="netcoredbg",
                    help="netcoredbg binary, or a prefixed command (e.g. 'docker exec -i CN netcoredbg'). Shlex-split.")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="log full DAP traffic (requests, responses, events) to stderr")
    args = ap.parse_args()

    has_line_bp = args.source or args.line
    has_any_bp = has_line_bp or args.function or args.break_on
    if not has_any_bp:
        raise SystemExit("need at least one breakpoint: --source/--line, --function, or --break-on")
    if (args.source is None) != (args.line is None):
        raise SystemExit("--source and --line must be given together")
    if args.condition and not has_line_bp:
        raise SystemExit("--when requires --source/--line")

    cfg = {"program": None, "cwd": None, "env": {}}
    if args.config and not args.attach:
        cfg = load_launch_config(args.launch_json, args.config, args.workspace)
    program = args.program or cfg["program"]
    cwd = args.cwd or cfg["cwd"]
    env = dict(cfg["env"])
    for kv in args.env:
        k, _, v = kv.partition("=")
        env[k] = v
    if not args.attach:
        if not program or not cwd:
            raise SystemExit("need --program/--cwd, or a --config that supplies them (or --attach PID)")
        is_remote = len(shlex.split(args.netcoredbg)) > 1
        if not is_remote and not os.path.isfile(program):
            raise SystemExit("program not found: %s (build first)" % program)
    # When --netcoredbg is a prefixed command, paths are remote (netcoredbg's
    # view); skip local existence checks — netcoredbg reports a missing DLL.
    is_remote = len(shlex.split(args.netcoredbg)) > 1
    source = subst(args.source, args.workspace) if args.source else None
    if source and not is_remote and not os.path.isfile(source):
        raise SystemExit("source not found: %s" % source)

    launch_cmd = shlex.split(args.netcoredbg) + ["--interpreter=vscode"]
    proc = subprocess.Popen(
        launch_cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=sys.stderr,
        bufsize=0,
    )

    buf = bytearray()

    def read_msg():
        nonlocal buf
        while True:
            idx = buf.find(b"Content-Length:")
            if idx != -1:
                if idx > 0:  # discard any banner/noise before the header
                    del buf[:idx]
                break
            chunk = proc.stdout.read(4096)
            if not chunk:
                raise EOFError("adapter closed before a message")
            buf += chunk
        while b"\r\n\r\n" not in buf:
            chunk = proc.stdout.read(4096)
            if not chunk:
                raise EOFError("adapter closed mid-header")
            buf += chunk
        header, _, rest = buf.partition(b"\r\n\r\n")
        n = int(header.split(b"Content-Length:")[1].strip())
        buf[:] = rest
        while len(buf) < n:
            chunk = proc.stdout.read(4096)
            if not chunk:
                raise EOFError("adapter closed mid-body")
            buf += chunk
        body = bytes(buf[:n])
        del buf[:n]
        return json.loads(body)

    seq = [0]

    pending_events = []  # events captured while waiting for req() responses

    def log_v(msg):
        if args.verbose:
            sys.stderr.write(msg + "\n"); sys.stderr.flush()

    # Requests that must succeed for the session to be usable. On failure,
    # print a clear error and exit instead of hanging waiting for a stop.
    SETUP_COMMANDS = {"initialize", "attach", "launch", "configurationDone",
                      "setBreakpoints", "setFunctionBreakpoints", "setExceptionBreakpoints"}

    def req(command, arguments=None):
        seq[0] += 1
        msg = {"seq": seq[0], "type": "request", "command": command}
        if arguments is not None:
            msg["arguments"] = arguments
        arg_summary = json.dumps(arguments, default=str)
        if len(arg_summary) > 200:
            arg_summary = arg_summary[:200] + "…"
        log_v("→ %s %s" % (command, arg_summary if arguments else ""))
        raw = json.dumps(msg).encode()
        proc.stdin.write(b"Content-Length: %d\r\n\r\n%s" % (len(raw), raw))
        proc.stdin.flush()
        want = seq[0]
        while True:
            m = read_msg()
            if m.get("type") == "response" and m.get("request_seq") == want:
                ok = m.get("success", True)
                err = m.get("message") or (m.get("body") or {}).get("error", {}).get("format") if not ok else None
                log_v("← %s %s%s" % (command, "ok" if ok else "FAILED", (" — " + err) if err else ""))
                if not ok and command in SETUP_COMMANDS:
                    detail = err or m.get("body", {}).get("error", {}).get("id")
                    print("RESULT: %s failed%s" % (command, (" — " + detail) if detail else ""), file=sys.stderr)
                    if command == "configurationDone" and args.attach and args.function:
                        print("netcoredbg rejects function breakpoints in attach mode on some "
                              "versions (configurationDone E_INVALIDARG). Use a line breakpoint "
                              "for attach, or use --function in launch mode.", file=sys.stderr)
                    sys.exit(3)
                return m
            if m.get("type") == "event":
                pending_events.append(m)
                sys.stderr.write("  event: %s %s\n" % (
                    m.get("event"), m.get("body", {}).get("reason", "")))

    try:
        stopped = None  # set by attach drain, or wait_stop below for launch
        # Helpers shared by launch and attach paths.
        def wait_stop(timeout):
            deadline = time.time() + timeout
            while time.time() < deadline:
                m = read_msg()
                if m.get("type") == "event" and m.get("event") == "stopped":
                    return m["body"]
            return None

        def dump(tag, body):
            tid = body["threadId"]
            print("%s reason=%s thread=%s" % (tag, body.get("reason"), tid))
            st = req("stackTrace", {"threadId": tid, "levels": 8})
            frames = st["body"]["stackFrames"]
            for i, fr in enumerate(frames):
                print("  #%d %s @ %s:%s" % (i, fr["name"], os.path.basename(fr.get("file", "?")), fr.get("line", "?")))
            top = frames[0]
            sc = req("scopes", {"frameId": top["id"]})
            for scope in sc["body"]["scopes"]:
                vr = req("variables", {"variablesReference": scope["variablesReference"]})
                for v in vr["body"]["variables"]:
                    print("  %s = %s" % (v["name"], v.get("value")))
            for expr in args.expressions:
                r = req("evaluate", {"expression": expr, "frameId": top["id"], "context": "repl"})
                print("  eval %s = %s" % (expr, r.get("body", {}).get("result", "(error)")))
            return tid

        req("initialize", {"clientID": "dap-run", "adapterID": "coreclr",
                           "linesStartAt1": True, "columnsStartAt1": True, "pathFormat": "path"})
        # In attach mode, attach FIRST (the process exists); then set bps against
        # the live runtime so they resolve immediately. In launch mode, set bps
        # before launch — they resolve lazily when the debuggee loads.
        if args.attach:
            req("attach", {"name": "dap-run", "type": "coreclr", "request": "attach",
                           "processId": args.attach})
        # Exception breakpoints (independent of source/function).
        if args.break_on:
            req("setExceptionBreakpoints", {"filters": args.break_on})
        # Function breakpoints (separate DAP request; repeatable via --function).
        if args.function:
            req("setFunctionBreakpoints", {"breakpoints": [{"name": n} for n in args.function]})
        # Line breakpoint, optionally conditional (--when).
        if source:
            bp_obj = {"line": args.line}
            if args.condition:
                bp_obj["condition"] = args.condition
            req("setBreakpoints", {"source": {"path": source},
                                   "breakpoints": [bp_obj], "lines": [args.line],
                                   "sourceModified": False})
        if not args.attach:
            req("launch", {"name": "dap-run", "type": "coreclr", "request": "launch",
                           "program": program, "cwd": cwd, "env": env,
                           "stopAtEntry": False, "args": []})
        req("configurationDone")

        if args.attach:
            # Attach succeeded. The breakpoint may already be past (the process
            # was already running), so a stop is NOT guaranteed. Count the live
            # session state (modules/threads) so the caller knows attach took,
            # then wait for a stop only if --stop-timeout > 0.
            import select
            threads = []
            modules = 0
            stopped = None

            def absorb(m):
                # Returns None, "stop" (with body), or "fail".
                nonlocal modules
                if m.get("type") != "event":
                    return None
                ev = m.get("event")
                if ev == "thread":
                    threads.append(m["body"]["threadId"])
                elif ev == "module":
                    modules += 1
                elif ev == "stopped":
                    return ("stop", m["body"])
                elif ev == "terminated" and not modules and not threads:
                    # Terminate before any module loaded = attach didn't hold
                    # (wedged/stale PID, or not a managed process).
                    return ("fail", None)
                return None

            # req() buffered events while hunting for its responses; count those.
            for ev in pending_events:
                sig = absorb(ev)
                if sig and sig[0] == "stop":
                    stopped = sig[1]
                    break
                if sig and sig[0] == "fail":
                    print("RESULT: netcoredbg terminated the attach before any module "
                          "loaded (PID may be wedged or not a managed .NET process).")
                    sys.exit(3)
            pending_events.clear()

            # Then drain the live stream until it settles or we hit a stop.
            end = time.time() + 3.0
            while time.time() < end and stopped is None:
                r, _, _ = select.select([proc.stdout], [], [], 0.2)
                if not r:
                    if modules or threads:
                        break  # burst has settled
                    continue
                sig = absorb(read_msg())
                if sig and sig[0] == "stop":
                    stopped = sig[1]
                elif sig and sig[0] == "fail":
                    print("RESULT: netcoredbg terminated the attach before any module "
                          "loaded (PID may be wedged or not a managed .NET process).")
                    sys.exit(3)
            print("ATTACHED: ~%d modules, %d threads" % (modules, len(threads)))
            if args.stop_timeout == 0:
                if stopped:
                    dump("STOPPED", stopped)
                print("RESULT: attached" + (" (stopped at breakpoint)" if stopped else " (no stop yet; bp may be past — drive the app to it, or re-run with --stop-timeout>0)"))
                try:
                    req("disconnect", {"terminateDebuggee": bool(args.kill_on_exit)})
                except EOFError:
                    pass
                return
            # else: stopped is set (caught during drain) or remains None
            # and the launch-path wait_stop below is skipped via the guard.

        # Launch path: wait for the first stop. Attach path: `stopped` is
        # already set if the drain caught a stop; otherwise (attach with no
        # stop yet, or launch) wait for one.
        if not (args.attach and stopped):
            stopped = wait_stop(args.stop_timeout)
        if not stopped:
            print("RESULT: no stop within %ds (breakpoint may not be hit, or line wrong)" % args.stop_timeout)
            sys.exit(1)
        tid = dump("STOPPED", stopped)

        for i in range(args.steps):
            req(args.step_mode, {"threadId": tid})
            s = wait_stop(args.stop_timeout)
            if not s:
                print("RESULT: no stop after step %d (process may have exited)" % (i + 1))
                break
            fr = req("stackTrace", {"threadId": tid, "levels": 1})["body"]["stackFrames"][0]
            print("  step %d (%s) -> %s @ %s:%s" % (
                i + 1, args.step_mode, fr["name"], os.path.basename(fr.get("file", "?")), fr.get("line", "?")))
            tid = s["threadId"]
        if args.steps:
            dump("AFTER-STEPS", {"threadId": tid, "reason": "stepped"})

        print("RESULT: breakpoint hit" + (", %d steps" % args.steps if args.steps else ""))
        try:
            req("disconnect", {"terminateDebuggee": bool(args.kill_on_exit)})
        except EOFError:
            pass
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    main()
