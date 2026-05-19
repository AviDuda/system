---
name: rust-lint-config
description: Configure clippy lints for Rust projects. Use when setting up lint config, fixing clippy warnings, or deciding which lints to enable. Covers pedantic+restriction config, cast handling, and tooling gotchas.
---

# Rust Lint Configuration Guide

Opinionated guide to setting up clippy for Rust projects. Based on experience across multiple codebases.

## Recommended Cargo.toml Pattern

```toml
[lints.rust]
unreachable_pub               = "warn"
unused_qualifications         = "warn"
missing_docs                  = "allow"   # bookmark: enable when lib surface matters
missing_debug_implementations = "allow"   # bookmark: enable when lib surface matters

[lints.clippy]
pedantic = { level = "deny", priority = -1 }
cargo    = { level = "warn", priority = -1 }
```

Then cherry-pick restriction lints individually. Do NOT enable `restriction` as a group — clippy itself warns against it, and contradictory pairs (semicolon_inside vs semicolon_outside, etc.) cause noise.

### Why this baseline

- **pedantic deny at -1 priority**: New pedantic lints from Rust upgrades auto-appear. The negative priority ensures it doesn't conflict with individual overrides.
- **cargo warn**: Catches missing package metadata (license, description, repository). Zero-cost on existing projects.
- **rust builtins at warn**: `unreachable_pub` enforces `pub(crate)` hygiene. `unused_qualifications` catches stale paths.
- **allow bookmarks**: `missing_docs` and `missing_debug_implementations` are valuable for libraries but expensive to enable retroactively. Set to `allow` as a reminder to enable when the lib surface matters.

### Why not blanket restriction

egui (~100 restriction lints), epage's template, and most community advice all cherry-pick. The contradictory pairs and CI breakage risk on Rust upgrades make blanket enable not worth it.

## Restriction Lints Worth Adding

### Panic prevention (enable early)

```toml
string_slice        = "warn"
indexing_slicing    = "warn"
unwrap_used         = "warn"
panic               = "warn"
todo                = "warn"
unimplemented       = "warn"
```

Test exemptions in `clippy.toml`:
```toml
allow-unwrap-in-tests = true
```

### Unsafe discipline

```toml
undocumented_unsafe_blocks    = "warn"
multiple_unsafe_ops_per_block = "warn"
unnecessary_safety_doc        = "warn"
unnecessary_safety_comment    = "warn"
mem_forget                    = "warn"
```

### Tripwires (add at warn, zero warnings on clean code)

```toml
allow_attributes              = "warn"
dbg_macro                     = "warn"
let_underscore_must_use       = "warn"
rc_mutex                      = "warn"
infinite_loop                 = "warn"
semicolon_if_nothing_returned = "warn"
wildcard_imports              = "warn"
unused_async                  = "warn"
redundant_type_annotations    = "warn"
string_add                    = "warn"
ref_option                    = "warn"
use_self                      = "warn"
str_to_string                 = "warn"
```

## Lints to Skip (with reasons)

| Lint | Why skip |
|------|----------|
| `as_conversions` | Nuclear option — flags every `as` cast. Requires annotation on every site. Zero gain over per-site `#[expect]`. |
| `pattern_type_mismatch` | Style preference about ref-matching patterns (`let Some(x) = &opt` vs `let Some(ref x) = opt`). Noise. |
| `nursery` (group) | `missing_const_for_fn` is noisy on some codebases. `impl_hash_bx` and `mul_add` are micro-optimizations. Cherry-pick individuals if needed. |
| `unused_crate_dependencies` | False positives on cfg-gated platform deps. Known clippy issue. |
| `missing_const_for_fn` | Can be noisy. Many functions technically can be const but shouldn't be (e.g. FFI wrappers). |

## Handling Cast Lints

The pedantic cast lints (`cast_possible_truncation`, `cast_possible_wrap`, `cast_precision_loss`, `cast_sign_loss`) are real. They catch genuine bugs (NaN silently casting to 0, overflow wrapping). But in practice many casts are safe and known — platform API boundaries where the types don't match consumer expectations.

### Two approaches

1. **Eliminate the cast** — for display-only casts in format strings, format the value directly:
   ```rust
   // Bad: truncating cast just for display
   format!("at {},{}", point.x as i32, point.y as i32)
   // Good: format f64 directly
   format!("at {:.0},{:.0}", point.x, point.y)
   ```

2. **Per-site `#[expect]` with reason** — for casts that are genuinely safe but the compiler can't verify:
   ```rust
   #[expect(clippy::cast_possible_wrap, reason = "PID fits in i32")]
   let pid_i32 = pid as i32;
   ```

### Rules for `#[expect]`

- **Per-site, never fn-wide.** Fn-wide `#[expect(clippy::cast_*)]` silences new casts added later — the expect is already "fulfilled" by existing casts, so additional casts get silently suppressed.
- **Always include `reason`.** Documents why the cast is safe. That's the real value over `#[allow]`.
- **Extract to `let` bindings.** Expression-level `#[expect]` is unstable (Rust feature #15701). Cannot place on cast expressions inside struct fields, macro calls, or function arguments. Extract the cast to a named `let` and annotate the `let`.
- **Prefer `#[expect]` over `#[allow]`.** `#[expect]` produces a warning if the lint is never triggered (e.g. you annotated a cast that was later removed), catching stale annotations.

### Validated cast helpers (for genuinely risky casts)

When a cast has real validation logic (NaN checks, overflow rejection), write a helper:

```rust
pub fn coord_f64_to_i32(value: f64) -> Result<i32, Error> {
    if !value.is_finite() {
        return Err(Error::msg("non-finite coordinate"));
    }
    let rounded = value.round();
    if rounded > f64::from(i32::MAX) || rounded < f64::from(i32::MIN) {
        return Err(Error::msg("coordinate out of i32 range"));
    }
    #[expect(clippy::cast_possible_truncation, reason = "validated above")]
    Ok(rounded as i32)
}
```

Only do this for casts with real validation. Don't wrap `try_from` calls that add nothing over `#[expect]`.

## Tooling Gotchas

### `-W` doesn't override `[lints]` in Cargo.toml

`cargo clippy -- -W clippy::some_lint` does NOT override lint levels set in `[lints.clippy]`. To test a lint, temporarily change its level in Cargo.toml, run clippy, then restore.

### `cargo clippy --fix` is per-target

Auto-fix only applies to the target being checked. Run separately for each cross-compilation target:
```bash
cargo clippy --fix --allow-dirty
cargo clippy --fix --target x86_64-pc-windows-msvc --allow-dirty
```

### Always: fix → fmt → clippy

`cargo fmt` can introduce or change lint-triggering patterns (e.g. collapsing format args, reorganizing multi-line expressions). After any formatting change, re-run clippy.

### `cargo fmt` can break `undocumented_unsafe_blocks`

rustfmt collapses multi-line `#[expect]` attributes into single lines, which shifts `SAFETY:` comments relative to the attribute. Workaround: place SAFETY comments after the `#[expect]`, directly before the `unsafe` block.

### Counting lint warnings

```bash
# List all warning types with counts
cargo clippy 2>&1 | grep "^warning:" | grep -v "generated" | sort | uniq -c | sort -rn

# Find which files have a specific lint
cargo clippy 2>&1 | grep "the_lint_name" -A1 | grep "^\s*-->" | sed 's/.*--> //' | cut -d: -f1 | sort | uniq -c | sort -rn
```

## Cleanup Order for New Projects

1. **Pedantic mechanical fixes first**: `uninlined_format_args`, `unreadable_literal`, `redundant_closure_for_method_calls`, `manual_let_else`, `match_same_arms` — all auto-fixable.
2. **Pointer idioms**: `ptr_as_ptr`, `borrow_as_ptr`, `ptr_cast_constness` — auto-fixable with `cargo clippy --fix`.
3. **Doc hygiene**: `doc_markdown`, `missing_errors_doc` — auto-fixable for backticks, manual for `# Errors` sections.
4. **Restriction lints**: start with panic prevention, then unsafe discipline.
5. **Cast lints last** — most nuanced, especially in codebases with platform API boundaries.

## References

- egui's Cargo.toml: https://github.com/emilk/egui/blob/main/Cargo.toml (~100 restriction lints)
- epage's template: https://github.com/epage/_rust/blob/main/Cargo.toml (pragmatic cherry-pick)
- Reddit discussion: https://www.reddit.com/r/rust/comments/1rxbygj/ (community consensus on cherry-picking)
- Clippy lint list: https://rust-lang.github.io/rust-clippy/master/index.html
- Evan Schwartz "Your Clippy Config Should Be Stricter" article
