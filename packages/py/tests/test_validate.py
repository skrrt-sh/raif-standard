"""Per-behavior unit tests for `validate` (read-only canonicality check). Each
test asserts one observable behavior through the public API."""

from __future__ import annotations

from raif import encode, validate


def test_canonical_input_is_valid():
    assert validate("body=hi\nto=a@b.com") == {"ok": True}


def test_empty_document_is_valid():
    assert validate("") == {"ok": True}


def test_noncanonical_ordering_is_invalid():
    result = validate("to=x\nbody=y")
    assert result["ok"] is False
    assert result["errors"]


def test_markdown_fence_is_noncanonical():
    result = validate("```\na=1\n```")
    assert result["ok"] is False


def test_mode_markers_are_noncanonical():
    result = validate("<raif>\na=1\n</raif>")
    assert result["ok"] is False


def test_garbage_is_invalid():
    result = validate("no_separator_here")
    assert result["ok"] is False
    assert result["errors"]


def test_validate_does_not_mutate_input():
    src = "body=hi\nto=a@b.com"
    validate(src)
    assert src == "body=hi\nto=a@b.com"


def test_encode_output_is_always_canonical():
    # validate(encode(x)) must be True — the round-trip invariant.
    raif = encode({"rows": [{"id": 1, "name": "Ann"}, {"id": 2, "name": "Bob"}]})
    assert validate(raif) == {"ok": True}


def test_non_canonical_key_order_is_invalid():
    # Keys out of canonical order: parses cleanly (no repairs) but differs from
    # the canonical form, so validate rejects it (mirrors the TS reference).
    result = validate("b=2\na=1")
    assert result["ok"] is False
    assert "differs from canonical" in result["errors"][0]
