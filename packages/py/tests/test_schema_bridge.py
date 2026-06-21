"""Behavior tests for the JSON-Schema -> RAIF `<schema>` declaration bridge.

Every generated declaration must (a) match the documented declaration grammar
(fine_tune_plan §3.2) and (b) round-trip through `parse_schema` without error.
Unmappable constructs degrade explicitly and are reported, never silently wrong.
"""

from __future__ import annotations

from raif import parse_schema
from raif.schema_bridge import json_schema_to_raif_schema, tool_to_schema


def test_flat_required_scalars():
    schema = {
        "type": "object",
        "properties": {
            "to": {"type": "string"},
            "priority": {"type": "integer"},
            "urgent": {"type": "boolean"},
        },
        "required": ["to", "priority", "urgent"],
    }
    decl, degraded = json_schema_to_raif_schema(schema)
    assert decl == "to:s\npriority:n\nurgent:b"
    assert degraded == []
    parse_schema(decl)  # must not raise


def test_scalar_array():
    schema = {
        "type": "object",
        "properties": {"tags": {"type": "array", "items": {"type": "string"}}},
        "required": ["tags"],
    }
    decl, degraded = json_schema_to_raif_schema(schema)
    assert decl == "tags[]:s"
    assert degraded == []
    parse_schema(decl)


def test_array_of_objects_uses_o_code():
    schema = {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"id": {"type": "integer"}},
                },
            }
        },
        "required": ["items"],
    }
    decl, degraded = json_schema_to_raif_schema(schema)
    assert decl == "items[]:o"
    assert degraded == []
    parse_schema(decl)


def test_required_nested_object_expands_to_dotted_paths():
    schema = {
        "type": "object",
        "properties": {
            "user": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "handle": {"type": "string"},
                },
                "required": ["id", "handle"],
            }
        },
        "required": ["user"],
    }
    decl, degraded = json_schema_to_raif_schema(schema)
    assert decl == "user.id:n\nuser.handle:s"
    assert degraded == []
    parse_schema(decl)


def test_optional_nested_object_preserves_parent_optionality():
    # Critique C4: an optional intermediate object must not silently lose `?`.
    schema = {
        "type": "object",
        "properties": {
            "user": {
                "type": "object",
                "properties": {"id": {"type": "integer"}},
                "required": ["id"],
            }
        },
        "required": [],
    }
    decl, degraded = json_schema_to_raif_schema(schema)
    assert decl == "user:o?\nuser.id:n"
    assert degraded == []
    root = parse_schema(decl).root
    assert root.children["user"].optional is True
    assert root.children["user"].children["id"].optional is False


def test_heterogeneous_union_degrades_not_emitted():
    # Critique I1: `string|integer` must NOT become `:o` (would corrupt scalars).
    schema = {
        "type": "object",
        "properties": {"val": {"anyOf": [{"type": "string"}, {"type": "integer"}]}},
        "required": ["val"],
    }
    decl, degraded = json_schema_to_raif_schema(schema)
    assert decl == ""  # field omitted, inference handles it at decode
    assert degraded == ["val"]


def test_homogeneous_union_keeps_shared_scalar_type():
    schema = {
        "type": "object",
        "properties": {"val": {"anyOf": [{"type": "integer"}, {"type": "number"}]}},
        "required": ["val"],
    }
    decl, degraded = json_schema_to_raif_schema(schema)
    assert decl == "val:n"
    assert degraded == []


def test_realistic_tool_full_declaration_round_trips():
    tool = {
        "type": "function",
        "function": {
            "name": "get_forecast",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string"},
                    "units": {"enum": ["metric", "imperial"]},
                    "days": {"type": "integer"},
                    "hourly": {"type": "boolean"},
                    "coords": {
                        "type": "object",
                        "properties": {
                            "lat": {"type": "number"},
                            "lng": {"type": "number"},
                        },
                        "required": ["lat", "lng"],
                    },
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["city", "units"],
            },
        },
    }
    decl, degraded = tool_to_schema(tool)
    assert decl == (
        "city:s\nunits:s\ndays:n?\nhourly:b?\n"
        "coords:o?\ncoords.lat:n\ncoords.lng:n\ntags[]:s?"
    )
    assert degraded == []
    parse_schema(decl)  # the prompt cue is valid RAIF schema syntax


def test_tool_to_schema_extracts_function_parameters():
    tool = {
        "type": "function",
        "function": {
            "name": "get_weather",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }
    decl, degraded = tool_to_schema(tool)
    assert decl == "city:s"
    assert degraded == []


def test_tool_without_parameters_yields_empty_decl():
    decl, degraded = tool_to_schema({"type": "function", "function": {"name": "ping"}})
    assert decl == ""
    assert degraded == []


def test_tuple_items_array_degrades_without_crashing():
    # `items` may legally be a list (tuple validation) — must degrade, not crash.
    schema = {
        "type": "object",
        "properties": {
            "pair": {
                "type": "array",
                "items": [{"type": "string"}, {"type": "integer"}],
            }
        },
        "required": ["pair"],
    }
    decl, degraded = json_schema_to_raif_schema(schema)
    assert decl == ""
    assert degraded == ["pair"]


def test_typeless_enum_infers_scalar_from_values():
    schema = {
        "type": "object",
        "properties": {"unit": {"enum": ["celsius", "fahrenheit"]}},
        "required": ["unit"],
    }
    decl, degraded = json_schema_to_raif_schema(schema)
    assert decl == "unit:s"
    assert degraded == []


def test_mixed_type_enum_degrades():
    schema = {
        "type": "object",
        "properties": {"x": {"enum": ["a", 1]}},
        "required": ["x"],
    }
    decl, degraded = json_schema_to_raif_schema(schema)
    assert decl == ""
    assert degraded == ["x"]


def test_ref_resolves_within_document():
    schema = {
        "type": "object",
        "$defs": {
            "Addr": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            }
        },
        "properties": {"addr": {"$ref": "#/$defs/Addr"}},
        "required": ["addr"],
    }
    decl, degraded = json_schema_to_raif_schema(schema)
    assert decl == "addr.city:s"
    assert degraded == []
    parse_schema(decl)


def test_recursive_ref_terminates_and_degrades_cycle():
    schema = {
        "type": "object",
        "$defs": {
            "Node": {
                "type": "object",
                "properties": {"next": {"$ref": "#/$defs/Node"}},
            }
        },
        "properties": {"root": {"$ref": "#/$defs/Node"}},
        "required": ["root"],
    }
    decl, degraded = json_schema_to_raif_schema(schema)  # must not recurse forever
    assert degraded == ["root.next"]


def test_optional_field_gets_question_mark():
    schema = {
        "type": "object",
        "properties": {"to": {"type": "string"}, "cc": {"type": "string"}},
        "required": ["to"],
    }
    decl, degraded = json_schema_to_raif_schema(schema)
    assert decl == "to:s\ncc:s?"
    assert degraded == []
