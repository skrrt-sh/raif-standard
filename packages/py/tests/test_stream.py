"""Behavior tests for the incremental (streaming) RAIF-G decoder.

The streaming decoder consumes RAIF-G in arbitrary text chunks and must reconcile
to the same result a full `decode_lenient` produces over the whole buffer — no
matter where the chunk boundaries fall. The conformance corpus is the oracle.
"""

from __future__ import annotations

import json

import pytest

from conftest import CONFORMANCE_DIR
from raif import decode_lenient
from raif.stream import StreamingDecoder


def _cases(name: str) -> list[dict]:
    data = json.loads((CONFORMANCE_DIR / name).read_text())
    return data["cases"]


def _feed(text: str, chunks: list[str], schema=None) -> StreamingDecoder:
    dec = StreamingDecoder(schema)
    for c in chunks:
        dec.push(c)
    return dec


def _char_chunks(text: str) -> list[str]:
    return list(text)


def test_finalize_returns_decoded_value_for_complete_input():
    dec = StreamingDecoder()
    dec.push("a=1\nb=hello")
    assert dec.finalize().value == {"a": 1, "b": "hello"}


def test_streaming_decoder_is_exported_without_pulling_a_runtime():
    # The streaming/schema surface is stdlib-only: importing it must not drag in
    # an inference runtime (the core `dependencies = []` mandate).
    import sys

    import raif  # noqa: F401
    import raif.schema_bridge  # noqa: F401

    assert hasattr(raif, "StreamingDecoder")
    assert "vllm" not in sys.modules
    assert "torch" not in sys.modules


@pytest.mark.parametrize("case", _cases("decode.json"), ids=lambda c: c["name"])
def test_finalize_matches_full_decode_char_by_char(case):
    """Fed one character at a time, finalize must equal a full decode_lenient."""
    full = decode_lenient(case["input"], case["schema"])
    streamed = _feed(case["input"], _char_chunks(case["input"]), case["schema"])
    assert streamed.finalize().value == full["value"]


@pytest.mark.parametrize("case", _cases("lenient.json"), ids=lambda c: c["name"])
def test_finalize_surfaces_truncation_char_by_char(case):
    """Truncation/errors/repairs must survive char-by-char chunking."""
    res = _feed(case["input"], _char_chunks(case["input"]), case["schema"]).finalize()
    assert res.value == case["expected"]
    assert res.truncated == case["truncated"]
    assert len(res.errors) == case["errorCount"]
    assert sorted(r["kind"] for r in res.repairs) == sorted(case["repairs"])
