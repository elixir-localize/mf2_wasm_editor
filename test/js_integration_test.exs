defmodule Mf2WasmEditor.JsIntegrationTest do
  @moduledoc """
  Shells out to the Node-based JS test suite under `test/js/`.

  The browser hook, the vendored `web-tree-sitter` runtime, the
  grammar WASM, and the highlight query all ship together in
  `priv/static/`. Elixir tests can't exercise them end-to-end (they
  live in JS-land), so we run `node --test` over the matching
  Node suite. That suite:

    * verifies the shipped `web-tree-sitter.{js,wasm}` match the
      pinned devDep byte-for-byte (catches drift),
    * loads `tree-sitter-mf2.wasm` via the shipped runtime and
      compiles `highlights.scm` — the exact three-way handshake
      that broke in `0.1.0`,
    * imports `mf2_editor.js` as an ES module and drives the
      hook's `mounted/0` and `update/0` against a DOM stub,
      confirming the documented paint + diagnostics contract.

  If any step fails, the stderr gets piped into the ExUnit
  failure message so `mix test` output shows the real error.

  The test is tagged `:js_integration` and gated on `node` +
  `npm` being on PATH; skipped otherwise so contributors without
  a Node toolchain still get a clean `mix test`.
  """
  use ExUnit.Case, async: false

  @moduletag :js_integration

  @js_test_dir Path.expand("js", __DIR__)

  setup_all do
    unless node_available?() do
      raise ExUnit.AssertionError, "`node` not found on PATH — install Node.js 20+ to run the JS test suite"
    end

    unless npm_available?() do
      raise ExUnit.AssertionError, "`npm` not found on PATH — needed to install the test suite's devDeps"
    end

    unless File.dir?(Path.join(@js_test_dir, "node_modules")) do
      {out, 0} = System.cmd("npm", ["install", "--silent"], cd: @js_test_dir, stderr_to_stdout: true)
      _ = out
    end

    :ok
  end

  test "the JS test suite passes" do
    {output, exit_code} =
      System.cmd("npm", ["test", "--silent"],
        cd: @js_test_dir,
        stderr_to_stdout: true,
        env: [{"NODE_NO_WARNINGS", "1"}]
      )

    assert exit_code == 0, """
    Node test suite failed (exit #{exit_code}):

    #{output}

    Reproduce locally with:

        cd test/js && npm test
    """
  end

  defp node_available?, do: safe_cmd?("node")
  defp npm_available?, do: safe_cmd?("npm")

  defp safe_cmd?(bin) do
    match?({_, 0}, System.cmd(bin, ["--version"], stderr_to_stdout: true))
  rescue
    ErlangError -> false
  end
end
