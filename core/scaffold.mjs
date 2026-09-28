#!/usr/bin/env node
// CREATE-mode scaffolding.
//
// Generates a descriptor skeleton from what the repository can actually prove.
// The generation rules are deliberately conservative:
//   - a component descriptor is written only for a discovered unit with a name
//     the unit itself supplies (package name, module path, or directory name);
//   - a description is a template sentence naming the artifact evidence, never
//     an invented product claim;
//   - a placement that cannot be inferred is left out, and the compiler will
//     report it as a question rather than the scaffolder guessing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentDocError, CODES } from "./codes.mjs";
import { Repo } from "./fsx.mjs";
import { classifyContractFile } from "./contracts.mjs";

const TEMPLATES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");

function yamlStr(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function kebab(s) {
  return String(s)
    .replace(/^@/, "")
    .replace(/[_\s]+/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 63) || "component";
}

function sentence(s) {
  const t = String(s).replace(/\s+/g, " ").trim();
  if (!t) return "TODO: describe this in one present-tense sentence.";
  return /[.!?]$/.test(t) ? t : t + ".";
}

export function installTemplates(repo, cfg, { write, root, force = false } = {}) {
  const written = [];
  const skipped = [];
  const targetRoot = root || (repo ? repo.root : process.cwd());
  const r = repo || new Repo(targetRoot, { noGit: false });

  const put = (rel, content) => {
    const abs = path.join(targetRoot, rel);
    if (fs.existsSync(abs) && !force) { skipped.push(rel); return; }
    if (!write) { written.push(rel + " (dry run)"); return; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content.endsWith("\n") ? content : content + "\n");
    written.push(rel);
  };

  // ── configuration ───────────────────────────────────────────────────────
  const config = buildConfig(scanLayout(r));
  put("agentdoc/agentdoc.config.yaml", config);
  put("agentdoc/journeys.yaml", "schemaVersion: agentdoc.dev/journeys/v1\njourneys: []\n");
  for (const f of ["domains.yaml", "systems.yaml", "apis.yaml", "resources.yaml"]) {
    put("agentdoc/" + f, "");
  }
  put("agentdoc/observations/README.md", OBSERVATIONS_README);

  // ── documentation hierarchy ──────────────────────────────────────────────
  for (const f of ["PRODUCT.md", "ARCHITECTURE.md", "CONSTRAINTS.md"]) {
    const tpl = fs.readFileSync(path.join(TEMPLATES_DIR, f), "utf8");
    put("docs/" + f, tpl);
  }
  put("docs/adr/README.md", fs.readFileSync(path.join(TEMPLATES_DIR, "ADR.md"), "utf8"));
  put(".github/workflows/agentdoc.yml", fs.readFileSync(path.join(TEMPLATES_DIR, "ci.yml"), "utf8"));

  // ── per-unit component descriptors ──────────────────────────────────────
  if (cfg) {
    const units = discoverUnitNames(r, cfg);
    for (const u of units) {
      put(u.root + "/" + cfg.discovery.componentDescriptorName, componentDescriptor(u));
    }
  }
  return { written, skipped, note: write ? "files written" : "dry run: pass --write to apply" };
}

// Layout inference for CREATE mode: which directories look like unit roots.
// Uses only file-presence heuristics that any repository can answer.
function scanLayout(repo) {
  const candidates = new Map();
  const note = (root, kind) => {
    if (!candidates.has(root)) candidates.set(root, { root, kinds: new Set(), evidence: [] });
    candidates.get(root).kinds.add(kind);
    candidates.get(root).evidence.push(kind);
  };
  const skip = new Set(["node_modules", ".git", "dist", "build", "vendor", "target", "agentdoc", "docs", "scripts", ".github", "test", "tests", "examples", "example"]);
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(path.join(repo.root, dir), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isSymbolicLink() || skip.has(e.name)) continue;
      const rel = dir ? dir + "/" + e.name : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith(".")) continue;
        walk(rel, depth + 1);
        continue;
      }
      // Parent directory of the manifest. Parenthesised deliberately: without
      // the brackets, `-"/" + e.name` binds first and slice(0, NaN) silently
      // yields the empty string, which then crashes the layout analysis.
      const parent = () => rel.slice(0, -("/" + e.name).length);
      if (e.name === "package.json") note(parent(), "node");
      if (e.name === "go.mod") note(parent(), "go");
      if (e.name === "Dockerfile") note(parent(), "docker");
      if (/^wrangler\.(toml|json|jsonc)$/.test(e.name)) note(parent(), "platform");
      if (e.name === "go.mod") note(rel.slice(0, -"/go.mod".length), "go");
    }
  };
  walk("", 0);
  return [...candidates.values()].sort((a, b) => (a.root < b.root ? -1 : 1));
}

function discoverUnitNames(repo, cfg) {
  const out = [];
  const nameFor = (root) => {
    const pkg = root + "/package.json";
    if (repo.exists(pkg)) {
      try {
        const j = repo.readJson(pkg);
        if (typeof j.name === "string" && j.name) return kebab(j.name);
      } catch { /* fall through */ }
    }
    const gomod = root + "/go.mod";
    if (repo.exists(gomod)) {
      const m = /^module\s+(\S+)/m.exec(repo.readText(gomod));
      if (m) return kebab(m[1].split("/").pop());
    }
    return kebab(path.basename(root));
  };
  const seen = new Set();
  for (const u of scanLayout(repo)) {
    if (u.root === "." || !u.root) continue;
    const name = nameFor(u.root);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ root: u.root, name, kinds: [...u.kinds].sort() });
  }
  void cfg;
  return out;
}

function componentDescriptor(u) {
  const deployable = u.kinds.some((k) => k === "docker" || k === "platform");
  const type = deployable ? "service" : "library";
  return [
    "apiVersion: agentdoc.dev/v1",
    "kind: Component",
    "metadata:",
    "  name: " + u.name,
    "  description: " + yamlStr(sentence("TODO: " + u.name + " (" + u.kinds.join("/") + " at " + u.root + ") — state its single current responsibility")),
    "spec:",
    "  type: " + type,
    "  # Choose exactly one of the three lines below. Uncomment one.",
    "  # system: <system-name>",
    "  # domain: <domain-name>",
    "  # placementRationale: " + yamlStr(sentence("TODO: explain why this component belongs to no system or domain")),
    "",
  ].join("\n");
}

// Which adapter a discovered manifest marker implies. Project-agnostic: this
// maps a technology to its extractor, never a folder name to a component.
const ADAPTER_FOR_MARKER = {
  node: "node",
  go: "go",
  docker: "dockerfile",
  platform: "wrangler",
};

function buildConfig(layout) {
  const roots = layout.map((l) => l.root);
  const groups = new Map();
  for (const r of roots) {
    const head = r.split("/")[0];
    if (!groups.has(head)) groups.set(head, []);
    groups.get(head).push(r);
  }
  // A manifest at the repository root yields an empty head; emitting
  // "/agentdoc.yaml" would be an absolute glob, which the loader rejects.
  const componentGlobs = [...groups.entries()]
    .filter(([head]) => head.length > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([head, list]) => (list.length === 1 && list[0] === head ? head + "/agentdoc.yaml" : head + "/**/agentdoc.yaml"));
  if (!componentGlobs.length) componentGlobs.push("*/**/agentdoc.yaml");

  const adapters = new Set(["generic"]);
  for (const l of layout) {
    for (const k of l.kinds) {
      if (ADAPTER_FOR_MARKER[k]) adapters.add(ADAPTER_FOR_MARKER[k]);
    }
  }
  adapters.add("database");
  adapters.add("openapi");
  adapters.add("events");
  adapters.add("github-actions");

  // Candidate contract roots, filtered to those that actually exist. These are
  // only suggestions: the engine has no opinion about a folder name.
  const contractRoots = ["contracts", "api", "specs", "proto", "openapi", "schemas"].filter((r) => groups.has(r) || r === "");
  return [
    "# agentdoc configuration — the only project-specific file in the system.",
    "# Everything the engine does is derived from this plus the repository.",
    "apiVersion: agentdoc.dev/config/v1",
    "namespace: default",
    "",
    "discovery:",
    "  componentDescriptorName: agentdoc.yaml",
    "  componentDescriptors:",
    // Globs are quoted: an unquoted leading "*" is an alias in strict YAML,
    // and a configuration the compiler cannot parse is worse than none.
    ...componentGlobs.map((g) => "    - " + yamlStr(g)),
    "  centralDescriptors:",
    "    - agentdoc/domains.yaml",
    "    - agentdoc/systems.yaml",
    "    - agentdoc/apis.yaml",
    "    - agentdoc/resources.yaml",
    "  journeyDefinitions: agentdoc/journeys.yaml",
    ...(contractRoots.filter((r) => groups.has(r)).length
      ? ["  contractRoots:", ...contractRoots.filter((r) => groups.has(r)).map((r) => "    - " + r)]
      : ["  # contractRoots: []  # uncomment once you have a canonical contract directory"]),
    "  # eventPatternPrefixes:",
    "  #   - acme.",
    "",
    "adapters:",
    ...[...adapters].sort().map((a) => "  - " + a),
    "",
    "authority:",
    "  # No default global precedence exists. Every fact kind that can disagree",
    "  # across evidence classes needs an explicit rule, or it stays unresolved.",
    "  #",
    "  # The three rules below are COMMENTED OUT ON PURPOSE. An authority rule is a",
    "  # governance decision about which class of evidence wins, and a scaffolder is",
    "  # not entitled to make it for you. Uncomment the ones you can justify, and",
    "  # write the rationale in your own words:",
    "  #",
    "  # rules:",
    "  #   - id: deployed-schedule-is-runtime-truth",
    "  #     keyPattern: ' schedule\\\\.(cron|enabled|target)$'",
    "  #     elect: [OBSERVED_RUNTIME]",
    '  #     rationale: "Why this class is authoritative for this key."',
    '  #     reviewWhen: "What has to change for this rule to be re-examined."',
    "  rules: []",
    "",
    "reviewedOverrides: []",
    "warningAcceptances: []",
    "",
    "output:",
    "  graph: .agentdoc/graph.json",
    "  observations: agentdoc/observations",
    "  report: .agentdoc/report.json",
    "",
    "docs:",
    "  product: docs/PRODUCT.md",
    "  architecture: docs/ARCHITECTURE.md",
    "  constraints: docs/CONSTRAINTS.md",
    "  adrDir: docs/adr",
    "",
  ].join("\n");
}

const OBSERVATIONS_README = `# Runtime observations

An ObservationSet records what an authoritative external system actually said,
at a known time, with a durable reference to the raw evidence.

## Rules

1. Never put a secret, token or credentialed URL in an observation, an evidence
   bundle, or anywhere else in this directory. Run \`agentdoc validate\`; it
   fails on secret-shaped input.
2. Every fact needs a \`subject\` (an entity ref that exists) and a \`key\`
   (see "Fact keys" in the AgentDoc specification,
   docs/SPEC.md of https://github.com/lbframe/agent-doc-system). Two
   observation sets must not use the same key on the same subject.
3. \`evidenceBundle\` must be a committed, repository-relative file. A temp
   path, a console URL with a session token, or a screenshot filename is not
   evidence.
4. \`maxAgeDays\` is a promise. When the observation is older than that, every
   gate fails closed and says so. Re-observe, or restate the fact as authored
   intent if the divergence is intended.

## Shape

See the \`observation.yaml\` template shipped with the agentdoc CLI
(templates/observation.yaml in the installed package).
`;

export function templatePaths() {
  return { dir: TEMPLATES_DIR };
}
