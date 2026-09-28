// Evidence classes.
//
// The whole point of this system is that "what the repository claims",
// "what can be derived from code", and "what was actually observed in a live
// system" are different kinds of claim with different failure modes. Collapsing
// them is how a catalog starts lying, so the distinction is explicit everywhere:
// in descriptors, in the graph, in query output, and in the migration report.
export const EVIDENCE_CLASSES = Object.freeze([
  "AUTHORED",
  "DERIVED",
  "OBSERVED_RUNTIME",
  "EXTERNAL_STANDARD",
  "REVIEWED_OVERRIDE",
  "UNRESOLVED",
]);

// Confidence is a separate axis from evidence class. It records *how* the claim
// was obtained, independently of who could vouch for it.
export const CONFIDENCE = Object.freeze([
  "direct", // read straight from the named authority system
  "deterministic", // reproducible function of committed inputs
  "declared", // asserted by a human-maintained document
  "reviewed", // a reviewer signed off on an interpretation
  "candidate", // heuristic; never allowed to become an elected fact
]);

// The single most important rule in the system.
export const CANDIDATE = "candidate";

// Map provenance record class -> evidence class, used when materialising
// relations and indexes.
export const PROV_TO_EVIDENCE = Object.freeze({
  declared: "AUTHORED",
  reviewed: "REVIEWED_OVERRIDE",
  observed: "DERIVED",
  validated: "DERIVED",
  runtime: "OBSERVED_RUNTIME",
  standard: "EXTERNAL_STANDARD",
});
