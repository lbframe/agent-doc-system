// Normative requirement coverage.
//
// A normative document (a specification, a technical profile) states what the
// implementation must do. Routing it to a component is not reviewing it: the
// incident behind this module was a migration that linked every specification,
// passed every gate, and still never noticed that a "must be reproduced on the
// production host" had no implementation at all.
//
// This module does not read prose for meaning. It does two deterministic
// things:
//
//   - it cuts every configured normative document into sections and pins each
//     one by content hash, so "which parts of the specification were reviewed"
//     becomes a question with an exact answer;
//   - it requires every section to be accounted for, either by a structured
//     requirement (a fact the authority engine can compare against evidence)
//     or by an explicit, reviewed attestation that it carries no
//     implementation obligation.
//
// Deciding *what* a section obliges is a human act. Making sure that act
// happened, and is re-done when the section changes, is the machine's.
import { AgentDocError, CODES } from "./codes.mjs";
import { expandGlob, sha256Hex } from "./fsx.mjs";
import { CONFIG_PATH } from "./descriptors.mjs";

export const REQUIREMENT_KEY_PREFIX = "requirement.";
export const NORMATIVE_SEMANTICS_PREFIX = "normative: ";

// Sections are the level-2 headings of a Markdown document. Level 1 is the
// document title; deeper levels belong to the section that contains them, so a
// reviewer attests a unit that is large enough to carry one obligation and
// small enough to be re-reviewed when it changes. Headings inside fenced code
// blocks are not headings.
export function splitSections(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections = [];
  const slugs = new Map();
  let cur = null;
  let fence = null;
  for (const line of lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    }
    const h = !fence && /^##(?!#)\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      if (cur) sections.push(cur);
      const base = slugify(h[1]);
      // Duplicate headings get the same suffixes a Markdown renderer gives
      // their anchors, so a citation can be the link a reader would follow.
      const n = slugs.get(base) || 0;
      slugs.set(base, n + 1);
      cur = { section: n ? base + "-" + n : base, heading: h[1], lines: [line] };
      continue;
    }
    if (/^#(?!#)\s/.test(line) && !fence) {
      if (cur) sections.push(cur);
      cur = null;
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) sections.push(cur);
  return sections.map((s) => {
    // Trailing blank lines are layout, not content: appending a section must
    // not invalidate the review of the one before it.
    while (s.lines.length > 1 && s.lines[s.lines.length - 1].trim() === "") s.lines.pop();
    const body = s.lines.join("\n") + "\n";
    return { section: s.section, heading: s.heading, sha256: sha256Hex(Buffer.from(body, "utf8")) };
  });
}

export function slugify(heading) {
  return String(heading)
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

// Every configured normative document, cut into sections. Reading through the
// repository handle keeps these files in the compile's input hash, so a change
// to a specification makes the committed graph stale like any other input.
export function loadNormativeDocuments(repo, cfg) {
  const globs = (cfg.docs && cfg.docs.normative) || [];
  const paths = new Set();
  for (const g of globs) for (const p of expandGlob(repo, g)) paths.add(p);
  const docs = [];
  for (const p of [...paths].sort()) {
    if (!/\.(md|mdx)$/.test(p)) continue;
    docs.push({ path: p, sections: splitSections(repo.readText(p)) });
  }
  return docs;
}

// A citation of one section: a requirement's `source`, or a coverage
// attestation. Both must name a section that exists *now*, with the digest it
// had when someone reviewed it.
export function verifyCitation(docs, cite, where, ref) {
  const doc = docs.find((d) => d.path === cite.path);
  if (!doc) {
    throw new AgentDocError(
      CODES.CONFIG,
      "cites " + cite.path + ", which is not a configured normative document (docs.normative)",
      { path: where, ref }
    );
  }
  const s = doc.sections.find((x) => x.section === cite.section);
  if (!s) {
    throw new AgentDocError(
      CODES.NORMATIVE_SOURCE_STALE,
      "cited section " + cite.path + "#" + cite.section + " no longer exists — re-review what replaced it",
      { path: where, ref }
    );
  }
  if (s.sha256 !== cite.sha256) {
    throw new AgentDocError(
      CODES.NORMATIVE_SOURCE_STALE,
      "cited section " + cite.path + "#" + cite.section + " changed since it was reviewed — " +
        "re-review it before updating the digest to " + s.sha256,
      { path: where, ref }
    );
  }
  return s;
}

// Coverage: which sections are cited by a requirement, which are attested, and
// which nobody has looked at. Returned rather than pushed so the audit can show
// the same table the gate enforces.
export function normativeCoverage(docs, requirements, attestations, errors) {
  const coveredBy = new Map();
  const mark = (path, section, by) => {
    const k = path + "#" + section;
    if (!coveredBy.has(k)) coveredBy.set(k, []);
    coveredBy.get(k).push(by);
  };
  for (const r of requirements) {
    mark(r.source.path, r.source.section, "requirement:" + r.subject + " " + r.key);
  }
  const seen = new Set();
  for (const a of attestations) {
    const k = a.path + "#" + a.section;
    try {
      if (seen.has(k)) throw new AgentDocError(CODES.CONFIG, "duplicate normativeCoverage entry for " + k, { path: CONFIG_PATH });
      seen.add(k);
      verifyCitation(docs, a, CONFIG_PATH, null);
      mark(a.path, a.section, "attestation:" + a.disposition);
    } catch (e) {
      if (!(e instanceof AgentDocError)) throw e;
      errors.push(e);
    }
  }
  const sections = [];
  for (const d of docs) {
    for (const s of d.sections) {
      const by = (coveredBy.get(d.path + "#" + s.section) || []).sort();
      sections.push({ path: d.path, section: s.section, heading: s.heading, sha256: s.sha256, coveredBy: by });
    }
  }
  return { sections, uncovered: sections.filter((s) => !s.coveredBy.length) };
}

export function isRequirementKey(key) {
  return typeof key === "string" && key.startsWith(REQUIREMENT_KEY_PREFIX);
}

export function isNormative(assertion) {
  return typeof assertion.semantics === "string" && assertion.semantics.startsWith(NORMATIVE_SEMANTICS_PREFIX);
}
