"""Pure-Python RAIF encoder — a faithful port of `encode` (and its emission
profiles) from the canonical TypeScript reference (`packages/js/src/raif.ts`).

`encode` produces byte-identical output to the TS `encode` for the same input
and options; the shared conformance corpus (`conformance/encode.json`) pins
this exactly across both profiles.

Two emission profiles (ADR-0019):
  "canonical"  — cheapest-mode pick, fully sorted; the transport/audit form.
  "generation" — what models are trained to emit: deterministic mode rules
    (table -> array literal -> path; no byte-cost optimization) and
    truncation-optimal ordering of emission units.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Literal, TypedDict

__all__ = ["encode", "EncodeOptions", "EncodeProfile"]

# Mirror the TS named types on the public surface. `EncodeProfile` is the literal
# "canonical" or "generation"; `EncodeOptions` is the options mapping. Both are
# typing constructs — at runtime `opts` is still a plain dict.
EncodeProfile = Literal["canonical", "generation"]


class EncodeOptions(TypedDict, total=False):
    profile: EncodeProfile
    markers: bool


OPEN = "<<<"
CLOSE = ">>>"

# UTF-8 byte order equals Unicode code-point order. Python's default str
# comparison already orders by code point, so a plain key sort matches the TS
# `compareUtf8` helper for every well-formed string.
_NONCE_OPENER_RE = re.compile(r"^(.*?)=<<<([0-9a-fA-F]*)$")

# A value whose tail would make the assembled leaf line itself look like a
# block opener (`...=<<<hex`, `...=<{1,2}hex`, `...=[`) must be wrapped.
_OPENER_TAIL_RE = re.compile(r"(^|=)(<{1,3}[0-9a-fA-F]*|\[)$")

_NUMBER_RE = re.compile(r"^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$")

# JS leading/trailing whitespace set, used to mirror `s.trim() !== s`.
_WS = "[\t\n\x0b\x0c\r \xa0  -     　﻿]"
_LEADING_WS_RE = re.compile(rf"^{_WS}")
_TRAILING_WS_RE = re.compile(rf"{_WS}$")


def _has_opener_tail(v: str) -> bool:
    return _OPENER_TAIL_RE.search(v) is not None


def _strip_cr(line: str) -> str:
    return line[:-1] if line.endswith("\r") else line


def _has_edge_ws(s: str) -> bool:
    """Mirror JS `s.trim() !== s`: True when s has leading/trailing whitespace."""
    return bool(_LEADING_WS_RE.search(s)) or bool(_TRAILING_WS_RE.search(s))


def _utf8_len(s: str) -> int:
    return len(s.encode("utf-8"))


def _utf16_len(s: str) -> int:
    """JS `String.prototype.length`: count of UTF-16 code units (astral chars
    count as 2). The TS reference compares the inline-object form via this
    measure, NOT UTF-8 bytes, so the inline-vs-path tie-break must match it."""
    return len(s.encode("utf-16-le")) // 2


def _bytes(leaves: list[str]) -> int:
    n = 0
    for line in leaves:
        n += _utf8_len(line) + 1  # +1 for the join newline
    return n


def _json_number(value: float) -> str:
    """Render a finite number exactly as JS `JSON.stringify(value)` does."""
    if isinstance(value, bool):  # pragma: no cover - guarded by callers
        raise TypeError("bool is not a number")
    if isinstance(value, int):
        return str(value)
    # float: match JS Number -> string. Integral floats stringify without a
    # decimal point in JS (e.g. 5.0 -> "5"); JSON.stringify(NaN/Inf) is invalid.
    if value == math.floor(value) and math.isfinite(value):
        return str(int(value))
    # json.dumps uses repr() for floats, which is the shortest round-tripping
    # representation — the same algorithm V8 uses for Number -> string.
    return json.dumps(value)


# ─── number / literal predicates ──────────────────────────────────────────


def _looks_like_literal(s: str) -> bool:
    if s in ("true", "false", "null"):
        return True
    return _NUMBER_RE.match(s) is not None


def _try_parse_inline_object_shape(s: str) -> bool:
    """True when `s` would parse back as `{key=val(,key=val)*}` (non-empty).

    Mirrors the encoder's `looksLikeInlineObject` -> `tryParseInlineObject`
    check: we only need a yes/no shape test (would the decoder reinterpret this
    bare string as an inline object?), so this is a structural parse, not a
    value-producing one.
    """
    if not (s.startswith("{") and s.endswith("}")):
        return False
    if s == "{}":
        return False
    inner = s[1:-1]
    if inner == "":
        return False
    for part in _split_top_level_commas(inner):
        eq = _find_top_level_eq(part)
        if eq == -1:
            return False
        key = part[:eq]
        if key == "":
            return False
    return True


def _find_top_level_eq(s: str) -> int:
    """Index of the first top-level `=` (brace-depth 0, outside `<<<...>>>`)."""
    depth = 0
    i = 0
    n = len(s)
    while i < n:
        if s.startswith(OPEN, i):
            end = s.find(CLOSE, i + len(OPEN))
            if end == -1:
                return -1
            i = end + len(CLOSE)
            continue
        c = s[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif c == "=" and depth == 0:
            return i
        i += 1
    return -1


def _split_top_level_commas(s: str) -> list[str]:
    """Split on commas at brace-depth 0, skipping `<<<...>>>` ranges."""
    parts: list[str] = []
    depth = 0
    start = 0
    i = 0
    n = len(s)
    while i < n:
        if s.startswith(OPEN, i):
            end = s.find(CLOSE, i + len(OPEN))
            if end == -1:
                i += len(OPEN)
                continue
            i = end + len(CLOSE)
            continue
        c = s[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif c == "," and depth == 0:
            parts.append(s[start:i])
            start = i + 1
        i += 1
    parts.append(s[start:])
    return parts


def _looks_like_inline_object(s: str) -> bool:
    return _try_parse_inline_object_shape(s)


# ─── key encoding ─────────────────────────────────────────────────────────


def _needs_key_quoting(key: str) -> bool:
    if len(key) == 0:
        return True
    if OPEN in key or CLOSE in key:
        raise ValueError(f"key contains <<< or >>> which RAIF does not support: {key}")
    for c in key:
        if c in (".", "[", "]", "=", ":", "\n", "\r"):
            return True
    return bool(_has_edge_ws(key))


def _join_key(prefix: str, key: str) -> str:
    encoded = f"{OPEN}{key}{CLOSE}" if _needs_key_quoting(key) else key
    return encoded if prefix == "" else f"{prefix}.{encoded}"


def _needs_inline_key_quoting(k: str) -> bool:
    for c in k:
        if c in (".", "[", "]", "=", ":", ",", "{", "}"):
            return True
    return bool(_has_edge_ws(k))


# ─── cell encoders ────────────────────────────────────────────────────────


def _encode_primitive_cell(v: Any, needs_wrap) -> str | None:
    """Shared primitive-cell encoder; returns None for non-primitive values."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return _json_number(v)
    if isinstance(v, str):
        return f"{OPEN}{v}{CLOSE}" if needs_wrap(v) else v
    return None


def _encode_array_literal_element(v: Any) -> str:
    cell = _encode_primitive_cell(
        v,
        lambda s: (
            len(s) == 0
            or _has_edge_ws(s)
            or s == "]"
            or s == "["
            or s.startswith(OPEN)
            or s in ("[]", "{}")
            or _looks_like_literal(s)
            or _looks_like_inline_object(s)
        ),
    )
    if cell is not None:
        return cell
    return _encode_inline_object(v)


def _encode_inline_cell(v: Any) -> str:
    cell = _encode_primitive_cell(
        v,
        lambda s: (
            len(s) == 0
            or _has_edge_ws(s)
            or "," in s
            or "}" in s
            or "{" in s
            or OPEN in s
            or s == "[]"
            or _looks_like_literal(s)
        ),
    )
    if cell is None:
        raise ValueError(f"unexpected inline cell: {v!r}")
    return cell


def _encode_table_cell(v: Any) -> str:
    cell = _encode_primitive_cell(
        v,
        lambda s: (
            len(s) == 0
            or _has_edge_ws(s)
            or "," in s
            or "{" in s
            or OPEN in s
            or s == "[]"
            or _looks_like_literal(s)
            or _has_opener_tail(s)
        ),
    )
    if cell is None:
        raise ValueError(f"unexpected table cell value: {v!r}")
    return cell


# ─── inline-object encoding ───────────────────────────────────────────────


def _encode_inline_object(obj: dict) -> str:
    keys = sorted(obj.keys())
    pairs = []
    for k in keys:
        key = f"{OPEN}{k}{CLOSE}" if _needs_inline_key_quoting(k) else k
        pairs.append(f"{key}={_encode_inline_cell(obj[k])}")
    return "{" + ",".join(pairs) + "}"


# ─── eligibility predicates ───────────────────────────────────────────────


def _is_primitive_cell_eligible(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, bool):
        return True
    if isinstance(v, (int, float)):
        return _is_finite_number(v)
    if isinstance(v, str):
        return not ("\n" in v or "\r" in v or CLOSE in v)
    return False


def _is_finite_number(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return True
    if isinstance(v, float):
        return math.isfinite(v)
    return False


def _is_inline_key_eligible(k: str) -> bool:
    if len(k) == 0:
        return False
    if "\n" in k or "\r" in k:
        return False
    return not (OPEN in k or CLOSE in k)


def _eligible_for_inline_object(obj: dict) -> bool:
    if len(obj) == 0:
        return False  # `{}` is the empty-object literal
    for k, v in obj.items():
        if not _is_inline_key_eligible(k):
            return False
        if not _is_primitive_cell_eligible(v):
            return False
    return True


def _is_array_literal_eligible(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, bool):
        return True
    if isinstance(v, (int, float)):
        return _is_finite_number(v)
    if isinstance(v, str):
        return not ("\n" in v or "\r" in v)
    if isinstance(v, list):
        return False
    if isinstance(v, dict):
        return _eligible_for_inline_object(v)
    return False


# ─── string-leaf encoding ─────────────────────────────────────────────────


def _nonce_for(value: str) -> str:
    """Deterministic content-derived FNV-1a nonce, re-hashed to avoid collision
    with `>>>NONCE` inside the value (matches the TS implementation bit-for-bit).
    """
    h = 0x811C9DC5
    for ch in value:
        h ^= ord(ch) & 0xFFFFFFFF
        h = (h * 0x01000193) & 0xFFFFFFFF
    nonce = format(h & 0xFFFF, "04x")
    while f"{CLOSE}{nonce}" in value:
        h = ((h ^ 0x9E3779B9) * 0x01000193) & 0xFFFFFFFF
        nonce = format(h & 0xFFFF, "04x")
    return nonce


def _encode_string_leaf(value: str) -> str:
    """Encode a string value as its leaf suffix INCLUDING the separator."""
    if "\n" in value:
        lines = value.split("\n")
        collides = any(_strip_cr(line) == CLOSE for line in lines)
        if collides:
            nonce = _nonce_for(value)
            return f"={OPEN}{nonce}\n{value}\n{CLOSE}{nonce}"
        return f"={OPEN}\n{value}\n{CLOSE}"
    needs_protection = (
        len(value) == 0
        or _has_edge_ws(value)
        or value.startswith(OPEN)
        or value in ("[]", "{}")
        or CLOSE in value
        or _has_opener_tail(value)
        or _looks_like_literal(value)
        or _looks_like_inline_object(value)
    )
    if not needs_protection:
        return f"={value}"
    tag_safe = (
        not _has_edge_ws(value)
        and not _has_opener_tail(value)
        and not (value.startswith(OPEN) and value.endswith(CLOSE))
    )
    if tag_safe:
        return f":s={value}"
    return f"={OPEN}{value}{CLOSE}"


# ─── array emission ───────────────────────────────────────────────────────


def _as_path(arr: list, prefix: str, profile: str) -> list[str]:
    out: list[str] = []
    for i, item in enumerate(arr):
        _walk(item, f"{prefix}[{i}]", out, profile)
    return out


def _as_table(arr: list, prefix: str) -> list[str] | None:
    if len(arr) < 2:
        return None
    first = arr[0]
    if first is None or not isinstance(first, dict) or isinstance(first, list):
        return None
    cols = sorted(first.keys())
    if len(cols) == 0:
        return None
    for item in arr:
        if item is None or not isinstance(item, dict):
            return None
        item_keys = sorted(item.keys())
        if len(item_keys) != len(cols):
            return None
        if not all(item_keys[i] == cols[i] for i in range(len(cols))):
            return None
        for k in cols:
            if not _is_primitive_cell_eligible(item[k]):
                return None
    for c in cols:
        if "," in c or OPEN in c or CLOSE in c or "=" in c or ":" in c:
            return None
    leaves: list[str] = [f"{prefix}::{','.join(cols)}"]
    for i, row in enumerate(arr):
        cells = [_encode_table_cell(row[c]) for c in cols]
        leaves.append(f"{prefix}[{i}]={','.join(cells)}")
    return leaves


def _as_inline_objects(arr: list, prefix: str) -> list[str] | None:
    for item in arr:
        if item is None or not isinstance(item, dict) or isinstance(item, list):
            return None
        if not _eligible_for_inline_object(item):
            return None
    return [f"{prefix}[{i}]={_encode_inline_object(row)}" for i, row in enumerate(arr)]


def _as_array_literal(arr: list, prefix: str) -> list[str] | None:
    for item in arr:
        if not _is_array_literal_eligible(item):
            return None
    lines: list[str] = [f"{prefix}=["]
    for item in arr:
        lines.append(_encode_array_literal_element(item))
    lines.append("]")
    return lines


def _emit_array(arr: list, prefix: str, leaves: list[str], profile: str) -> None:
    if profile == "generation":
        unit = _as_table(arr, prefix)
        if unit is None:
            unit = _as_array_literal(arr, prefix)
        if unit is not None:
            leaves.append("\n".join(unit))
            return
        for leaf in _as_path(arr, prefix, profile):
            leaves.append(leaf)
        return

    candidates: list[list[str]] = [_as_path(arr, prefix, profile)]
    table = _as_table(arr, prefix)
    if table is not None:
        candidates.append(table)
    inline = _as_inline_objects(arr, prefix)
    if inline is not None:
        candidates.append(inline)
    literal = _as_array_literal(arr, prefix)
    if literal is not None:
        candidates.append(literal)

    best = candidates[0]
    best_len = _bytes(best)
    for cand in candidates[1:]:
        length = _bytes(cand)
        if length < best_len:
            best = cand
            best_len = length
    for leaf in best:
        leaves.append(leaf)


# ─── walk ─────────────────────────────────────────────────────────────────


def _walk(value: Any, prefix: str, leaves: list[str], profile: str) -> None:
    if value is None:
        leaves.append(f"{prefix}=null")
        return
    if isinstance(value, bool):
        leaves.append(f"{prefix}={'true' if value else 'false'}")
        return
    if isinstance(value, (int, float)):
        if not _is_finite_number(value):
            raise ValueError(f"non-finite number at {prefix}: {value}")
        leaves.append(f"{prefix}={_json_number(value)}")
        return
    if isinstance(value, str):
        leaves.append(f"{prefix}{_encode_string_leaf(value)}")
        return
    if isinstance(value, list):
        if len(value) == 0:
            leaves.append(f"{prefix}=[]")
            return
        _emit_array(value, prefix, leaves, profile)
        return
    if isinstance(value, dict):
        keys = list(value.keys())
        if len(keys) == 0:
            if prefix != "":
                leaves.append(f"{prefix}={{}}")
            return
        keys.sort()
        path: list[str] = []
        for k in keys:
            _walk(value[k], _join_key(prefix, k), path, profile)
        if (
            profile == "canonical"
            and prefix != ""
            and _eligible_for_inline_object(value)
        ):
            inline = f"{prefix}={_encode_inline_object(value)}"
            # JS compares `inline.length` (UTF-16 code units) — NOT UTF-8 bytes —
            # against `bytes(path)`; mirror that asymmetry exactly (ADR-0012).
            if _utf16_len(inline) + 1 < _bytes(path):
                leaves.append(inline)
                return
        for leaf in path:
            leaves.append(leaf)
        return
    raise ValueError(f"unexpected value at {prefix}: {value!r}")


_NONCE_OPENER_FIRSTLINE_RE = re.compile(r"^(.*?)=<<<([0-9a-fA-F]*)$")


def _order_for_generation(units: list[str]) -> list[str]:
    """Stable-sort emission units by truncation class (single-line leaves first,
    tables, array literals, multiline blocks last)."""

    def unit_class(u: str) -> int:
        nl = u.find("\n")
        if nl == -1:
            return 0
        first = u[:nl]
        if _NONCE_OPENER_FIRSTLINE_RE.match(first):
            return 3  # multiline text block
        if first.endswith("=["):
            return 2  # array literal
        return 1  # table unit

    indexed = [(unit_class(u), i, u) for i, u in enumerate(units)]
    indexed.sort(key=lambda x: (x[0], x[1]))
    return [u for _, _, u in indexed]


def encode(obj: dict, opts: EncodeOptions | None = None) -> str:
    """Encode a JSON object to canonical (or generation-profile) RAIF.

    `obj` must be a dict (RAIF requires a JSON object at top level). `opts` is
    an optional dict: `{"profile": "canonical"|"generation", "markers": bool}`.
    Output is byte-identical to the canonical TypeScript `encode`.
    """
    if obj is None or not isinstance(obj, dict) or isinstance(obj, list):
        raise ValueError("RAIF requires a JSON object at top level")
    opts = opts or {}
    profile = opts.get("profile") or "canonical"
    leaves: list[str] = []
    _walk(obj, "", leaves, profile)
    units = _order_for_generation(leaves) if profile == "generation" else leaves
    body = "\n".join(units)
    if not opts.get("markers"):
        return body
    return "<raif>\n</raif>" if len(body) == 0 else f"<raif>\n{body}\n</raif>"
