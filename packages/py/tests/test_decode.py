"""Per-behavior unit tests for `decode` / `decode_lenient` / `parse_schema`,
asserting observable behavior through the public API. Self-contained (no `bun`);
the differential test covers oracle parity over generated inputs.
"""

from __future__ import annotations

import pytest

from raif import RaifError, decode, decode_lenient, parse_schema

# ── primitives & inference ──────────────────────────────────────────────────


def test_scalars_inferred():
    r = decode("a=1\nb=2.5\nc=true\nd=false\ne=null\nf=hello")
    assert r["ok"] is True
    assert r["value"] == {
        "a": 1,
        "b": 2.5,
        "c": True,
        "d": False,
        "e": None,
        "f": "hello",
    }


def test_wrapped_string_keeps_literal_text():
    r = decode("s=<<<wrapped value>>>\nlit=<<<true>>>\nnum=<<<42>>>")
    assert r["ok"] is True
    assert r["value"] == {"s": "wrapped value", "lit": "true", "num": "42"}


def test_empty_containers():
    r = decode("empty_arr=[]\nempty_obj={}")
    assert r["ok"] is True
    assert r["value"] == {"empty_arr": [], "empty_obj": {}}


# ── typed leaves ────────────────────────────────────────────────────────────


def test_typed_leaves():
    r = decode("name:s=null\npri:n=2\nok:b=true\ntext:t=verbatim : value")
    assert r["ok"] is True
    assert r["value"] == {
        "name": "null",
        "pri": 2,
        "ok": True,
        "text": "verbatim : value",
    }


# ── paths, tables, inline objects, array literals ───────────────────────────


def test_nested_paths_and_indices():
    r = decode("user.profile.name=Ann\nuser.tags[0]=a\nuser.tags[1]=b")
    assert r["ok"] is True
    assert r["value"] == {"user": {"profile": {"name": "Ann"}, "tags": ["a", "b"]}}


def test_table_mode():
    r = decode("rows::id,name,active\nrows[0]=1,Ann,true\nrows[1]=2,Bob,false")
    assert r["ok"] is True
    assert r["value"] == {
        "rows": [
            {"id": 1, "name": "Ann", "active": True},
            {"id": 2, "name": "Bob", "active": False},
        ]
    }


def test_inline_object_with_nested_flatten():
    r = decode("o={user={id=7,name=Ann},active=true}")
    assert r["ok"] is True
    assert r["value"] == {"o": {"user": {"id": 7, "name": "Ann"}, "active": True}}


def test_array_literal():
    r = decode("xs=[\n1\n2\n3\n]")
    assert r["ok"] is True
    assert r["value"] == {"xs": [1, 2, 3]}


def test_multiline_block():
    r = decode("doc=<<<\nline one\nline two\n>>>")
    assert r["ok"] is True
    assert r["value"] == {"doc": "line one\nline two"}


# ── repair branches ─────────────────────────────────────────────────────────


def test_markdown_fence_repair():
    r = decode("```\na=1\nb=2\n```")
    assert r["ok"] is True
    assert r["value"] == {"a": 1, "b": 2}
    assert any(x["kind"] == "markdown_stripped" for x in r["repairs"])


def test_crlf_normalized():
    r = decode("a=1\r\nb=2\r\nc=3")
    assert r["ok"] is True
    assert r["value"] == {"a": 1, "b": 2, "c": 3}


def test_repeated_keys_auto_indexed():
    r = decode("tag=red\ntag=green\ntag=blue")
    assert r["ok"] is True
    assert r["value"] == {"tag": ["red", "green", "blue"]}
    assert any(x["kind"] == "repeated_keys_indexed" for x in r["repairs"])


def test_multiline_brace_flatten():
    r = decode("a={\nb={\nc=1\n}\nd=2\n}")
    assert r["ok"] is True
    assert r["value"] == {"a": {"b": {"c": 1}, "d": 2}}


# ── error cases ─────────────────────────────────────────────────────────────


def test_missing_separator_rejected():
    r = decode("no_separator_here")
    assert r["ok"] is False
    assert "error" in r


def test_sparse_array_rejected():
    r = decode("a[0]=1\na[2]=3")
    assert r["ok"] is False


# ── lenient ─────────────────────────────────────────────────────────────────


def test_lenient_recovers_partial_and_flags_truncation():
    r = decode_lenient("<raif>\ncity=Oslo\nlat")
    assert r["value"] == {"city": "Oslo"}
    assert r["truncated"] is True
    assert len(r["errors"]) == 1


def test_lenient_never_raises_on_garbage():
    r = decode_lenient("%%%\n###")
    assert isinstance(r["value"], dict)


# ── schema-typed decode ─────────────────────────────────────────────────────


def test_schema_typed_decode_forces_string():
    schema = parse_schema("priority:s\nnote:s?")
    r = decode("priority=2\nnote=hi", schema)
    assert r["ok"] is True
    assert r["value"] == {"priority": "2", "note": "hi"}


def test_schema_unknown_field_rejected():
    schema = parse_schema("a:n")
    r = decode("a=1\nb=2", schema)
    assert r["ok"] is False


def test_raif_error_is_exported():
    assert issubclass(RaifError, Exception)


def test_decode_lenient_with_schema_argument():
    schema = parse_schema("a:n")
    r = decode_lenient("a=1", schema)
    assert r["value"] == {"a": 1}


def test_parse_schema_rejects_bad_type():
    with pytest.raises(RaifError):
        parse_schema("a:zzz")
