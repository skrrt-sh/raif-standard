"""Per-behavior unit tests for `encode`, organized as the vertical slices the
encoder was built/verified against. Each test asserts ONE observable behavior
through the public API (never an internal helper), so they survive refactors.

These are the behavior-level spec; `test_conformance.py` (the full shared
corpus) and `test_differential.py` (vs the TS reference) are the acceptance
gates layered on top.
"""

from __future__ import annotations

import pytest

from raif import encode

# ── slice 1: flat scalars + canonical key sort ──────────────────────────────


def test_flat_string_scalar():
    assert encode({"to": "a@b.com"}) == "to=a@b.com"


def test_keys_sorted_by_codepoint():
    # Keys emit in canonical (code-point) order regardless of insertion order.
    assert encode({"to": "x", "body": "y", "subject": "z"}) == (
        "body=y\nsubject=z\nto=x"
    )


def test_numbers_and_bools_and_null():
    assert encode({"a": 1, "b": 2.5, "c": True, "d": False, "e": None}) == (
        "a=1\nb=2.5\nc=true\nd=false\ne=null"
    )


def test_integral_float_renders_without_decimal():
    # JS Number -> string: 5.0 stringifies as "5".
    assert encode({"n": 5.0}) == "n=5"


def test_non_object_top_level_rejected():
    with pytest.raises(ValueError):
        encode([1, 2, 3])
    with pytest.raises(ValueError):
        encode("nope")


# ── slice 2: string value-wrap / delimiter rules ────────────────────────────


def test_literal_lookalike_string_uses_type_tag():
    # A string that would otherwise parse as a literal must be protected; the
    # canonical protection is the type-tag form when safe.
    assert encode({"a": "true"}) == "a:s=true"
    assert encode({"a": "42"}) == "a:s=42"
    assert encode({"a": "null"}) == "a:s=null"


def test_whitespace_edges_force_wrap():
    # Edge whitespace makes the type-tag form unsafe (document trim would eat
    # it), so the value is `<<<...>>>`-wrapped.
    assert encode({"a": " x "}) == "a=<<< x >>>"


def test_empty_and_container_lookalike_strings_use_type_tag():
    # These need protection (would parse as literals/containers) but the
    # type-tag form is safe and shorter, so it is canonical.
    assert encode({"a": ""}) == "a:s="
    assert encode({"a": "[]"}) == "a:s=[]"
    assert encode({"a": "{}"}) == "a:s={}"


def test_plain_string_with_separators_stays_bare():
    # `,` `:` `[` `]` are safe bare — the parser locks the separator first.
    assert encode({"a": "1,2,3"}) == "a=1,2,3"
    assert encode({"a": "14:02:33"}) == "a=14:02:33"


def test_multiline_string_uses_bare_block():
    assert encode({"doc": "line one\nline two"}) == "doc=<<<\nline one\nline two\n>>>"


def test_multiline_string_with_closer_collision_uses_nonce():
    out = encode({"doc": "a\n>>>\nb"})
    # nonce form: opener and closer carry the same hex nonce
    assert out.startswith("doc=<<<")
    first = out.split("\n", 1)[0]
    nonce = first[len("doc=<<<") :]
    assert nonce and out.endswith(f">>>{nonce}")


# ── slice 3: nested objects / inline-object form ────────────────────────────


def test_nested_object_path_mode():
    # A single-key nested object: path mode is shorter than the inline form
    # (`user.name=...` < `user={name=...}`), so it is the cheapest pick.
    assert encode({"user": {"name": "a long enough value to win"}}) == (
        "user.name=a long enough value to win"
    )


def test_inline_object_chosen_when_shorter():
    # A nested flat-primitive object collapses to the inline form when it is
    # strictly shorter than the path form (canonical profile, cheapest pick).
    out = encode({"o": {"a": 1, "b": 2, "c": 3}})
    assert out == "o={a=1,b=2,c=3}"


# ── slice 4: null + empty-container literals ────────────────────────────────


def test_empty_array_literal():
    assert encode({"xs": []}) == "xs=[]"


def test_empty_object_literal():
    assert encode({"o": {}}) == "o={}"


def test_root_empty_object_is_empty_string():
    assert encode({}) == ""


# ── slice 5: arrays — inline-object form (canonical picks the cheapest) ──────


def test_array_heterogeneous_objects_emit_inline_object_cells():
    # Objects with differing key sets can't be a table; each row is encoded as
    # an inline object. The canonical pick collapses these into the array
    # literal (cheaper than repeating the `xs[i]=` prefix).
    out = encode({"xs": [{"a": 1}, {"b": 2, "c": 3}]})
    assert out == "xs=[\n{a=1}\n{b=2,c=3}\n]"


# ── slice 6: arrays — table mode ────────────────────────────────────────────


def test_array_homogeneous_objects_table():
    # Wide homogeneous rows: the shared header makes table mode the cheapest.
    out = encode(
        {
            "rows": [
                {"id": 1, "name": "Alice", "ok": True},
                {"id": 2, "name": "Bob", "ok": False},
            ]
        }
    )
    assert out == "rows::id,name,ok\nrows[0]=1,Alice,true\nrows[1]=2,Bob,false"


# ── slice 7: arrays — array-literal mode + cheapest pick ─────────────────────


def test_primitive_array_uses_literal_when_cheapest():
    out = encode({"xs": [1, 2, 3, 4, 5]})
    assert out == "xs=[\n1\n2\n3\n4\n5\n]"


# ── slice 8: generation vs canonical profile ────────────────────────────────


def test_generation_profile_avoids_inline_object_collapse():
    # The inline-object collapse is canonical-only; generation keeps path mode.
    assert encode({"o": {"a": 1, "b": 2}}, {"profile": "generation"}) == (
        "o.a=1\no.b=2"
    )


def test_generation_profile_orders_units_for_truncation():
    # Single-line leaves come before multi-line table/literal/block units.
    out = encode(
        {"rows": [{"id": 1}, {"id": 2}], "z": "last", "a": "first"},
        {"profile": "generation"},
    )
    lines = out.split("\n")
    # the two single-line leaves precede the table unit
    assert lines[0] == "a=first"
    assert lines[1] == "z=last"
    assert lines[2].startswith("rows::")


def test_markers_option_frames_document():
    assert encode({"a": 1}, {"markers": True}) == "<raif>\na=1\n</raif>"
    assert encode({}, {"markers": True}) == "<raif>\n</raif>"


# ── pathological keys ───────────────────────────────────────────────────────


def test_key_with_structural_char_is_wrapped():
    assert encode({"a.b": 1}) == "<<<a.b>>>=1"


def test_key_with_delimiter_rejected():
    with pytest.raises(ValueError):
        encode({"a<<<b": 1})


def test_non_string_keys_rejected_with_value_error():
    # JSON objects have string keys; a dict with non-string keys is rejected
    # with a stable ValueError (not a raw TypeError), at any nesting depth.
    with pytest.raises(ValueError):
        encode({1: "a"})
    with pytest.raises(ValueError):
        encode({"nested": {2: "b"}})
    with pytest.raises(ValueError):
        encode({"arr": [{3: "c"}]})
