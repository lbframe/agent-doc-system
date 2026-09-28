// Adapter contract.
//
// An adapter knows one technology's vocabulary: how to recognise a unit root,
// how to read its manifest, and which deterministic facts it can extract. It
// must NOT know about the repository's folder layout, its domain names, its
// event names or its providers. Everything project-specific arrives through
// agentdoc.config.yaml.
//
// Two phases per unit:
//   detect(repo, root)      -> does this root host a unit of my kind?
//   extract(ctx, unit)      -> deterministic facts + provenance
//
// Adapters are pure: same checkout, same facts, same order.
export class Adapter {
  constructor({ name, version = "1.0.0", kind = "generic" }) {
    this.name = name;
    this.version = version;
    this.kind = kind; // generic | unit-marker | manifest | source | contract | ci
  }
  // Unit-marker adapters answer: does `root` contain a unit I recognise?
  // Returning a marker path is what makes the root eligible.
  detect(ctx, root) { return null; }
  // Manifest/source adapters contribute facts for an already-eligible unit.
  extract(ctx, unit) {}
  // Contract adapters validate and index contract files listed by config.
  contracts(ctx) { return []; }
}
