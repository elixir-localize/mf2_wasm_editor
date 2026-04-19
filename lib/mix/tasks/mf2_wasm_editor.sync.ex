defmodule Mix.Tasks.Mf2WasmEditor.Sync do
  @moduledoc """
  Sync the vendored grammar + WASM + queries from the published
  [`tree-sitter-mf2`](https://www.npmjs.com/package/tree-sitter-mf2)
  npm package.

  This package embeds the MF2 grammar as browser-facing artefacts:

    * **WASM** (`priv/static/tree-sitter-mf2.wasm`) — what the
      `web-tree-sitter` runtime actually loads.

    * **Queries** (`priv/static/highlights.scm`) — fetched at
      runtime by the JS hook.

    * **Grammar source** (`priv/grammar/`) — parser.c, parser.h,
      grammar.json, node-types.json, grammar.js. Kept alongside so
      the WASM can be regenerated locally with `--build-wasm`.

  The canonical source is the npm package, pinned to an exact
  version at the top of this module (`@tree_sitter_mf2_version`).
  Bump that string and re-run the task to move to a new grammar
  release. Keep the pin in step with `localize_mf2_treesitter`'s
  own sync task — tree shape is the API boundary between
  server-side parse (NIF) and browser-side parse (WASM editor); a
  version skew can produce different trees for the same input.

  ## Usage

      # Fetch from npm at the pinned version and update local files.
      mix mf2_wasm_editor.sync

      # Fail (exit 1) if anything has drifted from the pinned
      # version; do not modify files. Intended for CI.
      mix mf2_wasm_editor.sync --check

      # Additionally rebuild priv/static/tree-sitter-mf2.wasm from
      # the vendored grammar instead of using the prebuilt .wasm
      # shipped in the npm tarball. Requires a local `mf2_treesitter`
      # checkout (via MF2_TREESITTER_DIR) with `npm install` already
      # run, plus emcc / docker / podman on PATH.
      mix mf2_wasm_editor.sync --build-wasm

  ## Offline / local-iteration override

  If you're iterating on the grammar locally and want this task to
  read from a sibling checkout rather than hit the network, set
  `MF2_TREESITTER_DIR`:

      MF2_TREESITTER_DIR=/path/to/mf2_treesitter mix mf2_wasm_editor.sync

  With that set, file layouts must match the npm package layout
  (which also matches the repo layout): `grammar.js` at the root,
  `src/parser.c`, `queries/highlights.scm`, `wasm/tree-sitter-mf2.wasm`.
  """
  use Mix.Task

  @shortdoc "Sync the vendored tree-sitter-mf2 grammar + WASM + queries from npm."

  # Pinned tree-sitter-mf2 version. Bump and re-run the task to
  # pull a newer grammar.
  @tree_sitter_mf2_version "0.1.4"

  # unpkg.com proxies the npm registry and serves individual files
  # from a package tarball over HTTPS at stable URLs. The only
  # requirement is that the package has actually been published.
  @cdn_base "https://unpkg.com/tree-sitter-mf2@#{@tree_sitter_mf2_version}"

  # Files to sync. Each tuple is `{source_rel, dest_rel}` — source
  # relative to the package root (same under both npm and the repo),
  # dest relative to this package's priv/ directory.
  @grammar_files [
    {"grammar.js", "grammar/grammar.js"},
    {"src/grammar.json", "grammar/src/grammar.json"},
    {"src/node-types.json", "grammar/src/node-types.json"},
    {"src/parser.c", "grammar/src/parser.c"},
    {"src/tree_sitter/parser.h", "grammar/src/tree_sitter/parser.h"}
  ]

  @query_files [
    {"queries/highlights.scm", "static/highlights.scm"}
  ]

  @wasm_files [
    {"wasm/tree-sitter-mf2.wasm", "static/tree-sitter-mf2.wasm"}
  ]

  @switches [check: :boolean, build_wasm: :boolean]

  @impl Mix.Task
  def run(argv) do
    {opts, _rest} = OptionParser.parse!(argv, switches: @switches)

    check? = opts[:check] == true
    build_wasm? = opts[:build_wasm] == true

    source = resolve_source()
    priv_dir = priv_dir()

    case source do
      {:cdn, base} ->
        Mix.shell().info("[sync] grammar source: #{base}")

      {:local, path} ->
        Mix.shell().info("[sync] grammar source: #{path} (local override)")
    end

    Mix.shell().info("[sync] package priv:   #{priv_dir}")

    files_to_sync = @grammar_files ++ @query_files

    # When --build-wasm is passed we rebuild locally instead of
    # copying the prebuilt WASM, so skip the WASM copy in that path.
    files_to_sync =
      if build_wasm?, do: files_to_sync, else: files_to_sync ++ @wasm_files

    drift = sync_files(source, priv_dir, files_to_sync, check?)

    cond do
      check? and drift != [] ->
        Mix.shell().error("[sync] drift detected in #{length(drift)} file(s):")

        Enum.each(drift, fn path ->
          Mix.shell().error("  - #{path}")
        end)

        Mix.shell().error("Run `mix mf2_wasm_editor.sync` to update.")
        exit({:shutdown, 1})

      check? ->
        Mix.shell().info(
          "[sync] check: all vendored files match tree-sitter-mf2@#{@tree_sitter_mf2_version}."
        )

      drift == [] ->
        Mix.shell().info("[sync] already in sync; no files changed.")

      true ->
        Mix.shell().info("[sync] updated #{length(drift)} file(s).")
    end

    if build_wasm?, do: build_wasm(priv_dir)

    :ok
  end

  defp sync_files(source, dst_root, pairs, check?) do
    Enum.reduce(pairs, [], fn {src_rel, dst_rel}, acc ->
      bytes = fetch_bytes!(source, src_rel)
      dst_path = Path.join(dst_root, dst_rel)

      if changed?(bytes, dst_path) do
        unless check? do
          File.mkdir_p!(Path.dirname(dst_path))
          File.write!(dst_path, bytes)
          Mix.shell().info("[sync] wrote #{dst_rel}")
        end

        [dst_rel | acc]
      else
        acc
      end
    end)
  end

  defp changed?(new_bytes, dst) do
    cond do
      not File.exists?(dst) -> true
      File.read!(dst) != new_bytes -> true
      true -> false
    end
  end

  # Fetch the raw bytes for one file under the grammar package root.
  # Dispatches on source kind — local checkout copies from disk,
  # CDN mode does a verified HTTPS GET.
  defp fetch_bytes!({:local, dir}, rel) do
    path = Path.join(dir, rel)

    unless File.exists?(path) do
      Mix.raise("missing source file at local override: #{path}")
    end

    File.read!(path)
  end

  defp fetch_bytes!({:cdn, base}, rel) do
    url = "#{base}/#{rel}"
    http_get!(url)
  end

  defp http_get!(url) do
    ensure_http_started()

    url_charlist = String.to_charlist(url)
    request = {url_charlist, [{~c"accept", ~c"*/*"}]}

    case :httpc.request(:get, request, [ssl: ssl_options()], body_format: :binary) do
      {:ok, {{_http, status, _reason}, _headers, body}} when status in 200..299 ->
        body

      {:ok, {{_http, status, reason}, _headers, _body}} ->
        Mix.raise("""
        HTTP #{status} #{reason} from #{url}

        Check that tree-sitter-mf2@#{@tree_sitter_mf2_version} exists on npm
        (https://www.npmjs.com/package/tree-sitter-mf2), or set
        MF2_TREESITTER_DIR to a local checkout to bypass the CDN.
        """)

      {:error, reason} ->
        Mix.raise("""
        HTTP request to #{url} failed: #{inspect(reason)}

        Check your network connection, or set MF2_TREESITTER_DIR to a
        local checkout to bypass the CDN.
        """)
    end
  end

  defp ensure_http_started do
    :ssl.start()
    :inets.start()
  end

  defp ssl_options do
    [
      verify: :verify_peer,
      cacerts: :public_key.cacerts_get(),
      customize_hostname_check: [
        match_fun: :public_key.pkix_verify_hostname_match_fun(:https)
      ]
    ]
  end

  defp build_wasm(priv_dir) do
    grammar_dir = local_checkout_path!("--build-wasm requires a local mf2_treesitter checkout")

    tree_sitter_bin = Path.join([grammar_dir, "node_modules", ".bin", "tree-sitter"])

    unless File.exists?(tree_sitter_bin) do
      Mix.raise("""
      Could not find tree-sitter CLI at #{tree_sitter_bin}.

      Run `npm install` inside #{grammar_dir} first, or set
      MF2_TREESITTER_DIR to a grammar checkout where dependencies are
      installed.
      """)
    end

    output_path = Path.join(priv_dir, "static/tree-sitter-mf2.wasm")
    File.mkdir_p!(Path.dirname(output_path))

    Mix.shell().info("[sync] building tree-sitter-mf2.wasm from #{grammar_dir}")
    Mix.shell().info("[sync] (requires emcc, docker, or podman on PATH)")

    {output, status} =
      System.cmd(tree_sitter_bin, ["build", "--wasm", "--output", output_path],
        cd: grammar_dir,
        stderr_to_stdout: true
      )

    if status == 0 do
      Mix.shell().info("[sync] built #{output_path}")
    else
      Mix.shell().error(output)
      Mix.raise("tree-sitter build --wasm failed (exit #{status})")
    end
  end

  # Returns the source to read files from:
  #   {:local, path} when MF2_TREESITTER_DIR is set (local iteration)
  #   {:cdn, base_url} otherwise (the default, reproducible path)
  defp resolve_source do
    case System.get_env("MF2_TREESITTER_DIR") do
      nil ->
        {:cdn, @cdn_base}

      "" ->
        {:cdn, @cdn_base}

      override ->
        path = Path.expand(override)

        unless File.dir?(path) do
          Mix.raise("MF2_TREESITTER_DIR set but not a directory: #{path}")
        end

        {:local, path}
    end
  end

  # --build-wasm specifically needs a local checkout; the npm
  # tarball doesn't ship the compiled tree-sitter CLI.
  defp local_checkout_path!(message) do
    case System.get_env("MF2_TREESITTER_DIR") do
      nil ->
        Mix.raise(message <> " — set MF2_TREESITTER_DIR=/path/to/mf2_treesitter.")

      "" ->
        Mix.raise(message <> " — set MF2_TREESITTER_DIR=/path/to/mf2_treesitter.")

      override ->
        path = Path.expand(override)

        unless File.dir?(path) do
          Mix.raise("MF2_TREESITTER_DIR set but not a directory: #{path}")
        end

        path
    end
  end

  defp priv_dir do
    Path.join(File.cwd!(), "priv")
  end
end
