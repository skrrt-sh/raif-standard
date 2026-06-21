# Changelog

All notable changes to the Python `raif` package are documented here. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.6.0] - 2026-06-21

### Added

- `schema_bridge`: convert JSON Schema and OpenAI tool definitions into the
  compact RAIF schema-declaration grammar (`json_schema_to_raif_schema`,
  `tool_to_schema`), reporting types that can't be represented in
  `degraded_fields` rather than emitting a wrong type. Powers the transparent
  `<schema>` cue injected by the RAIF vLLM plugin.
- `StreamingDecoder` / `StreamResult`: incremental RAIF-G → JSON decoding for
  streamed generations.

### Notes

- Both additions are pure-Python, stdlib-only, and backward compatible; the
  existing `encode`/`decode`/`fix`/`validate` APIs are unchanged.

## [0.5.0] - 2026-06-14

### Added

- Full RAIF surface in pure Python: `encode`, `decode`, `decode_lenient`,
  `fix`, `validate`, plus `parse_schema` and the schema types.
- `encode` ported from the canonical TypeScript reference, byte-identical for
  both the `canonical` and `generation` profiles (pinned by the shared
  conformance corpus).
- `fix` (RAIF → canonical RAIF, idempotent) and `validate` (read-only
  canonicality check).
- Type information (PEP 561 `py.typed`); stdlib only, no runtime dependencies.

### Notes

- Previously the Python port was decode-only and the project depended on `bun`
  at runtime to reach the encoder. That runtime dependency is removed: `bun` is
  now a dev-only differential-test oracle.
