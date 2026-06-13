# Nonce in multiline form is optional, used only on demand

[ADR-0001](./0001-text-block-nonce-delimiters.md) defined two forms for delimited string values:

- **Bare single-line**: `field=<<<value>>>` (used when the value contains no `\n` and no `>>>`).
- **Nonce-bounded multiline**: `field=<<<NONCE\n...\n>>>NONCE` (used for any value containing `\n`, `\r`, or `>>>`).

The v0.2 prototype encoder followed this rule literally: every multiline value got a per-block hex nonce. That choice was overcautious. The nonce only matters when a content line could be mistaken for the closer. A bare line-form

```
field=<<<
…content…
>>>
```

is unambiguous unless some content line **literally equals** `>>>`. For the prototype corpus's `multiline_body`, no content line does — the nonce was pure overhead (4+ characters of hex per side, ~4 tokens in cl100k_base).

## Decision

The multiline form drops the nonce by default. The encoder uses the nonce-bounded form only when a content line of the value literally equals `>>>`.

```
field=<<<            ← opener, nothing after `<<<`
multi-line content
>>>                  ← closer, nothing after `>>>`
```

A `>>>` appearing **inside** a content line (`some >>> arrow`) is safe in the bare form — only a whole-line `>>>` would terminate the block early. The nonced form remains for the rare case where a content line is exactly `>>>`:

```
field=<<<7f2a
line one
>>>
line three
>>>7f2a
```

## Single-line strings containing `>>>` also drop the nonce

A single-line value containing `>>>` no longer needs the multiline form at all. The decoder's "outermost slice" rule for delimited single-line values already handles embedded `>>>`:

```
field=<<<abc>>>def>>>   ← decodes to: abc>>>def
```

The encoder's previous behavior promoted any single-line string with `>>>` to the multiline+nonce form, costing extra newlines and a nonce. We now wrap such values single-line with bare `<<<...>>>` — a strict token win.

## Parser change

The multiline opener regex is relaxed to allow an empty nonce:

```diff
-/^(.*?)=<<<([0-9a-fA-F]+)$/
+/^(.*?)=<<<([0-9a-fA-F]*)$/
```

Closer matching is unchanged: the parser looks for the first line that literally equals `>>>{nonce}`. When the nonce is empty, the closer is `>>>` alone on a line.

## Impact on the corpus

| case | v0.2 (always nonce) | v0.3 (nonce on demand) |
|---|---:|---:|
| multiline_body | +2% | -9% |
| text_with_specials | -11% | -11% (unchanged; no multiline content) |
| overall | -8% | -10% (other deltas unchanged) |

## Repairability

The nonce is also a verification token: a model that copies `<<<7f2a` to `>>>7f2b` (typo) emits a recoverable but distinguishable error. Without nonce, that signal is gone. The repair pass (spec §6, expanded in this iteration) compensates by recovering mismatched nonces when there is exactly one viable `>>>` candidate downstream. The trade is: cheaper happy path, slightly fewer signals on bad output. Net: positive on tokens and roughly neutral on repair.

## Consequences

- The encoder always picks the cheapest legal form among bare, bare-delimited, bare-multiline, nonced-multiline. Order of preference: bare > `<<<value>>>` > `<<<\n…\n>>>` > `<<<NONCE\n…\n>>>NONCE`.
- A grammar-constrained decoder built from this spec must accept both `<<<\n...\n>>>` and `<<<NONCE\n...\n>>>NONCE` as multiline forms. The empty-nonce branch is one extra alternation.
- Test coverage: the prototype's existing test for "multiline string uses nonce form" was rewritten to assert the new no-nonce default; the nonce-required form has its own test (`line literally equals \`>>>\``).

## Considered options

- **Keep nonce always (v0.2 status quo)** — rejected: pure waste on the common case.
- **Drop nonce form entirely; require escaping `>>>` in content** — rejected: violates ADR-0001 Design Goal #5 (no escaping by default).
- **Use a different closer character entirely** — rejected: `>>>` tokenizes well in cl100k_base; changing it would invalidate ADR-0001 measurements without a clear win.
