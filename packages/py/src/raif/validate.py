"""Pure-Python RAIF `validate` — a faithful port of `validate` from the
canonical TypeScript reference (`packages/js/src/raif.ts`).

`validate` is a pure read-only canonicality check: `ok == True` iff the input
is already canonical RAIF (i.e. `fix(input).canonical == input` with no
repairs). It never mutates and surfaces the same messages the pipeline would.
ADR-0014.
"""

from __future__ import annotations

from typing import Any

from .decode import RaifError, _to_schema
from .fix import _fix_internal

__all__ = ["validate"]


def validate(input: str, schema: Any | None = None) -> dict:
    """Read-only canonicality check. Returns `{"ok": True}` when `input` is
    already canonical RAIF, else `{"ok": False, "errors": [...]}`. `schema` is
    an optional schema declaration string or a parsed schema."""
    repairs: list[dict] = []
    try:
        out = _fix_internal(input, repairs, _to_schema(schema))
        canonical = out["canonical"]
    except (RaifError, ValueError) as e:
        return {"ok": False, "errors": [str(e)]}
    if len(repairs) > 0:
        return {
            "ok": False,
            "errors": [f"non-canonical: {len(repairs)} repair(s) needed"],
        }
    if canonical != input:
        return {"ok": False, "errors": ["non-canonical: differs from canonical form"]}
    return {"ok": True}
