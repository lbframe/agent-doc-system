// Determinism guard.
//
// The compiled graph must be a pure function of the checkout. A timestamp
// generated at compile time, an absolute host path, a username or a process id
// would all silently break byte-stability and freshness, so the serialized
// output is scanned for machine-specific shapes and compilation fails.
//
// Time that genuinely belongs to an observation is allowed, but only when it
// appears in the declared allowed set — the capturedAt values read out of
// committed ObservationSet files. That makes the check stronger rather than
// weaker: it proves no wall-clock value from the compiling machine leaked in,
// while a sourced observation timestamp still passes.
import { AgentDocError, CODES } from "./codes.mjs";
import { homedir, tmpdir } from "node:os";

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;

export function buildMachinePatterns(extra = []) {
  const pats = [
    // A value that STARTS with a well-known system root. Anchoring matters: an
    // unanchored pattern also matches a repository that happens to contain a
    // directory called `root/`, `opt/` or `home/`, which would make those
    // repositories impossible to compile.
    { re: /"(?:\/[A-Za-z]:\\|\\\\)[^"]*"/g, why: "absolute Windows path" },
    { re: /"(?:\/home\/|\/Users\/|\/root\/|\/var\/folders\/|\/private\/tmp\/|\/opt\/)[^"]*"/g, why: "absolute host path" },
    { re: /\bprocess\.pid\b/, why: "process identity" },
    { re: /\bnode_modules\/\.\.(?:\/)?/, why: "escaped path" },
  ];
  for (const d of [homedir(), tmpdir()].filter(Boolean)) {
    if (d && d !== "/") pats.push({ re: new RegExp(escapeRe(d) + "[^\\s\"']*", "g"), why: "host-specific path" });
  }
  for (const e of extra) pats.push(e);
  return pats;
}

export function scanMachineValues(text, extra = []) {
  const out = [];
  for (const p of buildMachinePatterns(extra)) {
    p.re.lastIndex = 0;
    const m = p.re.exec(text);
    if (m) out.push({ why: p.why, sample: String(m[0]).slice(0, 120) });
  }
  return out;
}

// Free-text fields are opaque values copied from committed files. They are a
// pure function of the checkout by construction, and they legitimately contain
// anything a repository author wrote — including a /tmp path in a CI script. The
// guard therefore inspects the graph's *structure*: refs, ids, paths, hashes,
// keys, provenance and the source block. A compiler-introduced machine value
// can only appear there.
export const FREE_TEXT_KEYS = new Set([
  "description", "semantics", "detail", "reason", "reviewWhen", "command", "role",
  "notes", "rationale", "value", "locator", "summary", "provenance", "title",
  "reviewer", "collectedAt",
]);

export function structuralProjection(node, key) {
  if (node === null || typeof node !== "object") return FREE_TEXT_KEYS.has(key) ? "x" : node;
  if (Array.isArray(node)) return node.map((v) => structuralProjection(v, key));
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = structuralProjection(v, k);
  return out;
}

export function assertDeterministic(text, { allowedTimestamps = [], extra = [], what = "graph", structural = null } = {}) {
  const haystack = structural === null ? text : JSON.stringify(structural, null, 2);
  const found = scanMachineValues(haystack, extra);
  // Every timestamp in the output must be one the compiler read from a
  // committed source file. Anything else came from the compiling machine.
  const allowed = new Set(allowedTimestamps);
  const bad = new Set();
  let m;
  TIMESTAMP_RE.lastIndex = 0;
  while ((m = TIMESTAMP_RE.exec(haystack)) !== null) {
    if (!allowed.has(m[0])) bad.add(m[0]);
  }
  if (bad.size) {
    found.push({
      why: "timestamp not present in any committed source (" + [...bad].slice(0, 3).join(", ") + ")",
      sample: [...bad][0],
    });
  }
  if (found.length) {
    throw new AgentDocError(
      CODES.NONDETERMINISTIC,
      "compiled " + what + " contains machine-specific values, which would break byte-stability: " +
        found.map((f) => f.why + " (" + f.sample + ")").join("; ")
    );
  }
}
