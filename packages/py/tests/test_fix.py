"""Per-behavior unit tests for `fix` (RAIF -> canonical RAIF). Each test asserts
one observable behavior through the public API."""

from __future__ import annotations

from raif import encode, fix


def test_canonical_input_is_unchanged_no_repairs():
    canonical = "body=hi\nto=a@b.com"
    out = fix(canonical)
    assert out["ok"] is True
    assert out["canonical"] == canonical
    assert out["repairs"] == []


def test_markdown_fence_stripped_and_canonicalized():
    out = fix("```\na=1\nb=2\n```")
    assert out["ok"] is True
    assert out["canonical"] == "a=1\nb=2"
    assert any(r["kind"] == "markdown_stripped" for r in out["repairs"])


def test_mode_markers_stripped():
    out = fix("<raif>\na=1\n</raif>")
    assert out["ok"] is True
    assert out["canonical"] == "a=1"
    assert any(r["kind"] == "mode_markers_stripped" for r in out["repairs"])


def test_separator_coerced():
    out = fix("a:1")
    assert out["ok"] is True
    assert out["canonical"] == "a=1"
    assert any(r["kind"] == "separator_coerced" for r in out["repairs"])


def test_reorders_keys_to_canonical():
    out = fix("to=x\nbody=y")
    assert out["ok"] is True
    assert out["canonical"] == "body=y\nto=x"


def test_unrepairable_input_reports_error():
    out = fix("no_separator_here")
    assert out["ok"] is False
    assert "error" in out


def test_fix_is_idempotent():
    once = fix("```raif\nto=x\nbody=y\n```")
    assert once["ok"] is True
    twice = fix(once["canonical"])
    assert twice["ok"] is True
    assert twice["canonical"] == once["canonical"]
    assert twice["repairs"] == []


def test_fix_output_equals_encode_of_decoded_value():
    out = fix("rows[0]={id=1}\nrows[1]={id=2}")
    assert out["ok"] is True
    assert out["canonical"] == encode({"rows": [{"id": 1}, {"id": 2}]})


def test_fix_reports_failure_on_unrepairable_input():
    # An unrepairable input is reported, never raised (mirrors the TS catch).
    out = fix("this is not raif at all !!!")
    assert out["ok"] is False
    assert isinstance(out["error"], str)
