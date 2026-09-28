// Shared contract-consumer resolution.
//
// A cross-component boundary is a contract plus its consumers. Consumers are
// discovered deterministically: a unit that references the canonical contract
// file from a source or build-configuration file, other than the provider's own
// unit, consumes that contract. Documentation mentions are excluded so a doc
// that quotes a contract path cannot manufacture a dependency edge.
import path from "node:path";

const CODE_EXT = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|go|py|rb|java|kt|rs|ex|exs|cs|php|swift|gradle|proto|graphql|sql)$/;
const CONFIG_NAMES = new Set([
  "package.json", "go.mod", "buf.gen.yaml", "buf.yaml", "buf.work.yaml",
  "codegen.yaml", "codegen.yml", "openapi-ts.config.ts", "openapi-ts.config.js",
  "oapi-codegen.yaml", "oapi-codegen.yml", "turbo.json", "Makefile", "justfile",
  "Taskfile.yml", "build.gradle", "build.gradle.kts", "pom.xml",
]);
const DOC_EXT = /\.(md|mdx|txt|adoc|rst)$/;

export function contractReferenceSites(repo, unit) {
  const out = new Map(); // file -> true
  for (const f of repo.walk(unit.root)) {
    const base = path.posix.basename(f);
    if (DOC_EXT.test(f)) continue;
    if (f.includes("/docs/") || f.startsWith("docs/")) continue;
    if (!CODE_EXT.test(f) && !CONFIG_NAMES.has(base)) continue;
    out.set(f, true);
  }
  return out;
}

// Resolve consumers for a contract file. Returns Map<componentRef, string[]>.
// The per-unit file inventory is built once and cached on the context, so a
// repository with many contracts does not re-walk every unit per contract.
export function resolveContractConsumers(ctx, contractRef, providerRef) {
  if (!ctx.referenceIndex) {
    const perUnit = new Map();
    for (const unit of ctx.discovery.eligible) {
      if (!unit.component) continue;
      perUnit.set(unit.component.ref, [...contractReferenceSites(ctx.repo, unit).keys()].sort());
    }
    ctx.referenceIndex = perUnit;
  }
  const out = new Map();
  for (const [ref, files] of ctx.referenceIndex) {
    if (ref === providerRef) continue;
    const hits = files.filter((f) => ctx.repo.readText(f).includes(contractRef));
    if (hits.length) out.set(ref, hits);
  }
  return out;
}

// A unit that names the contract in its own build config is a stronger signal
// than a stray mention in source.
export function isBuildConfig(file) {
  return CONFIG_NAMES.has(path.posix.basename(file));
}
