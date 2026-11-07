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
import { Repo, assertRepoPath } from "./fsx.mjs";
import { CONFIG_PATH } from "./descriptors.mjs";
import { discoverUnits, isNotUnitRoot } from "./discover.mjs";
import { classifyContractFile } from "./contracts.mjs";
import { parse as parseToml } from "./toml.mjs";
import { cargoUnitShape, isExcludedWorkspaceMember, isVirtualWorkspaceManifest } from "../adapters/rust.mjs";
import { readPythonUnit } from "../adapters/python.mjs";
import { loadAdapters } from "../adapters/index.mjs";

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

// Where the documentation skeleton goes when no configuration exists yet. Once
// a configuration exists, it is the only authority: `docs.*` is what audit and
// compile read, so the scaffolder writes there and nowhere else (issue #49 —
// `docs/` is often the product's own user documentation).
//
// The default lives under `agentdoc/` (issue #59): authored AgentDoc material
// lives in `agentdoc/`, generated output in `.agentdoc/`. Not `docs/`, which is
// the product's user documentation (and a MkDocs/Docusaurus/Pages source), and
// not `.agentdoc/`, which the compiler skips and many repositories git-ignore.
export const DEFAULT_DOCS = Object.freeze({
  product: "agentdoc/docs/PRODUCT.md",
  architecture: "agentdoc/docs/ARCHITECTURE.md",
  constraints: "agentdoc/docs/CONSTRAINTS.md",
  adrDir: "agentdoc/docs/adr",
});

// The skeleton roles that have a template. `runbookDir` and `normative` are
// honoured by never writing anything for them: there is no runbook template,
// and normative documents are the project's own.
const SKELETON_ROLES = [
  { key: "product", template: "PRODUCT.md", file: (p) => p },
  { key: "architecture", template: "ARCHITECTURE.md", file: (p) => p },
  { key: "constraints", template: "CONSTRAINTS.md", file: (p) => p },
  { key: "adrDir", template: "ADR.md", file: (p) => p.replace(/\/+$/, "") + "/README.md" },
];

// Resolve the documentation skeleton for a loaded configuration (`null` when
// there is none). A configured role is written to its configured path; a role
// a configuration leaves out is not written anywhere and is reported, so an
// omitted role can never fall back into `docs/`.
export function docsSkeleton(cfg) {
  const docs = cfg ? cfg.docs || {} : DEFAULT_DOCS;
  const targets = [];
  const notConfigured = [];
  for (const role of SKELETON_ROLES) {
    const configured = docs[role.key];
    if (!configured) { notConfigured.push("docs." + role.key); continue; }
    // loadConfig already validated these; re-asserting keeps this function
    // safe for any caller that hands it an unvalidated object.
    assertRepoPath(configured, CONFIG_PATH);
    const rel = role.file(configured);
    assertRepoPath(rel, CONFIG_PATH);
    targets.push({ key: role.key, path: rel, template: role.template });
  }
  return { targets, notConfigured, docs: cfg ? docs : DEFAULT_DOCS };
}

// Refuse a write target that leaves the repository, including through a
// symlinked directory or a (possibly dangling) symlink at the target itself.
// Lexical checks alone (`isRepoPath`) cannot see a symlink.
function assertWritableInside(root, rel) {
  const abs = path.resolve(root, rel);
  const inside = path.relative(path.resolve(root), abs);
  if (!inside || inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside)) {
    throw new AgentDocError(CODES.PATH_ESCAPE, "path escapes repository: " + rel, { path: rel });
  }
  const realRoot = fs.realpathSync(root);
  let cur = path.resolve(root);
  for (const seg of inside.split(path.sep)) {
    cur = path.join(cur, seg);
    let st;
    try { st = fs.lstatSync(cur); } catch { return; } // nothing further exists yet
    if (!st.isSymbolicLink()) continue;
    let real = null;
    try { real = fs.realpathSync(cur); } catch { /* dangling */ }
    if (real === null || (real !== realRoot && !real.startsWith(realRoot + path.sep))) {
      throw new AgentDocError(CODES.PATH_ESCAPE, "refusing to write through a symlink that leaves the repository: " + rel, { path: rel });
    }
  }
}

// `cfg` is the loaded configuration (scaffold) or null (init). `docsConfig`
// overrides the configuration the documentation paths are read from: init
// writes no component descriptors, but it must still honour an existing
// configuration's `docs.*` paths.
export function installTemplates(repo, cfg, { write, root, force = false, eligible = null, docsConfig } = {}) {
  const written = [];
  const skipped = [];
  const targetRoot = root || (repo ? repo.root : process.cwd());
  const r = repo || new Repo(targetRoot, { noGit: false });
  const docsSource = docsConfig === undefined ? cfg : docsConfig;
  const skeleton = docsSkeleton(docsSource);

  // Plan every file first and check every target before writing anything, so
  // a refused path leaves the repository exactly as it was.
  const plan = [];
  const put = (rel, content) => { plan.push([rel, content]); };

  // ── configuration ───────────────────────────────────────────────────────
  const config = buildConfig(scanLayout(r, cfg), skeleton.docs);
  put("agentdoc/agentdoc.config.yaml", config);
  put("agentdoc/journeys.yaml", "schemaVersion: agentdoc.dev/journeys/v1\njourneys: []\n");
  for (const f of ["domains.yaml", "systems.yaml", "apis.yaml", "resources.yaml"]) {
    put("agentdoc/" + f, "");
  }
  put("agentdoc/observations/README.md", OBSERVATIONS_README);

  // ── documentation hierarchy (configured docs.* paths) ───────────────────
  for (const t of skeleton.targets) {
    put(t.path, fs.readFileSync(path.join(TEMPLATES_DIR, t.template), "utf8"));
  }
  put(".github/workflows/agentdoc.yml", fs.readFileSync(path.join(TEMPLATES_DIR, "ci.yml"), "utf8"));

  // ── per-unit component descriptors ──────────────────────────────────────
  if (cfg) {
    // When the caller ran the compiler's discovery first, write for the units
    // the compiler itself counts as eligible — adapter-discovered roots
    // (go.work members, pnpm workspace packages, supplementalRoots) may have
    // no marker file the layout scan would find on its own.
    const units = discoverUnitNames(r, cfg, eligible);
    for (const u of units) {
      put(u.root + "/" + cfg.discovery.componentDescriptorName, componentDescriptor(u));
    }
  }

  const seen = new Set();
  for (const [rel] of plan) assertWritableInside(targetRoot, rel);
  for (const [rel, content] of plan) {
    if (seen.has(rel)) continue; // two roles configured onto one file: first wins
    seen.add(rel);
    const abs = path.join(targetRoot, rel);
    if (fs.existsSync(abs) && !force) { skipped.push(rel); continue; }
    if (!write) { written.push(rel + " (dry run)"); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content.endsWith("\n") ? content : content + "\n");
    written.push(rel);
  }
  return {
    written,
    skipped,
    ...(docsSource && skeleton.notConfigured.length
      ? {
          notConfigured: skeleton.notConfigured,
          notConfiguredNote: "the configuration declares no path for these roles, so no skeleton was written for them; add them under docs: to scaffold them",
        }
      : {}),
    note: write ? "files written" : "dry run: pass --write to apply",
  };
}

// Layout inference for CREATE mode: which directories look like unit roots.
// Combines shallow marker heuristics with the compiler's adapter discovery.
function scanLayout(repo, cfg) {
  const candidates = new Map();
  const note = (root, kind) => {
    if (!candidates.has(root)) candidates.set(root, { root, kinds: new Set(), evidence: [] });
    candidates.get(root).kinds.add(kind);
    candidates.get(root).evidence.push(kind);
  };
  const skip = new Set(["node_modules", ".git", "dist", "build", "vendor", "target", "test", "tests", "examples", "example"]);
  const walk = (dir, depth) => {
    if (depth > 3 || isNotUnitRoot(dir, cfg)) return;
    let entries;
    try { entries = fs.readdirSync(path.join(repo.root, dir), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isSymbolicLink() || skip.has(e.name)) continue;
      const rel = dir ? dir + "/" + e.name : e.name;
      if (repo.isIgnored && repo.isIgnored(rel)) continue;
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
      if (e.name === "Cargo.toml" && cargoUnitShape(repo, parent()) && !isExcludedWorkspaceMember(repo, parent())) note(parent(), "rust");
      if (e.name === "pyproject.toml" || e.name === "setup.py" || e.name === "setup.cfg") note(parent(), "python");
      if (/^requirements.*\.txt$/.test(e.name)) note(parent(), "python");
      if (e.name === "Dockerfile") note(parent(), "docker");
      if (/^wrangler\.(toml|json|jsonc)$/.test(e.name)) note(parent(), "platform");
      if (e.name === "go.mod") note(rel.slice(0, -"/go.mod".length), "go");
    }
  };
  walk("", 0);
  // Directory-name/depth heuristics must not hide units declared by adapters
  // (for example a uv or Cargo member under examples/). During init there is
  // no config yet: probe supported marker adapters so those members can also
  // select their adapter in the generated configuration.
  const discoveryCfg = cfg || { discovery: { componentDescriptors: [] } };
  const adapters = loadAdapters(cfg ? cfg.adapters : Object.values(ADAPTER_FOR_MARKER));
  for (const unit of discoverUnits(repo, discoveryCfg, adapters).eligible) {
    if (!unit.root || unit.root === "." || isNotUnitRoot(unit.root, cfg)) continue;
    for (const [kind, adapter] of Object.entries(ADAPTER_FOR_MARKER)) {
      if (unit.markers.some((marker) => marker.adapter === adapter)) note(unit.root, kind);
    }
  }
  for (const u of [...candidates.values()]) {
    // Layout-only candidates need the same artifact evidence as units already
    // discovered by the compiler. A technology name alone proves no shape.
    u.deployable = false;
    u.importable = false;
    for (const adapter of loadAdapters([...u.kinds].map((k) => ADAPTER_FOR_MARKER[k]))) {
      const marker = adapter.detect({ repo, cfg }, u.root || ".");
      if (!marker) continue;
      const shape = marker.shape || "both";
      u.deployable ||= shape === "deployable" || shape === "both";
      u.importable ||= shape === "importable" || shape === "both";
    }
    if (!u.kinds.has("python")) continue;
    const info = readPythonUnit(repo, u.root);
    // A uv workspace root with no distribution is not a unit. Scaffolding it
    // would invent a component for the virtual manifest.
    if (!info.dist && !info.deployable && !info.importable && !info.error && virtualUvWorkspace(repo, u.root)) {
      candidates.delete(u.root);
    }
  }
  return [...candidates.values()].sort((a, b) => (a.root < b.root ? -1 : 1));
}

function virtualUvWorkspace(repo, root) {
  const file = !root || root === "." ? "pyproject.toml" : root + "/pyproject.toml";
  if (!repo.exists(file)) return false;
  try {
    const doc = parseToml(repo.readText(file), file);
    const ws = doc.tool && doc.tool.uv && doc.tool.uv.workspace;
    return Boolean(ws && typeof ws === "object" && !Array.isArray(ws));
  } catch {
    return false;
  }
}

function discoverUnitNames(repo, cfg, eligible = null) {
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
    const cargo = root + "/Cargo.toml";
    if (repo.exists(cargo)) {
      try {
        const doc = parseToml(repo.readText(cargo));
        const n = doc && doc.package && typeof doc.package.name === "string" ? doc.package.name : "";
        // `_` becomes `-u-` before kebab, so `foo_bar` does not collapse into
        // the same component name as `foo-bar`.
        if (n) return kebab(n.replace(/_/g, "-u-"));
      } catch { /* a manifest that does not parse is not a name */ }
    }
    const python = readPythonUnit(repo, root);
    if (python.dist) return kebab(python.dist);
    return kebab(path.basename(root));
  };
  const seen = new Set();
  const seenRoots = new Set();
  // Union, not replacement: compiler-eligible units (adapter roots,
  // supplementalRoots) cover what markers cannot see, while the layout scan
  // still covers marker-bearing dirs that no adapter claims.
  const units = [
    ...(eligible || []).map((u) => ({
      root: u.root,
      kinds: (u.markers || []).map((m) => m.adapter).sort(),
      deployable: Boolean(u.deployable),
      importable: Boolean(u.importable),
    })),
    ...scanLayout(repo, cfg).map((u) => ({
      root: u.root,
      kinds: [...u.kinds].sort(),
      deployable: Boolean(u.deployable),
      importable: Boolean(u.importable),
    })),
  ];
  for (const found of units) {
    if (found.root === "." || !found.root || seenRoots.has(found.root)) continue;
    if (isNotUnitRoot(found.root, cfg)) continue;
    if (isVirtualWorkspaceManifest(repo, found.root)) continue;
    const u = found;
    seenRoots.add(u.root);
    const name = nameFor(u.root);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ ...u, name });
  }
  return out;
}

function componentDescriptor(u) {
  // "library" and "service" both have to be corroborated by artifact evidence
  // (AGENTDOC_ARTIFACT_TYPE); a unit the compiler only knows from configuration
  // shows neither, so claiming a concrete type would manufacture an error.
  const type = u.deployable ? "service" : u.importable ? "library" : "other";
  return [
    "apiVersion: agentdoc.dev/v1",
    "kind: Component",
    "metadata:",
    "  name: " + u.name,
    "  description: " + yamlStr(sentence("TODO: " + u.name + " (" + (u.kinds.length ? u.kinds.join("/") : "configured") + " at " + u.root + ") — state its single current responsibility")),
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
  rust: "rust",
  python: "python",
  docker: "dockerfile",
  platform: "wrangler",
};

function buildConfig(layout, docs = DEFAULT_DOCS) {
  const roots = layout.map((l) => l.root);
  const groups = new Map();
  for (const r of roots) {
    const head = r.split("/")[0];
    if (!groups.has(head)) groups.set(head, []);
    groups.get(head).push(r);
  }

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
    "# namespace prefixes every entity ref (component:<namespace>/<name>).",
    "# 'default' is a placeholder — pick the name this repository calls itself.",
    "namespace: default",
    "",
    "discovery:",
    "  componentDescriptorName: agentdoc.yaml",
    "  componentDescriptors:",
    // Discover every scaffolded descriptor, including adapter roots outside
    // the shallow layout and units added after init. Keep the leading glob
    // quoted because an unquoted "*" is an alias in strict YAML.
    '    - "*/**/agentdoc.yaml"',
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
    "",
    ...docsSection(docs),
    "",
  ].join("\n");
}

// The `docs:` block of a generated configuration. It repeats the configured
// paths (init --force regenerates the file and must not move documentation
// elsewhere), or the agentdoc/docs/ defaults when there is no configuration yet.
function docsSection(docs) {
  const scalar = (v) => (/^[A-Za-z0-9._/-]+$/.test(v) ? v : yamlStr(v));
  const lines = [];
  for (const key of ["product", "architecture", "constraints", "adrDir", "runbookDir"]) {
    if (docs[key]) lines.push("  " + key + ": " + scalar(docs[key]));
  }
  if (Array.isArray(docs.normative) && docs.normative.length) {
    lines.push("  normative:", ...docs.normative.map((g) => "    - " + yamlStr(g)));
  }
  return lines.length ? ["docs:", ...lines] : ["# docs: {}  # no documentation roles configured"];
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
