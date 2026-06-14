"""Conformance tests: run the shared `conformance/*.json` corpus against the
pure-Python RAIF implementation. No `bun` required — this is the parity gate
that must pass everywhere.

Each corpus file is `{spec, function, cases:[...]}`:
  encode:   {input(json), opts, expected(raif)}
  decode:   {input(raif), schema, expected(json)} or {error: true}
  lenient:  {input, expected, truncated, errorCount}
  fix:      {input, expected} or {error: true}
  validate: {input, schema, valid}
"""

from __future__ import annotations

import json

import pytest

from conftest import CONFORMANCE_DIR
from raif import decode, decode_lenient, encode, fix, parse_schema, validate


def _load(name: str) -> list[dict]:
    path = CONFORMANCE_DIR / f"{name}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["cases"]


def _ids(cases: list[dict]) -> list[str]:
    return [c.get("name", str(i)) for i, c in enumerate(cases)]


def _schema_arg(case: dict):
    schema = case.get("schema")
    return parse_schema(schema) if schema else None


def _repair_kinds(result: dict) -> list[str]:
    """Sorted repair-kind list from a decode/fix/lenient result.

    The Python port exposes `repairs` as a list of `{"kind", "detail"?}` dicts —
    the same shape the TS reference emits."""
    return sorted(r["kind"] for r in result["repairs"])


def _assert_repairs(result: dict, case: dict) -> None:
    if "repairs" in case:
        assert _repair_kinds(result) == sorted(case["repairs"])


# ─── encode ────────────────────────────────────────────────────────────────

ENCODE_CASES = _load("encode")


@pytest.mark.parametrize("case", ENCODE_CASES, ids=_ids(ENCODE_CASES))
def test_encode(case: dict):
    opts = case.get("opts") or {}
    if case.get("error"):
        with pytest.raises((ValueError, Exception)):
            encode(case["input"], opts)
        return
    result = encode(case["input"], opts)
    assert result == case["expected"]


# ─── decode ────────────────────────────────────────────────────────────────

DECODE_CASES = _load("decode")


@pytest.mark.parametrize("case", DECODE_CASES, ids=_ids(DECODE_CASES))
def test_decode(case: dict):
    result = decode(case["input"], _schema_arg(case))
    if case.get("error"):
        assert result["ok"] is False
        return
    assert result["ok"] is True, result.get("error")
    assert result["value"] == case["expected"]
    _assert_repairs(result, case)


# ─── lenient ─────────────────────────────────────────────────────────────────

LENIENT_CASES = _load("lenient")


@pytest.mark.parametrize("case", LENIENT_CASES, ids=_ids(LENIENT_CASES))
def test_lenient(case: dict):
    result = decode_lenient(case["input"], _schema_arg(case))
    assert result["value"] == case["expected"]
    assert result["truncated"] == case["truncated"]
    assert len(result["errors"]) == case["errorCount"]
    _assert_repairs(result, case)


# ─── fix ─────────────────────────────────────────────────────────────────────

FIX_CASES = _load("fix")


@pytest.mark.parametrize("case", FIX_CASES, ids=_ids(FIX_CASES))
def test_fix(case: dict):
    result = fix(case["input"], _schema_arg(case))
    if case.get("error"):
        assert result["ok"] is False
        return
    assert result["ok"] is True, result.get("error")
    assert result["canonical"] == case["expected"]
    _assert_repairs(result, case)


# ─── validate ────────────────────────────────────────────────────────────────

VALIDATE_CASES = _load("validate")


@pytest.mark.parametrize("case", VALIDATE_CASES, ids=_ids(VALIDATE_CASES))
def test_validate(case: dict):
    result = validate(case["input"], _schema_arg(case))
    assert result["ok"] == case["valid"]
