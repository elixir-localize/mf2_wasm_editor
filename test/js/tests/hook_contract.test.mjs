// Layer 2 — Hook contract.
//
// Drives the actual `mf2_editor.js` module against a minimal DOM
// stub. Verifies that:
//
//   * Importing the module registers MF2Editor on
//     window.Mf2WasmEditor.Hooks.
//   * A fresh MF2Editor instance mounts against a pre/textarea pair.
//   * update() repaints the <pre> with token spans for valid input.
//   * update() marks spans with mf2-diag-error / mf2-diag-missing
//     for invalid input.
//   * The mf2-diagnostics CustomEvent is dispatched with the
//     documented detail shape.
//
// These tests stub only the DOM APIs the hook actually uses, so a
// hook change that calls a new DOM API fails visibly (rather than
// silently reaching for something we forgot to stub).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const priv = resolve(here, "..", "..", "..", "priv", "static");

// ── DOM stubs ────────────────────────────────────────────────────
//
// We only need the surface the hook touches: element refs + value
// + innerHTML + a subset of event wiring. When the hook reaches for
// something we don't stub, Node throws a clear TypeError that the
// failing test names directly.

function makeStubElement(overrides = {}) {
  return {
    value: "",
    innerHTML: "",
    textContent: "",
    dataset: {},
    style: {},
    classList: {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false,
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    getBoundingClientRect: () => ({
      top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0,
      x: 0, y: 0, toJSON: () => ({}),
    }),
    focus: () => {},
    blur: () => {},
    setSelectionRange: () => {},
    selectionStart: 0,
    selectionEnd: 0,
    ...overrides,
  };
}

function makeHookElement({ initialMessage }) {
  const pre = makeStubElement();
  const code = makeStubElement();
  pre.querySelector = (sel) => (sel === "code" ? code : null);

  const textarea = makeStubElement({ value: initialMessage });
  textarea.tagName = "TEXTAREA";

  // Absolute on-disk path as baseUrl — the hook concatenates
  // `${baseUrl}/tree-sitter-mf2.wasm` etc. Our stubbed fetch below
  // strips any `file://` prefix before reading, so this resolves
  // the same way the browser does for an HTTP URL.
  const hookEl = makeStubElement({
    dataset: { mf2BaseUrl: priv },
    dispatchedEvents: [],
  });
  hookEl.dispatchEvent = (ev) => {
    hookEl.dispatchedEvents.push(ev);
    return true;
  };

  hookEl.querySelector = (sel) => {
    if (sel === "pre") return pre;
    if (sel === "textarea") return textarea;
    return null;
  };

  return { hookEl, pre, code, textarea };
}

// ── Global setup: import the module under test once ─────────────
//
// ESM imports are cached, so we can only evaluate mf2_editor.js
// once per test process. The hook registers itself on
// `window.Mf2WasmEditor.Hooks` as a module side-effect. A single
// `test.before()` sets up all the globals the module expects and
// imports it; later tests reuse the same namespace.

let ns; // populated by test.before

test.before(async () => {
  // Fake `window` + `document` so the module can evaluate. The
  // module touches just these surfaces during import.
  globalThis.window = { Mf2WasmEditor: {} };

  const listeners = new Map();
  globalThis.document = {
    addEventListener: (ev, cb) => {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(cb);
    },
    removeEventListener: () => {},
    body: makeStubElement(),
    createElement: () => makeStubElement(),
  };

  // fetch() for highlights.scm — intercept `file://` URLs against
  // the real on-disk file (Node's built-in fetch rejects file://).
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^file:\/\//, "");
    const body = await readFile(path, "utf8");
    return { ok: true, status: 200, text: async () => body };
  };

  globalThis.CustomEvent =
    globalThis.CustomEvent ||
    class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
        this.bubbles = init.bubbles ?? false;
      }
    };

  const modulePath = resolve(priv, "mf2_editor.js");
  await import(`file://${modulePath}`);
  ns = globalThis.window.Mf2WasmEditor;
});

// ── Tests ────────────────────────────────────────────────────────

test("importing the module registers MF2Editor on window.Mf2WasmEditor.Hooks", () => {
  assert.ok(ns.Hooks, "window.Mf2WasmEditor.Hooks missing after import");
  assert.equal(
    typeof ns.Hooks.MF2Editor,
    "object",
    "window.Mf2WasmEditor.Hooks.MF2Editor should be a hook object",
  );
  assert.equal(
    typeof ns.Hooks.MF2Editor.mounted,
    "function",
    "hook is missing mounted() — it's not a valid LiveView hook",
  );
});

test("mounting a hook against a real pre/textarea parses the initial value", async () => {
  const MF2Editor = ns.Hooks.MF2Editor;

  const { hookEl, pre, textarea } = makeHookElement({
    initialMessage: ".local $x = {$y :number}\n{{Count: {$x}}}",
  });

  // Build a hook instance by cloning the prototype and wiring el.
  const hook = Object.create(MF2Editor);
  hook.el = hookEl;
  // LiveView normally provides these on the hook instance.
  hook.handleEvent = () => {};
  hook.pushEvent = () => {};

  await hook.mounted();

  // After mount, the hook should have:
  //   * a compiled language + query
  //   * a parser
  //   * a tree derived from textarea.value
  // Mount finishes asynchronously (WASM load); the call above awaits it.
  assert.ok(hook.language, "hook.language not populated after mount");
  assert.ok(hook.parser, "hook.parser not populated after mount");
  assert.ok(hook.tree, "hook.tree not populated after mount");

  // The <code> element should have been painted with highlighted HTML.
  assert.ok(
    pre.innerHTML.length > 0,
    "pre.innerHTML is empty after mount — the hook didn't paint",
  );
  assert.match(
    pre.innerHTML,
    /class="mf2-/,
    "painted HTML has no mf2-* classes — highlight pass didn't run",
  );
});

test("update() repaints when the textarea changes, including invalid input", async () => {
  const MF2Editor = ns.Hooks.MF2Editor;

  const { hookEl, pre, textarea } = makeHookElement({
    initialMessage: "Hello",
  });
  const hook = Object.create(MF2Editor);
  hook.el = hookEl;
  // LiveView normally provides these on the hook instance.
  hook.handleEvent = () => {};
  hook.pushEvent = () => {};
  await hook.mounted();

  // Simulate the user typing a broken placeholder.
  textarea.value = "Hello {$na";
  await hook.update();

  assert.match(
    pre.innerHTML,
    /mf2-diag-(error|missing)/,
    "invalid input didn't surface a diagnostic span — " +
      "expected class mf2-diag-error or mf2-diag-missing on some span",
  );
});

test("mf2-diagnostics CustomEvent fires with the documented detail shape", async () => {
  const MF2Editor = ns.Hooks.MF2Editor;

  const { hookEl, textarea } = makeHookElement({
    initialMessage: "valid",
  });
  const hook = Object.create(MF2Editor);
  hook.el = hookEl;
  // LiveView normally provides these on the hook instance.
  hook.handleEvent = () => {};
  hook.pushEvent = () => {};
  await hook.mounted();

  // Clear the events from the initial paint so we only inspect
  // what update() emits.
  hookEl.dispatchedEvents.length = 0;

  textarea.value = "Hello {$";  // deliberate parse error
  await hook.update();

  const diagEvents = hookEl.dispatchedEvents.filter(
    (e) => e.type === "mf2-diagnostics",
  );
  assert.ok(
    diagEvents.length > 0,
    "no mf2-diagnostics event dispatched for invalid input",
  );

  const detail = diagEvents[diagEvents.length - 1].detail;
  assert.ok(Array.isArray(detail), "event detail should be an array");
  assert.ok(
    detail.length > 0,
    "detail array is empty — diagnostics weren't reported",
  );

  for (const d of detail) {
    assert.ok(["error", "missing"].includes(d.kind), `bad kind: ${d.kind}`);
    assert.equal(typeof d.startByte, "number");
    assert.equal(typeof d.endByte, "number");
    assert.equal(typeof d.message, "string");
    assert.ok(Array.isArray(d.startPoint));
    assert.ok(Array.isArray(d.endPoint));
  }
});
