# Schema versioning and evolution are out of scope

Position mode binds field semantics to integer positions, which makes schema drift catastrophic for cross-time replay. We considered adding a version field, schema hash, registry, and append-only evolution rules — but that path leads to reimplementing what protobuf, Avro, and similar wire formats already solve. RAIF's actual scope is the **model → interpreter → tool-execution loop within a single process**, where the schema is supplied by the caller at parse time. If a system needs decoupled-in-time wire compatibility, it should use a format built for that purpose.

## Consequences

- Position mode requires schema agreement between emitter and consumer at parse time. The `s=<schema-id>` field stays as a human-readable hint, not a binding.
- Path mode and named mode are drift-tolerant by construction. Callers who cannot guarantee schema agreement should use those.
- RAIF-R's audit and replay role is scoped to "same schema generation." Replaying old RAIF-R against a later schema is best-effort and the caller's responsibility.
- The spec must say this explicitly — silence here would tempt people to use position mode as a durable wire format, which it isn't.

## Considered options

- `v=` version field, `sh=` schema hash, schema registry, append-only evolution rules. All rejected as scope creep into protobuf territory.
