# Localize MF2 Editor

Browser-side syntax highlighter for [ICU MessageFormat 2.0](https://unicode.org/reports/tr35/tr35-messageFormat.html) (MF2) messages. Drop-in [Phoenix LiveView](https://github.com/phoenixframework/phoenix_live_view) hook.

The hook runs the [`tree-sitter-mf2`](https://github.com/elixir-localize/mf2_editor_extensions/tree/main/tree-sitter-mf2) grammar directly in the browser via [`web-tree-sitter`](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web). Keystrokes are highlighted and diagnostics surface without leaving the client — no server round trip per edit. The server stays in the loop only for authoritative operations (e.g. `Localize.Message.format/3`, persistence) that it actually owns.

> Not the same package as `localize_mf2_treesitter_server`. That one is server-side Elixir bindings — a NIF over the same grammar, useful for LSP servers, build-time validation, and SSR. This one is the browser runtime and LiveView hook. The two can coexist in the same app (the playground uses both); they share the grammar repo but not any runtime code.

---

## Contents

1. [What ships in this package](#what-ships-in-this-package)
2. [Installation](#installation)
3. [Wiring](#wiring) — read this carefully; several gotchas
4. [Configuration and caveats](#configuration-and-caveats) — read this before filing a bug
5. [CSS classes](#css-classes)
6. [Receiving diagnostics server-side](#receiving-diagnostics-server-side)
7. [Grammar currency](#grammar-currency)
8. [Troubleshooting](#troubleshooting)
9. [Status and roadmap](#status-and-roadmap)
10. [Licence](#licence)

## What ships in this package

Everything sits under `priv/static/` (so a single `Plug.Static` declaration exposes it all):

| File | Size | Purpose |
| --- | ---: | --- |
| `tree-sitter.js` | 165 KB raw, ~45 KB gz | web-tree-sitter loader (MIT). Registers a global `TreeSitter` class. |
| `tree-sitter.wasm` | 190 KB raw, ~80 KB gz | tree-sitter runtime compiled to WASM (MIT). Loaded by `tree-sitter.js`. |
| `tree-sitter-mf2.wasm` | ~23 KB | MF2 grammar compiled to WASM (Apache-2.0). Loaded by the hook. |
| `highlights.scm` | small | Capture query for syntax highlighting (vendored from the grammar repo). |
| `injections.scm` | small | Injection hints (currently unused by the hook but shipped for completeness). |
| `mf2_editor.js` | ~10 KB | The LiveView hook. Registers `window.LocalizeMf2Editor.Hooks.MF2Editor`. |

Plus under `priv/grammar/` — the grammar source used by the `--build-wasm` sync task — and in the package's `lib/`, the Elixir helpers:

* `LocalizeMf2Editor.script_tags/1` — emits the two `<script>` tags.
* `LocalizeMf2Editor.static_paths/0` — the file list for `Plug.Static`'s `:only` option.

## Installation

```elixir
def deps do
  [
    {:localize_mf2_editor, "~> 0.1"}
  ]
end
```

No compile-time toolchain is required for consumers — the WASM artefacts and JS hook are pre-built and shipped.

## Wiring

Four pieces need to line up. Each has at least one thing that will silently break the editor if missed; all four are covered by the five-step recipe below.

### 1. Serve the static assets

```elixir
# endpoint.ex
plug Plug.Static,
  at: "/mf2_editor",
  from: {:localize_mf2_editor, "priv/static"},
  gzip: false,
  only: LocalizeMf2Editor.static_paths()
```

The `:at` path is arbitrary but **must match the `base_url` option of `script_tags/1`** (see next step) and the path the hook fetches from at runtime. `/mf2_editor` is the default in both. If you need a different prefix (e.g. to route under an existing `/assets` mount), pass it to `script_tags/1` too.

The `:only` option scopes `Plug.Static` to the six files the hook needs; nothing else in `priv/` is exposed.

### 2. Emit the `<script>` tags in the root layout

```heex
<link phx-track-static rel="stylesheet" href="/assets/app.css" />
<%!-- MF2 editor scripts MUST appear before app.js (see below). --%>
{raw(LocalizeMf2Editor.script_tags())}
<script defer phx-track-static type="text/javascript" src="/assets/app.js"></script>
```

**`script_tags/1` must come before `app.js` in the document.** Both sets of scripts use `defer`, which runs them in document order after parsing finishes. `app.js` constructs the `LiveSocket` and reads `window.LocalizeMf2Editor.Hooks.MF2Editor` at that moment — so the MF2 scripts must have executed first and populated the namespace. Put them after `app.js` and the hook is silently unregistered; the editor mounts with no hook bound and you get the full **cursor moves but nothing highlights** failure mode. This is a very easy mistake to make; there is no runtime error.

If you pass a custom base URL:

```heex
{raw(LocalizeMf2Editor.script_tags(base_url: "/assets/mf2"))}
```

The hook's runtime asset fetches (`tree-sitter.wasm`, `tree-sitter-mf2.wasm`, `highlights.scm`) are derived from the same base URL via `window.LocalizeMf2Editor.baseUrl` (set by the `<script>` preamble) or a `data-mf2-base-url` attribute on the hook element.

### 3. Merge the hook into your `LiveSocket`

```js
// assets/js/app.js
const Hooks = {}
// ...your other hooks...

// Merge the MF2 editor hook in. It registers onto
// `window.LocalizeMf2Editor.Hooks` from mf2_editor.js.
const AllHooks = Object.assign({}, Hooks, window.LocalizeMf2Editor?.Hooks || {})

const liveSocket = new LiveSocket("/live", Socket, {
  hooks: AllHooks,
  params: { _csrf_token: csrfToken }
})
liveSocket.connect()
```

The `?.` guard is important for dev-mode reloads where the global might not be set yet.

### 4. Drop the editor markup into a template

```heex
<div phx-hook="MF2Editor" id="my-mf2-editor" class="lp-mf2-editor">
  <pre class="lp-mf2-highlight mf2-highlight" aria-hidden="true" phx-update="ignore" id="my-mf2-editor-pre"><code></code></pre>
  <textarea name="message" phx-update="ignore" phx-debounce="100" rows="8" spellcheck="false">{@message}</textarea>
</div>
```

The hook looks for exactly this shape: a `<pre>` and a `<textarea>`, both inside the hook element. It fills `pre > code` with highlighted HTML on every keystroke.

Three attributes matter:

1. **`phx-update="ignore"` on the textarea** — stops LiveView from overwriting the user's input value on every server round trip. Without it, the caret jumps to the end every ~100ms.

2. **`phx-update="ignore"` on the `<pre>`** — stops LiveView from overwriting the hook's rendered highlight with stale server state. Without it, you get flicker (the hook paints, then LiveView immediately paints over with the initial @message_html).

3. **Stable `id` on both the hook element and the `<pre>`** — LiveView uses them to recognise elements across re-renders. `phx-update="ignore"` requires an `id`.

### 5. Style the tokens

See [CSS classes](#css-classes). If the hook is mounting and repainting (you can verify in DevTools) but you see no colour, you need the class rules in your stylesheet.

---

Once all five are in place, reload with **`Cmd+Shift+R` / `Ctrl+F5`** to bypass the browser cache for the new `.js` / `.wasm` / `.css` files. In dev you'll need this cache-bust every time you edit `priv/static/mf2_editor.js` in this package (Plug.Static reads from disk, but the browser will happily serve the old version if the `Cache-Control` headers let it).

## Configuration and caveats

The rest of this section is a catalogue of sharp edges that *will* bite you if you skip them. Reading them in advance saves debugging time.

### Script load order is load-bearing

Both `tree-sitter.js` and `mf2_editor.js` must be loaded and parsed before `app.js`'s `defer` callback runs. The default `script_tags/1` output is correct **only if you place the call to `script_tags/1` before the `<script>` tag for your `app.js`**. See step 2 above.

Symptom if violated: hook never mounts, typing works natively (the textarea accepts input) but the `<pre>` never repaints. Typically no console errors.

### `phx-update="ignore"` is required on both textarea and pre

The hook reads `textarea.value` on every `input` event and writes to `pre.innerHTML`. LiveView's server-driven patches must not touch either element, or one of two failure modes appears:

- Without it on the textarea: caret jumps to the end of the text every time the server round-trips.
- Without it on the pre: highlight flickers back to stale server state every time the server round-trips.

If you need to *force* the textarea to a new value from the server (e.g. a "Load example" button), use `push_event/3`:

```elixir
socket |> push_event("mf2:set_message", %{value: example.message})
```

The hook listens for this event specifically, sets `textarea.value` directly, and re-paints. This is the only way to get server-initiated text into a `phx-update="ignore"` textarea.

### The textarea is transparent, the pre shows colour

By CSS convention in this design the `<textarea>` has `color: transparent` and its `::selection` background is a light tint; the visible tokens come from the `<pre>` underneath. Two implications:

1. **The caret's visual position depends on the textarea's font metrics, not the pre's.** If the two elements use even slightly different font settings, characters will visually drift apart along the line and end-of-line typing will show a gap between the last character and the caret (or between the caret and the next character). Pin these properties **identically** on both elements:

   ```css
   .lp-mf2-message, .lp-mf2-editor .lp-mf2-highlight {
     font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
     font-size: 13px;
     line-height: 1.5;
     letter-spacing: 0;
     tab-size: 4;
     font-kerning: none;
     font-variant-ligatures: none;
     font-feature-settings: normal;
     font-optical-sizing: none;
   }
   ```

   The defaults for these properties differ between `<textarea>` and text-flow elements in all major browsers; silence here means per-glyph drift of fractions of a pixel, which accumulates across a line.

2. **The caret glyph is visible against the pre's background colour.** Give the textarea an explicit `caret-color: <visible-colour>` so the caret shows even though the text is transparent. Without this, focusing the editor looks broken.

### Safari needs the `-webkit-` prefix for wavy underlines

Diagnostic squiggles use `text-decoration-style: wavy`. WebKit (Safari, iOS, macOS embedded webviews) only renders wavy underlines reliably when:

- The `-webkit-text-decoration-*` long-form properties are set alongside the unprefixed ones, and
- `text-decoration-thickness` is at least 2px (thinner squiggles paint as single pixels that alias into invisibility).

The recommended rules:

```css
.mf2-diag-error {
  text-decoration-line: underline;
  text-decoration-style: wavy;
  text-decoration-color: #ef4444;
  text-decoration-thickness: 2px;
  -webkit-text-decoration-line: underline;
  -webkit-text-decoration-style: wavy;
  -webkit-text-decoration-color: #ef4444;
  text-underline-offset: 2px;
}
.mf2-diag-missing {
  /* same shape, different colour (e.g. amber) */
}
```

Chrome and Firefox render the unprefixed form correctly, so the `-webkit-` lines are additive, not overriding. If you just write `text-decoration: underline wavy #ef4444` as a shorthand, WebKit silently drops the wave style in some releases.

### Full parse per keystroke (no incremental parse)

The hook does a fresh `parser.parse(source)` on every `input` event. For sub-kilobyte MF2 messages this is microseconds; it is **not** the source of any latency you might observe.

There is an incremental-parse API on tree-sitter (`parser.parse(source, oldTree)`) that reuses unchanged subtrees for large inputs. The hook does **not** use it, because incremental parse requires an explicit `oldTree.edit(descriptor)` call describing exactly which bytes changed — without it, tree-sitter silently returns a tree whose byte positions are stale, and your captures and `hasError` checks drift against the wrong source. The defensive thing is to full-parse. If you ever need to pay the complexity for a genuinely large input, do it in a fork and measure carefully.

### Client-side `hasError` is authoritative for the edit flow

After the hook has mounted, `hasError` on the client tree is the canonical answer to "is this MF2 valid?". Use the `mf2-diagnostics` `CustomEvent` (see below) for any UI that needs to react — do not re-parse on the server side of a `phx-change` event for diagnostic purposes. The server's job shrinks to whatever *authoritative* work it actually owns (format/validate/persist), and even that can be gated: the playground skips `Localize.Message.format/3` whenever the tree-sitter parse reports errors, which removes the "every keystroke produces a parse-error toast while you type" UX.

You can still keep a server-side tree-sitter parse as a separate concern if you want (the `localize_mf2_treesitter_server` package is exactly this), but it is not required for the editor to work.

### Server → client events

The hook listens for two `push_event/3` names from the server:

| Event | Payload | Behaviour |
| --- | --- | --- |
| `mf2:set_message` | `%{value: string}` | Immediately replaces `textarea.value`, moves the caret to the end, and re-highlights. Use this for *hard* text swaps — "Load example" buttons, loading a saved draft, anything where you want to blow away the current textarea content. |
| `mf2:canonical` | `%{value: string}` | *Soft* replacement. If the textarea is not focused, applies immediately. If it is focused, stores the value as a pending apply and installs it on the next `blur`. This is designed for "format-on-blur" UX: the server canonicalises the message whenever it parses cleanly and the hook snaps the textarea to the canonical form when the user tabs or clicks away. Typing is never interrupted. |

The relative caret position is preserved across `mf2:canonical` when possible — if the canonical value is longer than the old text, the caret sits at its old offset; if shorter, it clamps to the end of the new text. Absolute caret preservation is impossible in the general case (canonicalisation may insert/remove characters before the caret) so some motion is expected.

If you don't need the canonical snap, don't emit the event — the hook treats receipt as strictly opt-in. The playground uses `Localize.Message.canonical_message/2` inside its `compute/1` to produce the canonical form; a minimal wiring looks like:

```elixir
defp maybe_push_canonical(socket, message) do
  case Localize.Message.canonical_message(message, trim: false) do
    {:ok, canonical} when canonical != message ->
      push_event(socket, "mf2:canonical", %{value: canonical})
    _ ->
      socket
  end
end
```

Call it on every valid `phx-change` update. If canonical equals input, nothing fires — the event is only pushed when there is an actual change to apply, so the round trip amortises to zero once the textarea is already canonical.

### Hard-reload after every change to this package

`Plug.Static` serves from disk, so edits to `priv/static/mf2_editor.js` appear live on the server — but browsers cache static assets aggressively. During development, `Cmd+Shift+R` (macOS) or `Ctrl+F5` (Windows/Linux) after editing any `.js`/`.wasm`/`.css` in the package.

### First keystroke after mount

On mount the hook fetches and compiles the grammar WASM, which takes ~50–200ms on a typical dev machine. Until `initialize()` resolves, the `update()` call is a no-op and the pre shows whatever your server pre-rendered (or nothing, if you didn't SSR). This is why the recommended pattern is to seed `@message_html` on mount with a server-side highlight — see [the playground's `compute/1`](https://github.com/elixir-localize/localize_playground/blob/main/lib/localize_playground_web/live/messages_live.ex) for the pattern using `assign_new`.

If you don't want the server-side initial paint, leave the pre empty; the user sees nothing (transparent textarea) for a few tens of milliseconds, then the hook's first paint arrives. Depending on your UX tolerance this may be fine.

### UTF-16 indices, not bytes

`node.startIndex` and `node.endIndex` in web-tree-sitter are UTF-16 code-unit offsets (because the tree was parsed from a JS string). This matches `source.length`. It does **not** match the byte offsets you'd see in the Elixir `localize_mf2_treesitter_server` NIF, which operates on UTF-8 bytes. The two are identical for ASCII-only messages but diverge for content with multi-byte characters. If you're comparing indices across the two APIs, normalise first.

### Browser support

Runs in anything with WebAssembly and `text-decoration-style: wavy` — Safari 14+, Chrome 80+, Firefox 76+, Edge Chromium. No transpilation, no polyfills shipped.

## CSS classes

The hook emits span classes derived from the tree-sitter capture names in `highlights.scm`, replacing `.` with `-` (so `keyword.conditional` becomes `mf2-keyword-conditional`):

```
mf2-variable          mf2-keyword              mf2-punctuation-bracket
mf2-variable-builtin  mf2-keyword-conditional  mf2-punctuation-special
mf2-function          mf2-keyword-import       mf2-operator
mf2-string            mf2-number               mf2-string-escape
mf2-tag               mf2-attribute            mf2-constant-builtin
mf2-property
```

Diagnostic wrappers are **additive** — they sit alongside the highlight class on the same span:

```
mf2-diag-error        mf2-diag-missing
```

Keep the diagnostic CSS to `text-decoration` (wavy underline) only. Anything that changes glyph width — `letter-spacing`, `padding`, `text-shadow` with layout-affecting params — will break caret alignment with the transparent textarea. Background-color tints are safe.

A Monokai-style reference stylesheet lives in [`localize_playground`](https://github.com/elixir-localize/localize_playground/blob/main/priv/static/assets/app.css); copy or adapt as you prefer.

## Receiving diagnostics server-side

The hook dispatches a `mf2-diagnostics` `CustomEvent` on the hook element whenever the tree changes. The `detail` is an array of:

```js
{
  kind: "error" | "missing",
  startByte: number,   // actually UTF-16 code units; see caveat above
  endByte: number,
  startPoint: [row, col],
  endPoint: [row, col],
  message: string
}
```

If you need the server to know about diagnostics — for instance to gate a format call or to render an authoritative diagnostics panel — forward the event. The simplest way is a companion hook:

```js
Hooks.MF2DiagnosticsForwarder = {
  mounted() {
    this._h = (e) => this.pushEvent("mf2:diagnostics", {count: e.detail.length})
    this.el.addEventListener("mf2-diagnostics", this._h)
  },
  destroyed() {
    if (this._h) this.el.removeEventListener("mf2-diagnostics", this._h)
  }
}
```

And then on the LiveView side:

```elixir
def handle_event("mf2:diagnostics", %{"count" => count}, socket) do
  {:noreply, assign(socket, :mf2_error_count, count)}
end
```

The playground does not do this — it prefers to parse on the server via `localize_mf2_treesitter_server` for any server-side diagnostic logic, and lets the client handle visual squiggles independently. Both patterns work.

## Grammar currency

The grammar sources, highlight query, and compiled WASM are vendored from [`mf2_editor_extensions/tree-sitter-mf2`](https://github.com/elixir-localize/mf2_editor_extensions/tree/main/tree-sitter-mf2). The `mix localize_mf2_editor.sync` task keeps them in step:

```bash
# Copy sources + queries from the sibling repo.
mix localize_mf2_editor.sync

# CI check — exit non-zero if vendored files drift from the grammar repo.
mix localize_mf2_editor.sync --check

# Rebuild priv/static/tree-sitter-mf2.wasm from priv/grammar/ via the
# tree-sitter CLI + emscripten (or docker/podman).
mix localize_mf2_editor.sync --build-wasm
```

The sync task looks for the grammar at `../mf2_editor_extensions/tree-sitter-mf2` by default; override with `MF2_GRAMMAR_DIR=/path`.

`--build-wasm` requires either `emcc` (emscripten), Docker, or Podman on PATH — tree-sitter's CLI uses one of these to invoke emscripten. On macOS, starting Docker Desktop is the shortest path (`open -a Docker`); on Linux, `sudo pacman -S emscripten` or the equivalent works.

## Troubleshooting

If the editor isn't working, these are the failure modes and how to identify each.

### "Typing moves the caret, but nothing highlights / repaints"

The hook never mounted. Check the DevTools console:

- If there's no `LiveView` chatter about your hook and no errors, the hook isn't registered on the `LiveSocket` — usually a script load-order issue. See [Wiring step 2](#2-emit-the-script-tags-in-the-root-layout).
- If there's a `ReferenceError: TreeSitter is not defined`, `tree-sitter.js` didn't load — usually a `Plug.Static` misconfiguration.

### "It worked once, now typing produces stale state"

The hook is passing the old tree to `parser.parse()` without calling `edit()` first. This doesn't apply to the shipped hook (it always full-parses) — but if you forked and tried to implement incremental parse, this is the trap. Revert to a full parse unless you've implemented edit descriptors correctly.

### "Caret drifts away from text at end of line"

Font-metric divergence between the textarea and the pre. Pin all the font properties in [Configuration and caveats § transparent textarea](#the-textarea-is-transparent-the-pre-shows-colour).

### "Wavy underlines don't show in Safari"

Add the `-webkit-text-decoration-*` long-form properties and ensure `text-decoration-thickness` is at least 2px. See [Configuration and caveats § Safari](#safari-needs-the--webkit--prefix-for-wavy-underlines).

### "Load Example button updates the server state but the textarea still shows the old text"

`phx-update="ignore"` is doing its job — LiveView can't touch the textarea. Use `push_event/3` to send the new text to the hook, which listens for `mf2:set_message`. See [Configuration and caveats § phx-update](#phx-updateignore-is-required-on-both-textarea-and-pre).

### "Server parse errors flood the UI while I'm typing mid-word"

Your server's format/validation runs on every `phx-change` event with partial input. Gate it on tree-sitter's `hasError` — server-side (via `localize_mf2_treesitter_server`) or client-side (forwarded via `mf2-diagnostics` as shown above).

### "Everything works in Chrome but not in Safari / iOS"

Check that the `-webkit-text-decoration-*` CSS is present (above) and that your Safari is 14 or newer. If on older Safari, wavy styling fails; fall back to a solid underline or a background tint.

## Status and roadmap

Early — the hook does highlighting, diagnostics, scroll sync, and server-push text replacement, which is enough to reproduce the playground's current UX without the per-keystroke server round trip. Features that would need a full editor framework (bracket matching, autocompletion, structural navigation, code folding) are a separate track — consider a CodeMirror 6 integration with the same grammar if you need them.

Planned:

* Optional built-in diagnostics-forwarding hook (rather than the boilerplate shown above).
* `Plug.Static` convenience helper so consumers don't have to repeat the declaration.
* Pre-rendered SSR helper for initial paint (right now that's the consumer's responsibility via their own `Mf2Highlighter.highlight/1`-style function).

## Licence

Apache-2.0 for this package. Third-party notices in [`LICENSE.md`](./LICENSE.md).
