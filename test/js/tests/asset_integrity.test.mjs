// Layer 1 — Asset integrity.
//
// Verifies the three vendored assets under `priv/static/` load and
// interoperate correctly:
//
//   * `web-tree-sitter.js` + `web-tree-sitter.wasm` — the runtime
//   * `tree-sitter-mf2.wasm`                       — the grammar
//   * `highlights.scm`                             — the query
//
// This is the test that would have caught the 0.1.0 release bug
// (runtime ABI 14 + grammar ABI 15 + incompatible query parser).
// If any of these drift against each other, `Parser.init()`,
// `Language.load()`, or `new Query(lang, source)` throws — and the
// test fails immediately.
//
// Run with `npm test` (from this directory) or via the umbrella
// `mix test` task in the parent mix project.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  Parser,
  Language,
  Query,
  LANGUAGE_VERSION,
  MIN_COMPATIBLE_VERSION,
} from "web-tree-sitter";

const here = dirname(fileURLToPath(import.meta.url));
const priv = resolve(here, "..", "..", "..", "priv", "static");

const PRIV_RUNTIME_JS = resolve(priv, "web-tree-sitter.js");
const PRIV_RUNTIME_WASM = resolve(priv, "web-tree-sitter.wasm");
const GRAMMAR_WASM = resolve(priv, "tree-sitter-mf2.wasm");
const HIGHLIGHTS = resolve(priv, "highlights.scm");

// Sample messages for parse tests. Chosen to exercise the full
// grammar surface — declarations, matchers, variants, placeholders,
// markup, attributes, literals, escapes.
const VALID_MESSAGES = [
  "Hello, world!",
  "Hello {$name}",
  ".local $x = {$y :number}\n{{Count: {$x}}}",
  ".input {$count :number}\n.match $count\n1 {{one}}\n* {{other}}",
  "{#bold}hello{/bold}",
  "{|escaped \\| pipe|}",
];

const INVALID_MESSAGES = [
  "Hello {$",                          // unclosed placeholder
  ".match $x\n{{no key}}",             // missing variant key
  ".match\n1 {{one}}",                 // missing selector
  "{{",                                // unclosed quoted pattern
];

// ── Cache runtime+language across tests ───────────────────────────

let lang;
let query;

test.before(async () => {
  await Parser.init();
  lang = await Language.load(GRAMMAR_WASM);
  const src = await readFile(HIGHLIGHTS, "utf8");
  query = new Query(lang, src);
});

// ── Bundled runtime matches what the tests are built against ──────

test("vendored web-tree-sitter matches the pinned devDep byte-for-byte", async () => {
  // Guarantees that the runtime we ship IS the one the tests exercise.
  // Without this, the tests could pass against one runtime while the
  // shipped tarball contained a different (broken) one.
  const devdepRoot = resolve(here, "..", "node_modules", "web-tree-sitter");

  for (const file of ["web-tree-sitter.js", "web-tree-sitter.wasm"]) {
    const shipped = await readFile(resolve(priv, file));
    const devdep = await readFile(resolve(devdepRoot, file));
    const a = createHash("sha256").update(shipped).digest("hex");
    const b = createHash("sha256").update(devdep).digest("hex");

    assert.equal(
      a,
      b,
      `${file} drift: shipped ${a.slice(0, 16)}… ≠ devDep ${b.slice(0, 16)}…. ` +
        "Re-vendor from `node_modules/web-tree-sitter/` or bump the " +
        "devDep in test/js/package.json to match the shipped runtime.",
    );
  }
});

// ── Runtime + language load ──────────────────────────────────────

test("Language.load resolves the grammar WASM", () => {
  assert.ok(lang, "Language.load returned falsy");
  assert.equal(
    typeof lang.nodeTypeForId,
    "function",
    "loaded Language is missing expected instance methods — ABI mismatch?",
  );
  assert.ok(
    lang.nodeTypeCount > 0,
    "loaded Language reports zero node types — grammar WASM may be empty",
  );
});

test("Language advertises an ABI version we understand", () => {
  // The loaded Language's ABI must fall in the runtime's supported
  // range. This catches the specific failure mode that shipped in
  // mf2_wasm_editor 0.1.0: grammar compiled at ABI 15 against a
  // runtime that topped out at ABI 14.
  assert.ok(
    lang.abiVersion >= MIN_COMPATIBLE_VERSION && lang.abiVersion <= LANGUAGE_VERSION,
    `grammar ABI ${lang.abiVersion} outside supported range ` +
      `[${MIN_COMPATIBLE_VERSION}, ${LANGUAGE_VERSION}]`,
  );
});

// ── Query compile ────────────────────────────────────────────────

test("highlights.scm compiles against the grammar", () => {
  assert.ok(query, "Query construction returned falsy");
  assert.ok(
    query.captureNames.length > 0,
    "Query reports zero capture names — highlights.scm may be empty " +
      "or the compile silently matched nothing",
  );
});

test("highlights.scm declares the canonical capture names", () => {
  // These are the capture names the `mf2_wasm_editor` CSS themes
  // target. If a grammar bump renames a node type, the query would
  // stop emitting some of these and the editor would silently lose
  // colour for that class of tokens.
  const expected = [
    "variable",
    "function",
    "keyword",
    "string",
    "number",
    "tag",
    "attribute",
    "property",
  ];

  for (const name of expected) {
    assert.ok(
      query.captureNames.includes(name),
      `expected capture "${name}" missing from highlights.scm — ` +
        `got: ${query.captureNames.join(", ")}`,
    );
  }
});

// ── End-to-end parse + capture ───────────────────────────────────

test("every canonical valid message parses without errors", () => {
  const parser = new Parser();
  parser.setLanguage(lang);

  for (const src of VALID_MESSAGES) {
    const tree = parser.parse(src);
    assert.equal(
      tree.rootNode.hasError,
      false,
      `valid message unexpectedly has errors: ${JSON.stringify(src)}\n` +
        `tree: ${tree.rootNode.toString()}`,
    );
  }
});

test("every canonical invalid message produces errors", () => {
  const parser = new Parser();
  parser.setLanguage(lang);

  for (const src of INVALID_MESSAGES) {
    const tree = parser.parse(src);
    assert.equal(
      tree.rootNode.hasError,
      true,
      `invalid message unexpectedly accepted: ${JSON.stringify(src)}`,
    );
  }
});

test("captures run against a real tree return expected tokens", () => {
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse("Hello {$name :number}");
  const caps = query.captures(tree.rootNode);

  const variableCaptures = caps
    .filter((c) => c.name === "variable")
    .map((c) => c.node.text);
  assert.deepEqual(
    variableCaptures,
    ["name"],
    "expected the $name variable to be captured",
  );

  const functionCaptures = caps
    .filter((c) => c.name === "function")
    .map((c) => c.node.text);
  assert.deepEqual(
    functionCaptures,
    ["number"],
    "expected :number to be captured as function",
  );
});
