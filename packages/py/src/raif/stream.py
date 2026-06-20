"""Incremental (streaming) RAIF-G decoder.

Runtime-agnostic: consumes RAIF-G text deltas and reconciles, at `finalize`, to
the exact value a full `decode_lenient` produces over the accumulated buffer.
Stdlib + `raif.decode` only — no inference-runtime imports here.
"""

from __future__ import annotations

from typing import Any, NamedTuple

from .decode import decode_lenient


class StreamResult(NamedTuple):
    value: dict
    repairs: list[dict]
    errors: list[dict]
    truncated: bool


class StreamingDecoder:
    """Accumulates RAIF-G chunks; `finalize` decodes the whole buffer."""

    def __init__(self, schema: Any | None = None) -> None:
        self._schema = schema
        self._buf: list[str] = []

    def push(self, delta: str) -> None:
        self._buf.append(delta)

    def finalize(self) -> StreamResult:
        res = decode_lenient("".join(self._buf), self._schema)
        return StreamResult(
            value=res["value"],
            repairs=res["repairs"],
            errors=res["errors"],
            truncated=res["truncated"],
        )
