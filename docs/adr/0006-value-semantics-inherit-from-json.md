# Value semantics inherit from JSON; one number type; schemas describe objects only

The original spec proposed a richer type system than JSON (`i` integer + `n` number + `d` date + `u` URI + `x` opaque-id + `r` reference) and earlier grilling tried to define explicit int-vs-float rules, big-integer handling, special-float behavior, and an "encoder inspects source type" round-trip discipline. Every rule opened a new edge case: locale-dependent number parsing, language-specific `42.0` stringification, BigInt precision loss across runtimes.

We inherit JSON's value semantics verbatim. RAIF only changes the *syntax around* values, not the values themselves. If JSON loses precision on a 20-digit integer, RAIF loses it the same way. If JSON forbids `NaN`, so does RAIF. If two host languages disagree about `42.0` vs `42`, that's a pre-existing JSON portability issue, not RAIF's problem.

## Rules

1. **One number type (`n`).** Literal grammar is JSON's number grammar: `-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`. Leading zeros rejected, `NaN`/`Infinity` rejected.
2. **Booleans, null, strings**: identical literals to JSON (lowercase `true`/`false`/`null`).
3. **Strings inside `␞...␞`**: raw text, no escaping. Falls back to the multiline nonce-block form (ADR-0001) when the value contains literal `␞` or newlines. The string *content model* differs from JSON (no `\n`/`\t` escapes inside RAIF) but the decoded string value is identical.
4. **Big integers, decimal precision, Unicode normalization**: inherit host-language behavior.
5. **Schemas describe object shapes only** — field names, types, required/optional, value constraints. RAIF schemas do not validate standalone primitives.

The MVP type set shrinks from `s, t, i, n, b, e, z` to `s, t, n, b, z`. `e` (enum) survives only as a schema-level constraint over `s`, not a primary type code.

## Considered

- **Separate int/float distinction with strict round-trip discipline.** Rejected; reproduces every JSON portability headache without adding value.
- **Big-int handling via a `bi` type code.** Rejected; JSON has the same problem and no one waits for RAIF to fix it.
