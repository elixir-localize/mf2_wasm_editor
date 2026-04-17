/**
 * @file MessageFormat 2 grammar for tree-sitter
 *
 * This grammar implements the ICU MessageFormat 2.0 (MF2) message syntax
 * as defined in Unicode Technical Standard #35, Part 3:
 * https://unicode.org/reports/tr35/tr35-messageFormat.html
 *
 * MF2 has two forms:
 *
 *   - simple-message  — a plain pattern of text + placeholders.
 *   - complex-message — optional declarations (`.input`, `.local`) and
 *                       either a quoted pattern `{{ ... }}` or a matcher
 *                       (`.match` + variants).
 *
 * Whitespace is significant inside patterns (it is part of the text) and
 * insignificant inside expressions `{ ... }`. We therefore set
 * `extras: []` and handle whitespace explicitly at each allowed point.
 *
 * The `message` rule prefers `complex_message` when ambiguous, matching
 * the spec: a message starting with `.` is a complex-message.
 *
 * @author Localize contributors
 * @license Apache-2.0
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

module.exports = grammar({
  name: 'mf2',

  // Whitespace is significant in MF2 patterns, so nothing is implicit.
  extras: _ => [],

  // Identifiers are the "word" token for keyword disambiguation.
  word: $ => $.name,

  conflicts: $ => [
    // After a match_statement, tree-sitter cannot tell with a single
    // token of lookahead whether the whitespace before the next token
    // is trailing (done with the matcher) or leading (start of another
    // variant). GLR explores both.
    [$.matcher],
  ],

  rules: {
    // The root. An MF2 source may be empty (an empty simple-message).
    // Trailing whitespace is tolerated — not part of the message proper
    // but common in files and heredocs.
    source_file: $ => seq(optional($.message), optional($._s)),

    message: $ => choice(
      // Prefer complex when both could match the input (i.e. the input
      // begins with `.input`, `.local`, `.match`, or `{{`).
      prec(2, $.complex_message),
      prec(1, $.simple_message),
    ),

    // ─────────────────────────────── Simple message ───────────────────
    //
    // simple-message = [simple-start pattern]
    // simple-start   = simple-start-char / text-escape / placeholder

    // Per the MF2 spec, a simple-message cannot begin with `.`, `@`,
    // or `|` as a literal text character — those positions trigger
    // complex-message / attribute / literal parsing instead. The first
    // text run uses `text_start` (restricted first character) to prevent
    // `.input …` from being eaten as text at the start of a message.
    simple_message: $ => seq(
      $._simple_start,
      optional($._pattern_tail),
    ),

    _simple_start: $ => choice(
      alias($.text_start, $.text),
      $.escape,
      $.placeholder,
    ),

    text_start: _ => token(/[^.{}@|\\][^{}\\]*/),

    _pattern_tail: $ => repeat1(choice(
      $.text,
      $.escape,
      $.placeholder,
    )),

    // ────────────────────────────── Complex message ───────────────────
    //
    // complex-message = *( declaration [s] ) complex-body
    // complex-body    = quoted-pattern / matcher

    complex_message: $ => seq(
      repeat(seq($.declaration, optional($._s))),
      choice($.quoted_pattern, $.matcher),
    ),

    quoted_pattern: $ => seq(
      '{{',
      repeat(choice($.text, $.escape, $.placeholder)),
      '}}',
    ),

    // ───────────────────────────────── Declaration ────────────────────

    declaration: $ => choice(
      $.input_declaration,
      $.local_declaration,
    ),

    input_declaration: $ => seq(
      alias(token('.input'), $.keyword_input),
      optional($._s),
      $.variable_expression,
    ),

    local_declaration: $ => seq(
      alias(token('.local'), $.keyword_local),
      $._s,
      $.variable,
      optional($._s),
      '=',
      optional($._s),
      $.expression,
    ),

    // ───────────────────────────────── Matcher ────────────────────────
    //
    // matcher         = match-statement 1*( [s] variant )
    // match-statement = .match 1*( s selector )
    // variant         = key *( s key ) [s] quoted-pattern

    matcher: $ => seq(
      $.match_statement,
      repeat1(seq(optional($._s), $.variant)),
    ),

    // `prec.left` forces tree-sitter to greedily extend the selector
    // list; without it the parser cannot decide between another selector
    // and the first variant when it sees whitespace followed by an
    // expression-like token.
    match_statement: $ => prec.left(seq(
      alias(token('.match'), $.keyword_match),
      repeat1(seq($._s, $.selector)),
    )),

    // Per the MF2 spec (tr35-messageFormat.md `message.abnf` line 1419)
    // a selector is exactly a `variable`. Not an expression, not a
    // literal. `.match $count` is the spec-correct form.
    selector: $ => $.variable,

    variant: $ => seq(
      $.key,
      repeat(seq($._s, $.key)),
      optional($._s),
      $.quoted_pattern,
    ),

    key: $ => choice(
      $.literal,
      alias('*', $.catchall),
    ),

    // ──────────────────────────────── Placeholder ─────────────────────

    placeholder: $ => choice(
      $.expression,
      $.markup,
    ),

    // expression = "{" [s] ( literal-expression / variable-expression /
    //                        annotation-expression ) [s] "}"
    expression: $ => choice(
      $.literal_expression,
      $.variable_expression,
      $.annotation_expression,
    ),

    literal_expression: $ => seq(
      '{',
      optional($._s),
      $.literal,
      optional(seq($._s, $.annotation)),
      repeat(seq($._s, $.attribute)),
      optional($._s),
      '}',
    ),

    variable_expression: $ => seq(
      '{',
      optional($._s),
      $.variable,
      optional(seq($._s, $.annotation)),
      repeat(seq($._s, $.attribute)),
      optional($._s),
      '}',
    ),

    annotation_expression: $ => seq(
      '{',
      optional($._s),
      $.annotation,
      repeat(seq($._s, $.attribute)),
      optional($._s),
      '}',
    ),

    // ────────────────────────────────── Markup ────────────────────────
    //
    // markup = "{" [s] "#" identifier *(s option) *(s attribute) [s] ["/"] "}"
    //        / "{" [s] "/" identifier *(s option) *(s attribute) [s] "}"

    markup: $ => choice(
      $.markup_open_or_standalone,
      $.markup_close,
    ),

    markup_open_or_standalone: $ => seq(
      '{',
      optional($._s),
      '#',
      $.identifier,
      repeat(seq($._s, $.option)),
      repeat(seq($._s, $.attribute)),
      optional($._s),
      optional(alias('/', $.self_closing)),
      '}',
    ),

    markup_close: $ => seq(
      '{',
      optional($._s),
      '/',
      $.identifier,
      repeat(seq($._s, $.option)),
      repeat(seq($._s, $.attribute)),
      optional($._s),
      '}',
    ),

    // ───────────────────────────── Annotation / options ───────────────

    annotation: $ => $.function,

    // `prec.right` makes tree-sitter extend the option list greedily
    // when it sees `_s identifier ... =` after the function name, rather
    // than closing the function and confusing the following tokens.
    function: $ => prec.right(seq(
      ':',
      $.identifier,
      repeat(seq($._s, $.option)),
    )),

    option: $ => seq(
      $.identifier,
      optional($._s),
      '=',
      optional($._s),
      choice($.literal, $.variable),
    ),

    attribute: $ => prec.left(seq(
      '@',
      $.identifier,
      optional(seq(
        optional($._s),
        '=',
        optional($._s),
        choice($.literal, $.variable),
      )),
    )),

    // ────────────────────────────────── Literals ──────────────────────

    literal: $ => choice(
      $.quoted_literal,
      $.unquoted_literal,
    ),

    quoted_literal: $ => seq(
      '|',
      repeat(choice(
        $.quoted_char,
        $.quoted_escape,
      )),
      '|',
    ),

    unquoted_literal: $ => choice(
      $.number_literal,
      $.name,
    ),

    number_literal: $ => token(
      seq(
        optional('-'),
        choice('0', /[1-9][0-9]*/),
        optional(seq('.', /[0-9]+/)),
        optional(seq(/[eE]/, optional(/[+-]/), /[0-9]+/)),
      )
    ),

    // ────────────────────────────────── Variable ──────────────────────

    variable: $ => seq('$', $.name),

    // ───────────────────────────────── Identifier ─────────────────────
    //
    // identifier = [ namespace ":" ] name
    // namespace and name are the same lexical shape.

    identifier: $ => choice(
      seq(alias($.name, $.namespace), ':', $.name),
      $.name,
    ),

    // ──────────────────────────────── Terminals ──────────────────────
    //
    // The MF2 spec permits a broad Unicode range for name-start and
    // name-char. The regex below covers the basic ASCII case plus
    // the common Unicode letters and connectors used in practice.
    // A full Unicode implementation would list every range from the
    // spec; this is a pragmatic approximation suitable for tooling.

    name: _ => token(
      /[A-Za-z_\u00A0-\uD7FF\uE000-\uFDCF\uFDF0-\uFFFD][A-Za-z0-9_\-.\u00A0-\uD7FF\uE000-\uFDCF\uFDF0-\uFFFD]*/
    ),

    // text-char = any Unicode scalar except `{`, `}`, `\`.
    text: _ => token(/[^{}\\]+/),

    // text-escape = "\" ( "\" / "{" / "}" )
    escape: _ => token(choice('\\\\', '\\{', '\\}')),

    // quoted-char = any Unicode scalar except `|`, `\`.
    quoted_char: _ => token(/[^|\\]+/),

    // quoted-escape = "\" ( "\" / "|" )
    quoted_escape: _ => token(choice('\\\\', '\\|')),

    // s = 1*( %x20 / %x09 / %x0D / %x0A )  — MF2 whitespace.
    _s: _ => token(/[ \t\r\n]+/),
  },
});
