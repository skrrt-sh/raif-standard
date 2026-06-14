"""Pure-Python RAIF `fix` — a faithful port of `fix` from the canonical
TypeScript reference (`packages/js/src/raif.ts`).

`fix` is RAIF -> canonical RAIF: it runs the same repair/decode pipeline the
decoder uses, then re-emits the resulting JSON value in the canonical profile.
Output is byte-identical for any input that reduces to the same JSON value
(including content-derived multiline nonces), so `fix` is idempotent. ADR-0014.
"""

from __future__ import annotations

from typing import Any

from .decode import (
    RaifError,
    _assemble,
    _check_encodable,
    _parse_leaves,
    _prepare_text,
    _repair_repeated_keys,
    _to_schema,
)
from .encode import encode

__all__ = ["fix"]


def _fix_internal(text: str, repairs: list[dict], schema) -> dict[str, Any]:
    """Mirror TS `fixInternal`: run the strict decode pipeline, then re-encode
    the JSON value as canonical RAIF. Returns `{"json", "canonical"}`."""
    prepared = _prepare_text(text, repairs)
    leaves = _parse_leaves(prepared, repairs, None)
    leaves = _repair_repeated_keys(leaves, repairs)
    root = _assemble(leaves, repairs, None, schema)
    _check_encodable(root)
    canonical = encode(root, {"profile": "canonical"})
    return {"json": root, "canonical": canonical}


def fix(input: str, schema: Any | None = None) -> dict:
    """RAIF -> canonical RAIF. Returns `{"ok": True, "canonical", "repairs"}` on
    success, or `{"ok": False, "error", "repairs"}` on an unrepairable input.
    `schema` is an optional schema declaration string or a parsed schema
    (`parse_schema(...)`)."""
    repairs: list[dict] = []
    try:
        out = _fix_internal(input, repairs, _to_schema(schema))
        return {"ok": True, "canonical": out["canonical"], "repairs": repairs}
    except (RaifError, ValueError) as e:
        # Mirror the TS blanket catch: any decode/encode failure is an
        # unrepairable input, reported with the repairs attempted so far.
        return {"ok": False, "error": str(e), "repairs": repairs}
