defmodule Mf2WasmEditor do
  @moduledoc """
  Browser-side MF2 syntax highlighter for Phoenix LiveView apps.

  Ships three things:

    * The web-tree-sitter runtime (`web-tree-sitter.js` + `.wasm`).
    * The compiled `tree-sitter-mf2` grammar (`tree-sitter-mf2.wasm`).
    * A Phoenix LiveView hook (`mf2_editor.js`) that wires a
      transparent textarea + highlighted `<pre>` into the grammar,
      highlighting and surfacing diagnostics on every keystroke —
      with no server round trip.

  The hook is an ES module that imports web-tree-sitter directly.
  One `<script type="module">` tag loads both.

  ## Wiring up a host app

      # endpoint.ex
      plug Plug.Static,
        at: "/mf2_editor",
        from: {:mf2_wasm_editor, "priv/static"},
        gzip: false,
        only: Mf2WasmEditor.static_paths()

      # root layout (HEEx)
      {raw(Mf2WasmEditor.script_tags())}

      # app.js
      const Hooks = Object.assign({}, window.Mf2WasmEditor?.Hooks || {})
      new LiveSocket("/live", Socket, {hooks: Hooks, params: {...}})

      # any LiveView template
      <div phx-hook="MF2Editor" id="my-editor">
        <pre aria-hidden="true" phx-update="ignore"><code></code></pre>
        <textarea name="message" phx-update="ignore"></textarea>
      </div>

  The hook reads and writes `textarea.value` directly. The server sees
  the text through the form's ordinary `phx-change` event — no
  additional plumbing. Server-initiated text changes (e.g. loading a
  saved example) must use `push_event/3` to dispatch `mf2:set_message`
  with a `%{value: string}` payload, since `phx-update="ignore"`
  prevents LiveView from overwriting the textarea directly.
  """

  @doc """
  Emit the `<script>` tag needed to load the editor.

  The output is a raw HTML string. In a HEEx template wrap with
  `Phoenix.HTML.raw/1` (or `{raw(...)}` in HEEx 1.1+).

  The emitted tag uses `type="module"` because `mf2_editor.js` is an
  ES module that imports web-tree-sitter directly. There is no
  longer a separate runtime loader script — the module handles
  loading the runtime as part of its own import graph.

  ### Options

  * `:base_url` — URL prefix where the package's assets are served.
    Must match the `:at` option of your `Plug.Static` declaration.
    Defaults to `"/mf2_editor"`.

  ### Examples

      iex> Mf2WasmEditor.script_tags()
      ~s(<script type="module" src="/mf2_editor/mf2_editor.js"></script>)

      iex> Mf2WasmEditor.script_tags(base_url: "/assets/mf2")
      ~s(<script type="module" src="/assets/mf2/mf2_editor.js"></script>)

  """
  @spec script_tags(keyword()) :: binary()
  def script_tags(options \\ []) do
    base_url = Keyword.get(options, :base_url, "/mf2_editor")

    ~s(<script type="module" src="#{base_url}/mf2_editor.js"></script>)
  end

  @doc """
  File names served from `priv/static/`. Pass to
  `Plug.Static`'s `:only` option so nothing else in the package is
  exposed.

  ### Examples

      iex> Mf2WasmEditor.static_paths()
      ["highlights.scm", "mf2_editor.js", "tree-sitter-mf2.wasm",
       "web-tree-sitter.js", "web-tree-sitter.wasm"]

  """
  @spec static_paths() :: [String.t()]
  def static_paths do
    ~w(highlights.scm mf2_editor.js tree-sitter-mf2.wasm
       web-tree-sitter.js web-tree-sitter.wasm)
  end
end
