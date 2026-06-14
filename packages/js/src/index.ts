// Public entry point for the `raif` package.
//
// RAIF is a repairable, JSON-alternative wire format for LLM tool-call output.
// The complete reference implementation lives in `./raif.ts`; this module just
// re-exports the public surface so the package has a single, stable entry.
export * from "./raif.ts";
