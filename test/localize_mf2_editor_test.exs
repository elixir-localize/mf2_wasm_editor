defmodule LocalizeMf2EditorTest do
  use ExUnit.Case, async: true
  doctest LocalizeMf2Editor

  describe "script_tags/1" do
    test "defaults to /mf2_editor base URL" do
      html = LocalizeMf2Editor.script_tags()
      assert html =~ ~s(src="/mf2_editor/tree-sitter.js")
      assert html =~ ~s(src="/mf2_editor/mf2_editor.js")
      assert html =~ "defer"
    end

    test "respects a custom base_url" do
      html = LocalizeMf2Editor.script_tags(base_url: "/assets/mf2")
      assert html =~ ~s(src="/assets/mf2/tree-sitter.js")
      refute html =~ "/mf2_editor/"
    end
  end

  describe "static_paths/0" do
    test "lists the files needed to run the hook in the browser" do
      paths = LocalizeMf2Editor.static_paths()

      for required <- ~w(mf2_editor.js tree-sitter.js tree-sitter.wasm
                          tree-sitter-mf2.wasm highlights.scm injections.scm) do
        assert required in paths
      end
    end

    test "every listed file actually exists in priv/static" do
      priv = :code.priv_dir(:localize_mf2_editor)

      for path <- LocalizeMf2Editor.static_paths() do
        assert File.exists?(Path.join([priv, "static", path])),
               "missing shipped asset: priv/static/#{path}"
      end
    end
  end
end
