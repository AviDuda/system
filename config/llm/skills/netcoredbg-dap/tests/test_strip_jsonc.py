#!/usr/bin/env python3
"""Tests for strip_jsonc. Run: python3 tests/test_strip_jsonc.py"""
import importlib.util, os, sys

HERE = os.path.dirname(__file__)
spec = importlib.util.spec_from_file_location("dap_run", os.path.join(HERE, "..", "scripts", "dap-run.py"))
# Import without executing main(): the module guard protects it.
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
strip = m.strip_jsonc
j = __import__("json")


def check(name, inp, want):
    got = j.loads(strip(inp))
    assert got == want, f"{name}\n  in:  {inp!r}\n  got: {got!r}\n  want:{want!r}"
    print(f"ok  {name}")


# 1. // inside a string must survive (regression: a URL with // in a real
#    launch.json was being mangled by a naive regex stripper).
check("// in URL survives",
      r'{"url": "http://+:8080"}',
      {"url": "http://+:8080"})

# 2. // outside a string is a comment and stripped.
check("line comment stripped",
      '{"a": 1 // trailing\n, "b": 2}',
      {"a": 1, "b": 2})

# 3. /* */ block comment stripped (incl. multiline).
check("block comment stripped",
      '{"a": /* x */ 1, "b": 2}',
      {"a": 1, "b": 2})

# 4. // inside a string that contains \" (escaped quote) is still inside the string.
check("escaped quote keeps // in string",
      r'{"s": "he said \"hi\" // not a comment", "b": 2}',
      {"s": 'he said "hi" // not a comment', "b": 2})

# 5. Trailing comma (JSONC) is NOT handled by strip_jsonc alone — caller must
#    use a tolerant parser. Asserting it raises, to document the boundary.
try:
    j.loads(strip('{"a": 1,}'))
    raise AssertionError("expected JSONDecodeError for trailing comma")
except j.JSONDecodeError:
    print("ok  trailing comma still rejected (out of scope)")

# 6. Real-world: an https URL with //.
check("https URL",
      '{"issuer": "https://localhost:5173"}',
      {"issuer": "https://localhost:5173"})

print("\nall passed")
