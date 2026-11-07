// Repository-relative path semantics, in one place.
//
// Every path the catalog stores or matches is in one canonical form, the one
// git uses for pathspecs and `ls-files` output: relative to the repository
// root, '/'-separated, with no "./", no empty or "." segments and no trailing
// slash. The repository root itself is the single value REPO_ROOT (".", which
// is what a root unit's `sourcePath` has always recorded).
//
// Ownership is decided on whole path segments, never on raw string prefixes:
// `src` owns `src` and `src/x.ts`, never `src2/x.ts`. The root owns every
// repository path, which makes it the lowest-precedence owner: when several
// owners match, the longest one wins, as in a routing table or CODEOWNERS.

export const REPO_ROOT = ".";

// Canonical form of a repository-relative path, or null for a path that is
// not one: absolute, drive-qualified, backslash-separated or escaping the
// repository through "..". Those are rejected here rather than resolved, the
// same rule `isRepoPath` applies to authored paths.
export function canonicalPath(p) {
  if (typeof p !== "string") return null;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\\")) return null;
  const segs = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    segs.push(seg);
  }
  return segs.length ? segs.join("/") : REPO_ROOT;
}

export function isRepoRoot(p) {
  return canonicalPath(p) === REPO_ROOT;
}

// True when `owner` (a directory such as a unit root or a component's
// sourcePath) contains `file`, segment by segment.
export function ownsPath(owner, file) {
  const o = canonicalPath(owner);
  const f = canonicalPath(file);
  if (o === null || f === null) return false;
  if (o === REPO_ROOT) return true;
  return f === o || f.startsWith(o + "/");
}

// The most specific owner of `file` among `owners`, or null. Specificity is
// segment depth, so the root (depth 0) only wins when nothing else matches —
// a one-character sibling such as `a` must not tie with ".".
export function longestOwner(owners, file) {
  let best = null;
  let bestDepth = -1;
  for (const o of owners) {
    if (!ownsPath(o, file)) continue;
    const c = canonicalPath(o);
    const depth = c === REPO_ROOT ? 0 : c.split("/").length;
    if (depth > bestDepth) {
      best = o;
      bestDepth = depth;
    }
  }
  return best;
}

// Join a unit root and a path below it without ever producing "./x": a root
// unit's manifest is `package.json`, exactly as git and every other path in
// the graph spell it.
export function joinPath(root, rel) {
  const r = canonicalPath(root);
  const base = r === null ? String(root).replace(/\/+$/, "") : r;
  return base === REPO_ROOT || base === "" ? rel : base + "/" + rel;
}
