---
name: dioxus-guidelines
description: Dioxus 0.7 desktop development guidelines, gotchas, and anti-patterns. Use when writing Dioxus components, signals, RSX, event handlers, async patterns, or state management.
---

# Dioxus 0.7 Guidelines

Reference: https://github.com/DioxusLabs/docsite
- Docs source: `docs-src/0.7/src/`
- Summary: `docs-src/0.7/src/SUMMARY.md`

## Signals

### Core pattern
```rust
let mut count = use_signal(|| 0);

// Read: .read() or call like a function (Copy type)
let val = count();
let val = count.read().clone();

// Write: .set() or .write()
count.set(42);
*count.write() = 42;
```

### Ergonomic extensions (use these instead of raw .read/.write)
```rust
// Toggle boolean
enabled.toggle();

// Math operators
count += 1;
count -= 1;

// Iterator extension
for name in names.iter() { ... }

// Display impl (no .clone() needed)
rsx! { "Count: {count}" }
```

### Signal borrow rules
- `.read()` and `.write()` borrow the signal. Release the read guard (via `.clone()` or scoping) before calling `.write()`.
- **Never hold across `await` points** — clippy lint `await_holding_refcell_ref` catches this.
- **Double-borrow toggle pattern** — `signal.write().x = !signal.read().x` fails. Read into a local first:
  ```rust
  let v = !signal.read().x;
  signal.write().x = v;
  ```

### `peek()` for untracked reads
```rust
let val = signal.peek();  // reads without subscribing to re-renders
```
Use when you need a signal's value in a closure without triggering re-renders.

### Signals are `Copy`
Signals implement `Copy` via the generational-box crate — they're handles, not the value itself.
They can be freely cloned, shared into closures, and moved into async blocks without `Arc`.

### Signal disposal
Signals are automatically disposed when their owning component unmounts.
Reading a disposed signal panics at runtime — don't stash signals outside their component tree.

### Automatic batching
`Signal.write()` calls are batched until the next `await` boundary. No intermediate render:
```rust
text.set("Loading");
loading.set(true);
// Only ONE re-render, not two
```
Await boundaries are flush barriers — the runtime paints before polling next futures.

## Components and Props

### Always use `#[component]`, never render functions

Every UI function should be a `#[component]` function. No `fn render_*() -> Element`
patterns. Render functions:
- Can't use hooks (`use_context`, `use_effect`, etc.) — they're not components
- Can't be optimized by Dioxus's diffing (no boundary to skip re-renders)
- Create a constant debate about "should this be a component?" that wastes time

If it returns `Element` and contains RSX, make it a `#[component]`. No exceptions.

### Component basics
```rust
#[component]
fn MyComponent(name: String, count: Signal<i32>) -> Element { ... }
```
- Must start with capital letter or contain `_`
- Props must implement `PartialEq` + `Clone`
- Return `Element`
- **Cross-module resolution works fine in 0.7.9.** The `#[component]` macro generates a `completion_hints` module re-exporting a unit variant with the same name, but `fc_to_builder(ComponentName)` in the RSX macro resolves to the function (the variant doesn't implement `ComponentFunction`). All import styles work: `use module::Component`, `module::Component` in RSX, wildcard re-exports.

### Accept `ReadSignal<T>` for max compatibility
```rust
// Accepts Signal<bool>, Memo<bool>, ReadSignal<bool>, or plain bool
#[component]
fn Validator(is_valid: ReadSignal<bool>) -> Element { ... }
```
Dioxus auto-converts `T` into `ReadSignal<T>` when passed as props. This is the "decay" pattern — use it for props that need to be reactive.

### `ReadSignal` vs `WriteSignal` vs `Signal`
- **`ReadSignal<T>`** — read-only, implements `Readable`. Accept in component props for widest compatibility.
- **`Signal<T>` / `WriteSignal<T>`** — read+write. Use in state owners.
- **`Memo<T>`** — derived state. Also decays to `ReadSignal<T>`.

RSX auto-converts `Signal`/`Memo` to `ReadSignal` at the callsite. The `ReadSignal` prop pattern accepts all reactive types plus plain values.

## Global Context

### Providing context
Use `use_context_provider` to make state available to all descendants:
```rust
fn App() -> Element {
    use_context_provider(|| HeaderContext::new());
    rsx! { Child {} }
}
```

### Consuming context
```rust
fn Child() -> Element {
    let mut header = use_context::<HeaderContext>();
    rsx! { "{header.title}" }
}
```
Always use turbofish (`use_context::<Type>()`) — never rely on type inference from the
let binding. Changing the annotation silently pulls a different context.

### Bundle signals in a context struct
```rust
#[derive(Clone, Copy)]
struct HeaderContext {
    title: Signal<String>,
    subtitle: Signal<String>,
}

impl HeaderContext {
    fn new() -> Self {
        Self {
            title: Signal::new("Hello"),
            subtitle: Signal::new("World"),
        }
    }

    pub fn reset(&mut self) {
        self.title.set("".to_string());
        self.subtitle.set("".to_string());
    }
}
```
The struct must implement `Clone` (and ideally `Copy` — signals are `Copy`).

Use `Signal::new()` in context struct constructors, not `use_signal()`. Context state
lives for the app's lifetime, not scoped to a component — it doesn't need hook
tracking. `use_signal()` works inside `use_context_provider` by coincidence, but
`Signal::new()` is correct.

When a struct has N independent fields (section open/closed, filter selections),
make each its own `Signal<T>` rather than wrapping the whole struct in one signal.
Individual fields mean each subscriber only tracks the specific signal it reads —
writing one field doesn't re-render subscribers to others.

### Dynamic consumption
`consume_context` works in event handlers and async tasks without hooks:
```rust
rsx! {
    button {
        onclick: move |_| {
            consume_context::<HeaderContext>().reset();
        },
        "Reset"
    }
}
```

### Scoped context providers
Create provider components for scoped state (e.g. per-section themes):
```rust
#[component]
fn ThemeProvider(children: Element, color: ThemeColor) -> Element {
    use_context_provider(|| ThemeState::new(color));
    children
}
```

### Global signals (static)
Available app-wide without `use_context_provider`. Auto-mounted to root:
```rust
static COUNT: GlobalSignal<i32> = Signal::global(|| 0);

fn App() -> Element {
    rsx! {
        "Count: {COUNT}"
        button { onclick: move |_| *COUNT.write() += 1, "+" }
    }
}
```
Global signals are only global to one app instance — each window/SSR context gets its own independent value.

### Newtype wrappers for context
Context is indexed by `TypeId`. Use newtypes to store multiple values of the same type:
```rust
#[derive(Clone, Copy)]
struct Title(Signal<String>);

#[derive(Clone, Copy)]
struct Subtitle(Signal<String>);
```

## Reactive Stores

**Use sparingly** — `use_store` + `#[derive(Store)]` for fine-grained reactivity on struct fields or large collections. Signals + structs are good enough for most apps. Stores excel at:
- Avoid re-renders when only one field of a big struct changes
- Reactive HashMaps/Vecs where only the modified entry re-renders
- Third-party types you can't wrap in signals

```rust
#[derive(Store)]
struct HeaderState {
    title: String,
    subtitle: String,
}

fn App() -> Element {
    let header = use_store(|| HeaderState { title: "Hi".into(), subtitle: "There".into() });
    rsx! { "{header.title()}" }  // lens — only subscribes to .title
}
```

## Hoisting State

### Lift signals to the nearest common ancestor
When sibling components share state, move the `use_signal` up to their parent:
```rust
fn Parent() -> Element {
    let mut count = use_signal(|| 0);
    rsx! {
        Incrementer { onclick: move |_| count += 1 }
        Display { count }
    }
}
```

### Prefer callbacks over passing mutable signals
Don't pass `Signal<T>` to child components for mutation — use `EventHandler` callbacks instead:
```rust
// ✅ do this
#[component]
fn Incrementer(onclick: EventHandler<MouseEvent>) -> Element {
    rsx! { button { onclick, "+" } }
}
```
This preserves one-way data flow and makes components more reusable.

### Derived state → hoisted memo
If a memo is needed in multiple children, hoist it to the parent:
```rust
let is_valid = use_memo(move || validate(name, email));
rsx! {
    Validator { is_valid }
    InputHighlighter { is_valid }
}
```

### Callbacks: use `EventHandler` or `Callback` instead of `Rc<RefCell<dyn FnMut>>`

**This is the #1 fix for FnMut + 'static + Clone pain.**

```rust
// Simple callback with event
#[component]
fn MyButton(onclick: EventHandler<MouseEvent>) -> Element {
    rsx! { button { onclick, "Click me" } }
}

// Callback with args + return value
#[component]
fn Child(onclick: Callback<String, i32>) -> Element {
    let result = onclick.call("hello".into());
    ...
}
```

`EventHandler<T>` handles FnMut + 'static + Clone internally. `Callback<T, R>` for functions that take args and return values. Both are `Copy`.

**Don't use `Rc<RefCell<dyn FnMut() + 'static>>`** — it's verbose, requires `.borrow_mut()`, and is what `EventHandler`/`Callback` were designed to replace.

### Derived state
```rust
// ✅ Use memos for derived state
let double = use_memo(move || count() * 2);

// ❌ Don't store derived state in a signal
let mut double = use_signal(|| 0);
double.set(count() * 2);  // infinite loop risk
```

### Children
```rust
#[component]
fn RedDiv(children: Element) -> Element {
    rsx! { div { background_color: "red", {children} } }
}
```

## RSX Gotchas

### No `let` inside RSX braces
```rust
// ❌ Parse error
rsx! { div { "{format!("{}", { let x = 5; x })}" } }

// ✅ Compute in Rust first
let x = 5;
rsx! { div { "{x}" } }
```

### No expressions inside RSX string interpolation
```rust
// ❌ Parse error
style: "color: {if cond { a } else { b }}"

// ✅ Compute the string in Rust first
let color = if cond { a } else { b };
style: "color: {color}"
```

### RSX move semantics
Variables used in multiple conditional branches must be extracted before the RSX block. For `Option<T>`:
```rust
let show = opt.is_some();
let display = opt.clone().unwrap_or_default();
rsx! {
    if show { div { "{display}" } }
}
```

### Keyed lists
Keys must be unique across renders. Multiple items can reference the same underlying data — use `.enumerate()` to guarantee unique keys:
```rust
// ❌ Duplicate keys if multiple items reference same element
{items.iter().map(|item| rsx! { row { key: "{item.id}", ... } })}

// ✅ Unique keys
{items.iter().enumerate().map(|(i, item)| rsx! { row { key: "{i}", ... } })}
```

### Conditional rendering
Inline `if`/`else` works directly in RSX — no ternary needed:
```rust
rsx! {
    div {
        if logged_in() {
            Dashboard {}
        } else {
            Login {}
        }
    }
}
```
`if` without `else` evaluates to a placeholder (no-op). `Option<Element>`, iterators, and `match` blocks all work:
```rust
let header = match state {
    State::Loading => rsx! { "Loading..." },
    State::Loaded(data) => rsx! { ul { {data.iter().map(|x| rsx! { li { "{x}" } })} } },
};
```

## Async Patterns

### Prefer `spawn` over `use_future`
```rust
// Fire-and-forget background future (auto-cancelled on unmount)
use_hook(|| spawn(async move { ... }));

// Or in event handler — Dioxus auto-spawns returned futures
rsx! {
    button {
        onclick: move |_| async move { ... },
        "Run"
    }
}
```

### `use_action` for button-triggered async work
```rust
let mut run_checks = use_action(move || async move {
    // Returns Result<T>
    do_work().await
});

// Call it
run_checks.call();

// Read result
match run_checks.value() {
    Some(Ok(result)) => ...,
    Some(Err(e)) => ...,
    None => ...,
}
```
Auto-cancels previous calls on new `.call()`. Built-in result tracking.

### Prefer actions over effects
Direct async closures in event handlers are preferred over `use_effect` for most cases. Effects are overused and harder to reason about.

## Data Fetching

### `use_resource` for derived async state
Restarts when tracked dependencies change. Use for data that reloads reactively:
```rust
let breed = use_signal(|| "poodle".to_string());
let images = use_resource(move || async move {
    reqwest::get(format!("https://dog.ceo/api/breed/{breed}/images/random"))
        .await.unwrap()
        .json::<DogApi>().await.unwrap()
});

match images.value() {
    Some(data) => rsx! { img { src: "{data.message}" } },
    None => rsx! { "Loading..." },
}
```

### Decision guide
| Pattern | When to use |
|---------|-------------|
| Raw `async move` in onclick | Fire-and-forget, simple fetch with manual loading guard |
| `use_action` | Button-triggered work, auto-cancels previous calls, tracks result |
| `use_resource` | Derived async state that reloads when deps change |
| `use_effect` | Syncing with external state (window title, local storage) — last resort |

### Avoid waterfalls
Start all requests before awaiting any. Hoist `use_resource` calls to the top of the component, don't cascade them in branches.

## Event Handlers

### Common input patterns
```rust
// Text input
let mut name = use_signal(|| String::new());
rsx! { input { oninput: move |e| name.set(e.value()), placeholder: "Name" } }

// Checkbox
let mut enabled = use_signal(|| true);
rsx! { input { r#type: "checkbox", oninput: move |e| enabled.set(e.checked()) } }

// Select
let mut option = use_signal(|| None);
rsx! { select {
    oninput: move |e| option.set(Some(e.value())),
    option { value: "a", "Option A" }
    option { value: "b", "Option B" }
} }

// Form submit — prevent default to stay in-app
rsx! { form {
    onsubmit: move |e| {
        e.prevent_default();
        let vals = e.values();  // HashMap<String, String>
    },
    input { name: "username", r#type: "text" }
    button { r#type: "submit", "Submit" }
} }
```

### Event data access
| Method | Returns | Source event |
|--------|---------|-------------|
| `.value()` | `String` | input, textarea, select |
| `.checked()` | `bool` | checkbox, radio |
| `.values()` | `HashMap<String, String>` | form submit |
| `.files()` | `FileEngine` | file input |
| `.key()` | `Key` enum | keydown |
| `.client_coordinates()` | `(f64, f64)` | mouse |
| `.screen_coordinates()` | `(f64, f64)` | mouse |

### Prevent default & stop propagation
```rust
button {
    onclick: move |e| {
        e.prevent_default();   // cancel browser default
        e.stop_propagation();  // don't bubble to parent
    }
}
```

### Controlled vs uncontrolled inputs
- **Uncontrolled** (default): input manages its own value; you react to `oninput`
- **Controlled**: you drive the `value` attribute from a signal:
  ```rust
  let mut name = use_signal(|| String::new());
  rsx! { input { value: "{name}", oninput: move |e| name.set(e.value().to_uppercase()) } }
  ```
  Use controlled mode for validation, transformation, or programmatic value changes.

### Callbacks carry the runtime
`EventHandler` and `Callback` capture a handle to the Dioxus runtime. Pass them to file-system watchers, timers, or system IO where the runtime isn't active.

## Error Handling

### `Element` is `Result<VNode, RenderError>`
Use `?` to bubble errors to the nearest `ErrorBoundary`:
```rust
fn Counter() -> Element {
    let count = "123".parse::<i32>().context("Bad number")?;
    rsx! { "{count}" }
}
```
`RenderError` auto-converts from `anyhow::Error` via `From`.

### ErrorBoundary
```rust
rsx! {
    ErrorBoundary {
        handle_error: |errors: ErrorContext| rsx! {
            div { class: "error", "Something went wrong" }
        },
        Counter {}
    }
}
```
Errors thrown in children (via `?`) render the fallback. Supports nested boundaries — re-throw specific errors to parent.

### CapturedError
A `Clone`-wrapped `anyhow::Error` (`Arc<anyhow::Error>`). Required by hooks like `use_resource` that need `Clone` on their output:
```rust
let value = use_resource(|| async move {
    let res = fetch("/data").await?;
    dioxus::Ok(res)  // produces Result<T, CapturedError>
});
```

## Logging

Dioxus sets up `tracing` automatically via `launch`. Override: `dioxus::logger::init(Level::INFO)`. Use `tracing::info!()`, `tracing::debug!()`, etc. Output goes to `tracing-wasm` (web) or `tracing-subscriber` (desktop/server).

## Testing

- **Component tests**: render RSX to string via `dioxus-ssr`, compare with `pretty_assertions`.
- **Hook tests**: manually drive the virtual DOM.
- **E2E**: Playwright against `dx serve`.

## Internationalization

Third-party crate: [`dioxus-i18n`](https://github.com/dioxus-community/dioxus-i18n).

## Fullstack

Dioxus fullstack compiles to both a client binary (WebAssembly) and a server binary. The server handles initial SSR (HTML streaming, suspense) and exposes server functions — Rust functions callable from the client. Enable with `features = ["fullstack"]`. See `essentials/fullstack/` in the docs.

## Router

Add `features = ["router"]` to dioxus dependency. Core pattern:

### Define routes
```rust
#[derive(Routable, Clone, PartialEq)]
enum Route {
    #[route("/")]
    Home {},
    #[route("/users/:name")]
    UserDetail { name: String },
}
```
Route segment types: static (`/about`), dynamic (`:name`), catch-all (`:..path`), query (`?:key`).

### Render + navigate
```rust
rsx! {
    Router::<Route> {}
    Link { to: Route::Home {}, "Home" }
}

// Programmatic navigation
let nav = navigator();
nav.push(Route::UserDetail { name: "bob".into() });
nav.replace(Route::Home {});
```

### Nested routes
```rust
#[derive(Routable)]
enum Route {
    #[nest("/settings")]
        #[route("/general")]  GeneralSettings {},
        #[route("/password")] PasswordSettings {},
    #[end_nest]
}
```

## Styling

Dioxus uses standard HTML + CSS. Link a stylesheet:
```rust
static MAIN_CSS: Asset = asset!("/assets/main.css");
rsx! { document::Stylesheet { href: MAIN_CSS } }
```

CSS properties as attributes (snake_case):
```rust
rsx! { div { background_color: "blue", padding: "8px" } }
```

Multiple `class:` attributes stack — useful with Tailwind or conditional states:
```rust
class: "btn",
class: if active() { "btn-active" },

// Works for any conditional class, not just booleans
class: match severity {
    Severity::Error => "text-error",
    Severity::Warning => "text-warning",
    Severity::Pass => "text-pass",
},
```
No need to build class strings — each `class:` adds space-separated tokens.

CSS custom properties (`--var`) are preferred over Rust string interpolation for theming.

### Assets
`asset!()` paths are relative to app root. Asset must be **used** in RSX or the linker prunes it — use `#[used]` to force inclusion:
```rust
#[used]
static CERTS: Asset = asset!("/assets/certs.pem");
```
Supports image optimization (Avif, resizing), SCSS, arbitrary binary files. Hashes filenames automatically for caching.

## Desktop specifics
- **`use_window`** — access window handle: `let w = use_window(); w.set_title("...")`
- **`eval`** — run JS snippets: `document::eval("console.log('hi')")`
- **`document::Stylesheet`** — include CSS files
- **Config**: `dioxus_desktop::Config::new().with_custom_head("...")`
- Wry APIs exposed through `use_window` and desktop Config

### `onmounted` — element handle after mount
```rust
rsx! {
    input {
        onmounted: move |e| async move {
            e.set_focus(true).unwrap();
        }
    }
}
```
Useful for focus, scroll, or measuring an element after it's rendered.

## Hot-reload

Dioxus 0.7 supports **three forms** of hot-reloading via `dx serve`:
- **RSX**: modify UI structure without recompiling
- **Assets**: CSS changes reflect instantly
- **Rust** (experimental 0.7): hot-reload Rust code changes — first Rust framework to support this

## Custom hooks

Wrap `use_hook` + existing hooks to encapsulate logic:
```rust
fn use_counter(initial: i32) -> (Signal<i32>, impl Fn()) {
    let count = use_signal(|| initial);
    let increment = move || count += 1;
    (count, increment)
}
```
Hooks must start with `use_` and follow the rules of hooks (same order every render).

## Rules of Hooks

Functions starting with `use_` (hooks) must be called in the same order every render. Never call `use_signal`, `use_memo`, etc. inside:
- A conditional branch
- A loop
- After an early return

Lift hook state to a parent that always renders and pass it down as arguments. This is the #1 source of runtime panics in Dioxus.

## Lifecycle

- **`use_hook`** — creates state on first render, reuses on re-renders
- **`use_effect`** — runs side-effects when tracked dependencies change
- **`use_drop`** — cleanup when component is unmounted
- Signals are disposed when component unmounts. Reading after disposal causes runtime panic.

## Anti-patterns

See `references/anti-patterns.md` for detailed anti-patterns with examples.

Quick checklist:
- ❌ Incorrect iterator keys (keys must be unique across renders)
- ❌ Interior mutability in props (Mutex/RwLock breaks reactivity)
- ❌ Updating state during render (infinite loop risk)
- ❌ Large groups of state (prefer smaller, focused signals)
- ❌ Non-deterministic code in component body (use hooks/effects)
- ❌ Overly permissive PartialEq (return `false` when unsure)
