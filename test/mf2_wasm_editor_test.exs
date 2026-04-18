defmodule Mf2WasmEditorTest do
  use ExUnit.Case, async: true
  doctest Mf2WasmEditor

  describe "script_tags/1" do
    test "defaults to /mf2_editor base URL" do
      html = Mf2WasmEditor.script_tags()
      assert html =~ ~s(src="/mf2_editor/tree-sitter.js")
      assert html =~ ~s(src="/mf2_editor/mf2_editor.js")
      assert html =~ "defer"
    end

    test "respects a custom base_url" do
      html = Mf2WasmEditor.script_tags(base_url: "/assets/mf2")
      assert html =~ ~s(src="/assets/mf2/tree-sitter.js")
      refute html =~ "/mf2_editor/"
    end
  end

  describe "static_paths/0" do
    test "lists the files needed to run the hook in the browser" do
      paths = Mf2WasmEditor.static_paths()

      for required <- ~w(mf2_editor.js tree-sitter.js tree-sitter.wasm
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
