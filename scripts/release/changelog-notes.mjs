#!/usr/bin/env node
// Extract the release notes for one version from a Keep a Changelog 1.1.0
// file, for the GitHub release body.
//
// The section is the text under `## [X.Y.Z] - YYYY-MM-DD`, up to the next
// level-2 heading or the end of the file. The changelog uses reference-style
// links (`[#46]`) defined once at the bottom of the file, so the definitions
// the section uses are appended to it; otherwise they would render as literal
// brackets on GitHub. Relative link targets (`docs/BENCHMARK.md`) are rewritten
// to absolute URLs when a base URL is given, because a release body has no
// file tree to resolve them against.
//
// Usage: node scripts/release/changelog-notes.mjs <version>
//          [--changelog CHANGELOG.md] [--base-url <url>]
// Prints the notes on stdout. Exits 1 with a message on stderr when the
// section is missing or empty.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class NotesError extends Error {}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// CommonMark link reference definition, on one line: `[label]: destination`.
const DEFINITION = /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*(<[^>]*>|\S+)(.*)$/;

// Labels match case-insensitively with internal whitespace collapsed.
const normalizeLabel = (label) => label.trim().replace(/\s+/g, " ").toLowerCase();

const isRelativeTarget = (target) =>
  !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#") && !target.startsWith("/") && !target.startsWith("<");

function absolutize(target, baseUrl) {
  if (!baseUrl || !isRelativeTarget(target)) return target;
  return baseUrl.replace(/\/+$/, "") + "/" + target.replace(/^\.\//, "");
}

/**
 * Return the release notes for `version`: the section body (heading excluded),
 * followed by the link reference definitions it uses.
 *
 * @param {string} changelog  full CHANGELOG.md text
 * @param {string} version    e.g. "1.3.0" (no leading "v")
 * @param {{ baseUrl?: string }} [options]  prefix for relative link targets
 * @returns {string}
 */
export function extractReleaseNotes(changelog, version, { baseUrl } = {}) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version)) {
    throw new NotesError(`not a release version: ${JSON.stringify(version)}`);
  }
  const lines = changelog.replace(/\r\n?/g, "\n").split("\n");
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`);

  const starts = [];
  lines.forEach((line, i) => { if (heading.test(line)) starts.push(i); });
  if (starts.length === 0) {
    const undated = new RegExp(`^## \\[${escapeRegExp(version)}\\]`);
    const hint = lines.some((l) => undated.test(l)) ? " (a heading exists but is not `## [X.Y.Z] - YYYY-MM-DD`)" : "";
    throw new NotesError(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section${hint}`);
  }
  if (starts.length > 1) throw new NotesError(`CHANGELOG.md has ${starts.length} sections for ${version}`);

  // Collect every definition in the file; the first one for a label wins.
  const definitions = new Map();
  for (const line of lines) {
    const m = DEFINITION.exec(line);
    if (m && !definitions.has(normalizeLabel(m[1]))) definitions.set(normalizeLabel(m[1]), m);
  }

  let end = lines.length;
  for (let i = starts[0] + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  // Definitions inside the section (the file's trailing block, when this is
  // the last section) are dropped here and re-added below if used.
  const body = lines.slice(starts[0] + 1, end).filter((l) => !DEFINITION.test(l));
  while (body.length && body[0].trim() === "") body.shift();
  while (body.length && body.at(-1).trim() === "") body.pop();

  if (!body.some((l) => l.trim() !== "" && !/^#{1,6}\s/.test(l))) {
    throw new NotesError(`CHANGELOG.md section for ${version} is empty`);
  }

  // Inline links: rewrite relative destinations.
  const text = body.join("\n").replace(/\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
    (all, target, title) => `](${absolutize(target, baseUrl)}${title})`);

  // Every bracketed span is a candidate label: shortcut `[x]`, collapsed
  // `[x][]` and full `[text][x]` references all contain `[x]`. A span that is
  // only link text and happens to match a label adds a harmless definition.
  const used = [];
  const seen = new Set();
  for (const m of text.matchAll(/\[((?:[^\[\]\\]|\\.)+)\]/g)) {
    const key = normalizeLabel(m[1]);
    if (definitions.has(key) && !seen.has(key)) { seen.add(key); used.push(definitions.get(key)); }
  }
  if (used.length === 0) return text + "\n";
  const defs = used.map((m) => `[${m[1]}]: ${absolutize(m[2], baseUrl)}${m[3]}`);
  return text + "\n\n" + defs.join("\n") + "\n";
}

function main(argv) {
  const args = [...argv];
  let changelogPath = "CHANGELOG.md";
  let baseUrl;
  let version;
  while (args.length) {
    const a = args.shift();
    if (a === "--changelog") changelogPath = args.shift();
    else if (a === "--base-url") baseUrl = args.shift();
    else if (version === undefined) version = a;
    else throw new NotesError(`unexpected argument: ${a}`);
  }
  if (!version) throw new NotesError("usage: changelog-notes.mjs <version> [--changelog FILE] [--base-url URL]");
  process.stdout.write(extractReleaseNotes(fs.readFileSync(changelogPath, "utf8"), version, { baseUrl }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write((e instanceof NotesError ? "" : "unexpected: ") + e.message + "\n");
    process.exit(1);
  }
}
