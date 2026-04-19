defmodule Mf2WasmEditorTest do
  use ExUnit.Case, async: true
  doctest Mf2WasmEditor

  describe "script_tags/1" do
    test "defaults to /mf2_editor base URL and emits a module script" do
      html = Mf2WasmEditor.script_tags()
      assert html =~ ~s(src="/mf2_editor/mf2_editor.js")
      assert html =~ ~s(type="module")
    end

    test "respects a custom base_url" do
      html = Mf2WasmEditor.script_tags(base_url: "/assets/mf2")
      assert html =~ ~s(src="/assets/mf2/mf2_editor.js")
      refute html =~ "/mf2_editor/"
    end

    test "single tag only — the ES module imports web-tree-sitter itself" do
      html = Mf2WasmEditor.script_tags()
      # Must not emit a separate runtime loader script — the module's
      # import graph handles it. Two <script> tags would be a regression
      # to the pre-0.2 loading model and would double-load the runtime.
      assert html |> String.split("<script") |> length() == 2
    end
  end

  describe "static_paths/0" do
    test "lists the files needed to run the hook in the browser" do
      paths = Mf2WasmEditor.static_paths()

      for required <- ~w(mf2_editor.js web-tree-sitter.js web-tree-sitter.wasm
                          tree-sitter-mf2.wasm highlights.scm) do
        assert required in paths
      end
    end

    test "every listed file actually exists in priv/static" do
      priv = :code.priv_dir(:mf2_wasm_editor)

      for path <- Mf2WasmEditor.static_paths() do
        assert File.exists?(Path.join([priv, "static", path])),
               "missing shipped asset: priv/static/#{path}"
      end
    end
  end
end
