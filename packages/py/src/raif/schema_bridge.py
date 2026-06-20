"""JSON-Schema -> RAIF `<schema>` declaration bridge.

Translates the JSON Schema carried by an OpenAI tool definition into the compact
RAIF declaration (fine_tune_plan §3.2) used as a prompt cue and an optional
decode-time schema. Constructs RAIF can't express degrade explicitly: the field
is reported in `degraded_fields` rather than emitted as a wrong type.

Stdlib only.
"""

from __future__ import annotations

# JSON Schema scalar type -> RAIF type code.
_SCALAR = {"string": "s", "integer": "n", "number": "n", "boolean": "b"}


def _union_code(sub: dict) -> str | None:
    """Shared RAIF code if every `anyOf`/`oneOf` branch is the same scalar, else None."""
    branches = sub.get("anyOf") or sub.get("oneOf")
    if not branches:
        return None
    codes = {_SCALAR.get(b.get("type")) for b in branches}
    if len(codes) == 1 and None not in codes:
        return next(iter(codes))
    return None


def _enum_code(sub: dict) -> str | None:
    """Shared RAIF code if every `enum` value is the same scalar kind, else None."""
    values = sub.get("enum")
    if not values:
        return None
    codes = {_value_code(v) for v in values}
    if len(codes) == 1 and None not in codes:
        return next(iter(codes))
    return None


def _value_code(v: object) -> str | None:
    if isinstance(v, bool):  # bool is a subclass of int — check first
        return "b"
    if isinstance(v, (int, float)):
        return "n"
    if isinstance(v, str):
        return "s"
    return None


def json_schema_to_raif_schema(schema: dict) -> tuple[str, list[str]]:
    """Return `(declaration, degraded_fields)` for a JSON-Schema object.

    `declaration` is newline-joined `PATH:TYPE` lines (no `<schema>` tags).
    `degraded_fields` lists dotted paths whose type could not be represented.
    """
    lines: list[str] = []
    degraded: list[str] = []
    _emit_object(schema, "", lines, degraded, schema, set())
    return "\n".join(lines), degraded


def tool_to_schema(tool: dict) -> tuple[str, list[str]]:
    """`(declaration, degraded_fields)` for an OpenAI tool's `function.parameters`."""
    params = (tool.get("function") or {}).get("parameters") or {}
    return json_schema_to_raif_schema(params)


def _emit_object(
    schema: dict,
    prefix: str,
    lines: list[str],
    degraded: list[str],
    root: dict,
    seen: set[str],
) -> None:
    props = schema.get("properties") or {}
    required = set(schema.get("required") or [])
    for name, sub in props.items():
        path = name if prefix == "" else f"{prefix}.{name}"
        opt = "" if name in required else "?"
        _emit_field(path, sub, opt, lines, degraded, root, seen)


def _emit_field(
    path: str,
    sub: dict,
    opt: str,
    lines: list[str],
    degraded: list[str],
    root: dict,
    seen: set[str],
) -> None:
    ref = sub.get("$ref")
    if ref is not None:
        if ref in seen:  # cycle: cannot represent recursion
            degraded.append(path)
            return
        target = _resolve_ref(ref, root)
        if target is None:
            degraded.append(path)
            return
        _emit_field(path, target, opt, lines, degraded, root, seen | {ref})
        return
    jtype = sub.get("type")
    code = _SCALAR.get(jtype) or _union_code(sub) or _enum_code(sub)
    if code is not None:
        lines.append(f"{path}:{code}{opt}")
        return
    if jtype == "array":
        item = sub.get("items")
        if not isinstance(item, dict):  # tuple-validation `items` list, or absent
            item = {}
        item_code = _SCALAR.get(item.get("type"))
        if item_code is not None:
            lines.append(f"{path}[]:{item_code}{opt}")
            return
        if item.get("type") == "object":
            lines.append(f"{path}[]:o{opt}")
            return
    if jtype == "object":
        if opt:
            lines.append(f"{path}:o?")
        _emit_object(sub, path, lines, degraded, root, seen)
        return
    degraded.append(path)


def _resolve_ref(ref: str, root: dict) -> dict | None:
    """Resolve a local JSON-pointer `$ref` (`#/$defs/X`); None if external/missing."""
    if not ref.startswith("#/"):
        return None
    node: object = root
    for token in ref[2:].split("/"):
        token = token.replace("~1", "/").replace("~0", "~")
        if not isinstance(node, dict) or token not in node:
            return None
        node = node[token]
    return node if isinstance(node, dict) else None
