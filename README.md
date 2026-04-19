# mf2_wasm_editor

Browser-side syntax highlighter and IDE-style editor for [ICU MessageFormat 2.0](https://unicode.org/reports/tr35/tr35-messageFormat.html) (MF2) messages. Drop-in [Phoenix LiveView](https://github.com/phoenixframework/phoenix_live_view) hook.

The hook runs the [`mf2_treesitter`](https://github.com/elixir-localize/mf2_treesitter) grammar directly in the browser via [`web-tree-sitter`](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web). Keystrokes are highlighted and diagnostics surface without leaving the client — no server round trip per edit. The server stays in the loop only for authoritative operations (formatting, validation, persistence) that it actually owns.

## What ships in this package

Three browser-side artefacts plus the Elixir glue to serve them:

1. **Web-tree-sitter runtime** (`tree-sitter.js`, `tree-sitter.wasm`) — vendored from the `web-tree-sitter` npm package, MIT-licensed.
2. **Compiled MF2 grammar** (`tree-sitter-mf2.wasm`) — vendored from the [`tree-sitter-mf2`](https://www.npmjs.com/package/tree-sitter-mf2) npm package.
3. **LiveView hook** (`mf2_editor.js`) — the IDE-style editor runtime. Parse-and-paint on every keystroke with diagnostics, auto-close, bracket matching, tooltips, goto-definition, rename-in-scope, outline picker, structural selection, smart indent, completion, `.match` pluralisation skeletons, and server-push text replacement. Full list in the [features guide](https://hexdocs.pm/mf2_wasm_editor/features.html).

Plus 30 drop-in colour themes under `priv/themes/` and the `mix mf2_wasm_editor.sync` task that keeps the vendored grammar in step with a pinned `tree-sitter-mf2` npm release.

Sibling packages cover the rest of the MF2 ecosystem:

* [`mf2_treesitter`](https://github.com/elixir-localize/mf2_treesitter) — the grammar itself (published on npm as `tree-sitter-mf2`).
* [`localize_mf2_treesitter`](https://github.com/elixir-localize/localize_mf2_treesitter) — server-side MF2 parsing in Elixir (NIF).
* [`mf2_editor_extensions`](https://github.com/elixir-localize/mf2_editor_extensions) — Zed / Helix / Neovim / VS Code / Emacs / Vim integrations.

This package is ecosystem-neutral — it doesn't depend on the Localize hex package. It works for any Phoenix LiveView app editing MF2 messages.

## Installation

```elixir
def deps do
  [
    {:mf2_wasm_editor, "~> 0.1"}
  ]
end
```

No compile-time toolchain is required for consumers — the WASM artefacts and JS hook are pre-built and shipped.

## Quick start

```elixir
# endpoint.ex — serve the hook's static assets
plug Plug.Static,
  at: "/mf2_editor",
  from: {:mf2_wasm_editor, "priv/static"},
  gzip: false,
  only: Mf2WasmEditor.static_paths()
```

```heex
<%!-- root layout: MUST come before app.js --%>
{raw(Mf2WasmEditor.script_tags())}
```

```js
// assets/js/app.js — merge the hook into LiveSocket
const Hooks = Object.assign({}, window.Mf2WasmEditor?.Hooks || {})
const liveSocket = new LiveSocket("/live", Socket, {hooks: Hooks, ...})
```

```heex
<%!-- any LiveView template --%>
<div phx-hook="MF2Editor" id="my-editor">
  <pre class="mf2-highlight" aria-hidden="true" phx-update="ignore" id="my-editor-pre"><code></code></pre>
  <textarea name="message" phx-update="ignore" phx-debounce="100" rows="8" spellcheck="false">{@message}</textarea>
</div>
```

Add the [monokai theme](https://hexdocs.pm/mf2_wasm_editor/features.html#themes) (or one of 29 others) for colour, and you're done.

## Guides

* [**Wiring**](https://hexdocs.pm/mf2_wasm_editor/wiring.html) — full setup recipe, configuration, caveats, server-side diagnostics integration, grammar refresh workflow, troubleshooting.
* [**Features**](https://hexdocs.pm/mf2_wasm_editor/features.html) — editing features and keyboard bindings, CSS class reference, themes and how to customise them.

## Status

Reasonably complete for an in-textarea editor. The hook is 100%-conformant against the MF2 WG syntax test suite, and the IDE-style layer covers most of what a translator or developer expects.

## Licence

Apache-2.0 for this package. Third-party notices in [`LICENSE.md`](https://github.com/elixir-localize/mf2_wasm_editor/blob/v0.1.0/LICENSE.md).
