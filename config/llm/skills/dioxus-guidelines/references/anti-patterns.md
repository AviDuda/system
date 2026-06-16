# Dioxus Anti-Patterns

Detailed reference of common Dioxus anti-patterns with examples.

## Incorrect Iterator Keys

List items must have unique keys that are stable across renders. Dioxus uses keys to associate state with contained components and ensure good diffing performance.

```rust
// ❌ Duplicate keys if multiple items reference the same element
{items.iter().map(|item| rsx! { row { key: "{item.id}", ... } })}

// ❌ Omitting keys when list can change
{items.iter().map(|item| rsx! { row { ... } })}

// ✅ Unique, stable keys
{items.iter().enumerate().map(|(i, item)| rsx! { row { key: "{i}", ... } })}

// ✅ Unique keys from stable identity
{items.iter().map(|item| rsx! { row { key: "{item.stable_id}", ... } })}
```

**Key rule:** if two items in the same list can reference the same underlying data, you need a composite key (e.g., `"{group_idx}-{item_idx}"`).

## Interior Mutability in Props

While technically acceptable, `Mutex`/`RwLock` in props breaks reactivity:

```rust
// ❌ Parent won't re-render when Mutex content changes
struct User { username: Mutex<String> }
fn UserComponent(user: User) -> Element { ... }

// ✅ Pass a Signal or immutable data instead
fn UserComponent(name: Signal<String>) -> Element { ... }
```

When a child writes to a Mutex prop, the parent doesn't know about the change and won't re-render. The UI goes out of sync.

## Updating State During Render

```rust
// ❌ Infinite loop risk — state change triggers re-render triggers state change
fn Component() -> Element {
    let mut count = use_signal(|| 0);
    *count.write() = count() + 1;  // BAD
    rsx! { "{count}" }
}

// ✅ Derive state with use_memo instead
fn Component() -> Element {
    let mut base = use_signal(|| 0);
    let doubled = use_memo(move || base() * 2);
    rsx! { "{doubled}" }
}
```

If you unconditionally update state during render, it re-renders in an infinite loop.

## Large Groups of State

```rust
// ❌ Single massive state struct
#[derive(Clone, PartialEq)]
struct AppState {
    tree: Vec<ElementNode>,
    selected: Option<ElementRef>,
    theme: Theme,
    tab: usize,
    filter: String,
    // ... 20 more fields
}
let mut state = use_signal(|| AppState::default());

// ✅ Smaller, focused signals
let mut tree = use_signal(|| vec![]);
let mut selected = use_signal(|| None);
let mut theme = use_signal(|| Theme::default());
let mut tab = use_signal(|| 0);
```

Benefits:
- Easier to reason about what triggers re-renders
- Less risk of accidental infinite loops
- Better performance (only affected components re-render)
- Cleaner component APIs

## Non-Deterministic Code in Component Body

```rust
// ❌ Runs every re-render
fn Component() -> Element {
    let result = some_non_deterministic_computation();
    rsx! { "{result}" }
}

// ✅ Use a hook or effect for one-time or dependency-driven computation
fn Component() -> Element {
    let result = use_hook(|| some_non_deterministic_computation());
    rsx! { "{result}" }
}

// ✅ Or use_memo for dependency-driven computation
fn Component() -> Element {
    let result = use_memo(move || compute_with_deps(a(), b()));
    rsx! { "{result}" }
}
```

Non-deterministic code in the component body executes on every re-render. Move it into a hook or effect.

## Overly Permissive PartialEq for Props

```rust
// ❌ Always returns true — child never gets updates
impl PartialEq for MyProps {
    fn eq(&self, other: &Self) -> bool { true }
}

// ✅ Return false when unsure — better to re-render than show stale UI
impl PartialEq for MyProps {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id && self.visible == other.visible
        // conservative: if in doubt, return false
    }
}
```

`PartialEq` determines if a component should re-render. If unsure, return `false` — it's better to re-render unnecessarily than to show out-of-date UI.

## Render Functions Instead of Components

Functions that return `Element` but aren't `#[component]` functions (often named `render_*`). These look like components but aren't:

```rust
// ❌ Can't use hooks safely, can't be optimized by Dioxus diffing
fn render_header(mode: Signal<ThemeMode>) -> Element {
    // This works at compile time but violates rules of hooks at runtime
    // if called conditionally (e.g. inside `if some_condition { render_header(...) }`)
    let state = use_context::<AppState>();
    rsx! { ... }
}

// ✅ Proper component — hooks are safe, Dioxus can optimize
#[component]
fn Header() -> Element {
    let mode = use_context::<Signal<ThemeMode>>();
    let state = use_context::<AppState>();
    rsx! { ... }
}
```

Every function that returns `Element` and contains RSX should be a `#[component]`.
Hooks inside non-component functions compile fine but panic at runtime when the
function is called conditionally (the "rules of hooks" are a runtime convention).
Components are mountable/unmountable as a whole, so their hooks are always called
in consistent order.
