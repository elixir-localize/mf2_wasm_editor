/**
 * @file MessageFormat 2 grammar for tree-sitter.
 *
 * Implements the MessageFormat 2 syntax as defined in the Unicode
 * Technical Standard #35 Part 3. The authoritative ABNF lives at:
 *
 *   https://github.com/unicode-org/message-format-wg/blob/main/spec/message.abnf
 *
 * Every production below cross-references the spec. Character ranges
 * are taken from the spec verbatim; the regex forms use the `u` flag
 * and `\u{...}` escapes so supplementary-plane code points work.
 *
 * Whitespace in MF2 has two flavours — `s` (required, must contain at
 * least one `ws` char) and `o` (optional, any mix of `ws` and `bidi`
 * chars including empty). At the lexer level these overlap and having
 * them as distinct tokens confuses tree-sitter, so we expose one
 * `_ws` token accepting any non-empty ws/bidi run and use it with
 * `optional(...)` at `o` positions, bare at `s` positions. See the
 * comment on `_ws` for the (small) resulting over-acceptance.
 *
 * @author Localize contributors
 * @license Apache-2.0
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// ── Character-class helpers ─────────────────────────────────────────
//
// The spec's `name-start` production lists a collection of Unicode
// ranges that carefully exclude controls, whitespace, surrogates,
// bidirectional marks, and non-characters. We encode them as a
// regex character class built from a single string, reused by
// `name` and `unquoted_literal`. Keep the order matching the spec
// so future spec edits are easy to diff against.
const NAME_START_CLASS =
  'A-Za-z' +                   // ALPHA
  '\\u002B' +                  // +
  '\\u005F' +                  // _
  '\\u00A1-\\u061B' +
  '\\u061D-\\u167F' +
  '\\u1681-\\u1FFF' +
  '\\u200B-\\u200D' +
  '\\u2010-\\u2027' +
  '\\u2030-\\u205E' +
  '\\u2060-\\u2065' +
  '\\u206A-\\u2FFF' +
  '\\u3001-\\uD7FF' +
  '\\uE000-\\uFDCF' +
  '\\uFDF0-\\uFFFD' +
  '\\u{10000}-\\u{1FFFD}' +
  '\\u{20000}-\\u{2FFFD}' +
  '\\u{30000}-\\u{3FFFD}' +
  '\\u{40000}-\\u{4FFFD}' +
  '\\u{50000}-\\u{5FFFD}' +
  '\\u{60000}-\\u{6FFFD}' +
  '\\u{70000}-\\u{7FFFD}' +
  '\\u{80000}-\\u{8FFFD}' +
  '\\u{90000}-\\u{9FFFD}' +
  '\\u{A0000}-\\u{AFFFD}' +
  '\\u{B0000}-\\u{BFFFD}' +
  '\\u{C0000}-\\u{CFFFD}' +
  '\\u{D0000}-\\u{DFFFD}' +
  '\\u{E0000}-\\u{EFFFD}' +
  '\\u{F0000}-\\u{FFFFD}' +
  '\\u{100000}-\\u{10FFFD}';

// `name-char = name-start / DIGIT / "-" / "."` — add digits, hyphen, dot.
const NAME_CHAR_CLASS = NAME_START_CLASS + '0-9\\-.';

// `bidi = U+061C / U+200E / U+200F / U+2066-2069`
const BIDI_CLASS = '\\u061C\\u200E\\u200F\\u2066-\\u2069';

// `ws = SP / HTAB / CR / LF / U+3000`
const WS_CLASS = ' \\t\\r\\n\\u3000';
const WS_OR_BIDI = WS_CLASS + BIDI_CLASS;

// Text-char excludes `\` (5C), `{` (7B), `}` (7D); everything else is in.
const TEXT_CHAR_CLASS = '^\\u005C\\u007B\\u007D';

// Quoted-char excludes `\` (5C) and `|` (7C); `{` and `}` are allowed unescaped.
const QUOTED_CHAR_CLASS = '^\\u005C\\u007C';

// Simple-start-char additionally excludes `.` (2E), most controls, whitespace,
// and U+3000. We encode as "text-char minus ws chars minus period".
const SIMPLE_START_CHAR_CLASS =
  '^' +
  '\\u0000-\\u0020' +         // controls + SPACE (incl. TAB, CR, LF)
  '\\u002E' +                 // .
  '\\u005C' +                 // \
  '\\u007B' +                 // {
  '\\u007D' +                 // }
  '\\u3000';                  // IDEOGRAPHIC SPACE

module.exports = grammar({
  name: 'mf2',

  // Whitespace in MF2 is significant inside patterns and tightly
  // controlled inside expressions. We handle every occurrence
  // explicitly rather than letting tree-sitter's `extras` eat it.
  extras: _ => [],

  // Identifiers are the "word" token for keyword disambiguation.
  word: $ => $.name,

  conflicts: $ => [
    // After a match_statement, tree-sitter cannot tell with a
    // single token of lookahead whether the whitespace before the
    // next token is trailing (done with the matcher) or leading
    // (start of another variant). GLR explores both.
    [$.matcher],

    // Similarly inside match_statement itself — one more selector,
    // or transition to the variant list?
    [$.match_statement],

    // After a function's identifier, a following `_ws` could lead
    // into another option of this function OR end the function and
    // begin the next position in the surrounding expression (a
    // `_ws attribute`, or the closing `}`). GLR explores both.
    [$.function],

    // Attribute is `@ identifier [_ws "=" _ws literal]`. After the
    // identifier, a following `_ws` might be the start of the
    // optional `= literal` extension OR the trailing whitespace
    // before another attribute / closing brace of the outer
    // expression. Both paths are explored by GLR.
    [$.attribute],
  ],

  rules: {
    // ── Root ────────────────────────────────────────────────────────
    //
    // source-file is our entry point and is allowed to match the empty
    // string (tree-sitter special-cases the start rule). Per spec,
    // both `simple-message` and `complex-message` are wrapped in `o`
    // whitespace; we hoist the outer `o` to source_file so the inner
    // rules always have content.
    source_file: $ => seq(
      optional($._ws),
      optional($.message),
      optional($._ws),
    ),

    message: $ => choice(
      // Prefer complex when both could match the input (i.e. the
      // input begins with `.input`, `.local`, `.match`, or `{{`).
      prec(2, $.complex_message),
      prec(1, $.simple_message),
    ),

    // ── Simple message ──────────────────────────────────────────────
    //
    // simple-message = o [simple-start pattern]
    // simple-start   = simple-start-char / escaped-char / placeholder
    //
    // The leading `o` is hoisted to source_file. simple_message here
    // is the `[simple-start pattern]` portion only.
    simple_message: $ => seq(
      $._simple_start,
      optional($._pattern_tail),
    ),

    _simple_start: $ => choice(
      alias($.text_start, $.text),
      $.escape,
      $.placeholder,
    ),

    // simple-start-char as above. After the first char, text-char
    // rules apply (more permissive), so the tail of the initial text
    // run is `[text-char]*`.
    text_start: _ => token(
      new RegExp(`[${SIMPLE_START_CHAR_CLASS}][${TEXT_CHAR_CLASS}]*`, 'u')
    ),

    _pattern_tail: $ => repeat1(choice(
      $.text,
      $.escape,
      $.placeholder,
    )),

    // ── Complex message ─────────────────────────────────────────────
    //
    // complex-message = o *(declaration o) complex-body o
    //
    // Leading and trailing `o` are hoisted to source_file. complex_message
    // here is `*(declaration o) complex-body` only.
    complex_message: $ => seq(
      repeat(seq($.declaration, optional($._ws))),
      choice($.quoted_pattern, $.matcher),
    ),

    quoted_pattern: $ => seq(
      '{{',
      repeat(choice($.text, $.escape, $.placeholder)),
      '}}',
    ),

    // ── Declarations ────────────────────────────────────────────────
    //
    // declaration       = input-declaration / local-declaration
    // input-declaration = input o variable-expression
    // local-declaration = local s variable o "=" o expression
    declaration: $ => choice(
      $.input_declaration,
      $.local_declaration,
    ),

    input_declaration: $ => seq(
      alias(token('.input'), $.keyword_input),
      optional($._ws),
      $.variable_expression,
    ),

    local_declaration: $ => seq(
      alias(token('.local'), $.keyword_local),
      $._ws,
      $.variable,
      optional($._ws),
      '=',
      optional($._ws),
      $.expression,
    ),

    // ── Matcher ─────────────────────────────────────────────────────
    //
    // matcher         = match-statement s variant *(o variant)
    // match-statement = match 1*(s selector)
    // selector        = variable
    // variant         = key *(s key) o quoted-pattern
    matcher: $ => seq(
      $.match_statement,
      $._ws,
      $.variant,
      repeat(seq(optional($._ws), $.variant)),
    ),

    // After the `.match` keyword, the selector list is greedy — we
    // keep consuming `_ws selector` until the next token can't start
    // a variable (i.e. isn't `$`). The `matcher` conflict declaration
    // lets tree-sitter's GLR explore "extend selector" vs "start
    // variant" at each ambiguous point.
    match_statement: $ => seq(
      alias(token('.match'), $.keyword_match),
      repeat1(seq($._ws, $.selector)),
    ),

    selector: $ => $.variable,

    variant: $ => seq(
      $.key,
      repeat(seq($._ws, $.key)),
      optional($._ws),
      $.quoted_pattern,
    ),

    key: $ => choice(
      $.literal,
      alias('*', $.catchall),
    ),

    // ── Placeholder / expression / markup ──────────────────────────
    placeholder: $ => choice(
      $.expression,
      $.markup,
    ),

    // expression = literal-expression / variable-expression / function-expression
    expression: $ => choice(
      $.literal_expression,
      $.variable_expression,
      $.function_expression,
    ),

    literal_expression: $ => seq(
      '{',
      optional($._ws),
      $.literal,
      optional(seq($._ws, $.function)),
      repeat(seq($._ws, $.attribute)),
      optional($._ws),
      '}',
    ),

    variable_expression: $ => seq(
      '{',
      optional($._ws),
      $.variable,
      optional(seq($._ws, $.function)),
      repeat(seq($._ws, $.attribute)),
      optional($._ws),
      '}',
    ),

    function_expression: $ => seq(
      '{',
      optional($._ws),
      $.function,
      repeat(seq($._ws, $.attribute)),
      optional($._ws),
      '}',
    ),

    // ── Markup ──────────────────────────────────────────────────────
    //
    // markup = "{" o "#" identifier *(s option) *(s attribute) o ["/"] "}"
    //        / "{" o "/" identifier *(s option) *(s attribute) o "}"
    markup: $ => choice(
      $.markup_open_or_standalone,
      $.markup_close,
    ),

    markup_open_or_standalone: $ => seq(
      '{',
      optional($._ws),
      '#',
      $.identifier,
      repeat(seq($._ws, $.option)),
      repeat(seq($._ws, $.attribute)),
      optional($._ws),
      optional(alias('/', $.self_closing)),
      '}',
    ),

    markup_close: $ => seq(
      '{',
      optional($._ws),
      '/',
      $.identifier,
      repeat(seq($._ws, $.option)),
      repeat(seq($._ws, $.attribute)),
      optional($._ws),
      '}',
    ),

    // ── Function / options / attributes ────────────────────────────
    //
    // function  = ":" identifier *(s option)
    // option    = identifier o "=" o (literal / variable)
    // attribute = "@" identifier [o "=" o literal]
    //
    // `attribute` takes *literal only* per the current spec; `option`
    // accepts literal or variable.
    //
    // NOT `prec.right` here — making function greedy over its option
    // list causes it to consume trailing whitespace speculatively
    // even when the following tokens form an attribute (`@`) or the
    // closing brace. Tree-sitter's GLR resolves the ambiguity
    // correctly without the precedence hint.
    function: $ => seq(
      ':',
      $.identifier,
      repeat(seq($._ws, $.option)),
    ),

    option: $ => seq(
      $.identifier,
      optional($._ws),
      '=',
      optional($._ws),
      choice($.literal, $.variable),
    ),

    attribute: $ => seq(
      '@',
      $.identifier,
      optional(seq(
        optional($._ws),
        '=',
        optional($._ws),
        $.literal,
      )),
    ),

    // ── Literals ────────────────────────────────────────────────────
    //
    // literal          = quoted-literal / unquoted-literal
    // quoted-literal   = "|" *(quoted-char / escaped-char) "|"
    // unquoted-literal = 1*name-char
    literal: $ => choice(
      $.quoted_literal,
      $.unquoted_literal,
    ),

    quoted_literal: $ => seq(
      '|',
      repeat(choice(
        $.quoted_char,
        $.escape,
      )),
      '|',
    ),

    // `unquoted-literal = 1*name-char` per the spec. We split this
    // lexically into TWO non-overlapping tokens:
    //
    //   _nonname_unquoted — starts with a name-char that isn't a
    //       valid name-start (digit, `-`, `.`). E.g. `42`, `-foo`,
    //       `1.2.3`.
    //   name             — defined below; starts with name-start.
    //
    // Splitting this way avoids the lexer ambiguity that would arise
    // from two tokens matching the same input (e.g. a bare `c`
    // identifier appearing in either name-required contexts like
    // attribute identifiers or literal-required contexts like
    // attribute values). Each lexical string has exactly one token.
    //
    // The `unquoted_literal` node accepts either shape; the
    // `(unquoted_literal)` tree representation is identical whether
    // the content is name-shaped or digit-starting.
    unquoted_literal: $ => choice(
      $.name,
      $._nonname_unquoted,
    ),

    _nonname_unquoted: _ => token(
      new RegExp(`[0-9\\-.][${NAME_CHAR_CLASS}]*`, 'u')
    ),

    // ── Variable ────────────────────────────────────────────────────
    //
    // variable = "$" name
    variable: $ => seq('$', $.name),

    // ── Identifier ──────────────────────────────────────────────────
    //
    // identifier = [namespace ":"] name
    // namespace  = name
    identifier: $ => choice(
      seq(alias($.name, $.namespace), ':', $.name),
      $.name,
    ),

    // ── Terminals ───────────────────────────────────────────────────
    //
    // name = [bidi] name-start *name-char [bidi]
    //
    // Exactly one optional bidi control character may appear at each
    // end of a name per the spec. Bidi chars elsewhere in whitespace
    // positions are consumed by `_ws`; here they're tight-bound to
    // the name token.
    name: _ => token(
      new RegExp(
        `[${BIDI_CLASS}]?[${NAME_START_CLASS}][${NAME_CHAR_CLASS}]*[${BIDI_CLASS}]?`,
        'u'
      )
    ),

    // text-char = %x01-5B / %x5D-7A / %x7C / %x7E-10FFFF
    // — anything except `\`, `{`, `}`.
    text: _ => token(new RegExp(`[${TEXT_CHAR_CLASS}]+`, 'u')),

    // escaped-char = "\" ( "\" / "{" / "|" / "}" )
    // Unified across text and quoted-literal contexts per the spec.
    escape: _ => token(choice('\\\\', '\\{', '\\}', '\\|')),

    // quoted-char = %x01-5B / %x5D-7B / %x7D-10FFFF
    // — anything except `\` and `|`. `{` and `}` are legal in quoted
    // literals without escaping.
    quoted_char: _ => token(new RegExp(`[${QUOTED_CHAR_CLASS}]+`, 'u')),

    // Whitespace-or-bidi token covering both `s` (required) and `o`
    // (optional) productions in the spec. The spec distinguishes them
    // by whether they must contain a `ws` char — `s = *bidi ws o`
    // requires at least one real whitespace, `o = *(ws / bidi)`
    // allows bidi-only runs. Having two tokens that match overlapping
    // input confuses tree-sitter's lexer (it sees the same character
    // and has to pick one), so we expose a single `_ws` token
    // accepting any non-empty run of ws-or-bidi chars and use it
    // with `optional(...)` at `o` positions and bare at `s` positions.
    //
    // The practical relaxation: we accept bidi-only strings in `s`
    // positions where the spec mandates at least one `ws` char. A
    // strict conformance checker should layer that constraint on
    // top of the CST if needed; at the parser level, this is a small
    // over-acceptance and all spec-valid inputs still parse.
    _ws: _ => token(new RegExp(`[${WS_OR_BIDI}]+`, 'u')),
  },
});
