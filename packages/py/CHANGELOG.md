# Changelog

All notable changes to the Python `raif` package are documented here. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
