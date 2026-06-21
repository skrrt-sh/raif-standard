"""RAIF — a token-efficient, repair-tolerant interchange format for LLM I/O.

Pure-Python implementation of the full RAIF surface: `encode`, `decode`,
`decode_lenient`, `fix`, and `validate`, plus schema parsing. Output is
byte-identical to the canonical TypeScript reference and pinned by a shared
conformance corpus. Stdlib only; no runtime dependencies.

    >>> from raif import encode, decode
    >>> encode({"to": "a@b.com", "subject": "hi"})
    'subject=hi\\nto=a@b.com'
    >>> decode("a=1\\nb=hi")
    {'ok': True, 'value': {'a': 1, 'b': 'hi'}, 'repairs': []}
"""

from __future__ import annotations

from .decode import (
    RaifError,
    RaifSchema,
    SchemaNode,
    decode,
    decode_lenient,
    parse_schema,
)
from .encode import EncodeOptions, EncodeProfile, encode
from .fix import fix
from .stream import StreamingDecoder, StreamResult
from .validate import validate

__all__ = [
    "encode",
    "decode",
    "decode_lenient",
    "fix",
    "validate",
    "parse_schema",
    "RaifSchema",
    "SchemaNode",
    "RaifError",
    "EncodeOptions",
    "EncodeProfile",
    "StreamingDecoder",
    "StreamResult",
]

__version__ = "0.6.0"
