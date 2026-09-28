// Source scanning primitives shared by adapters.
//
// The extraction of quoted module specifiers is language-neutral: a bare
// identifier in quotes that is not a relative path is a candidate dependency
// reference in practically every language. Deciding whether that reference
// resolves to a sibling unit is the adapter's job, because only the adapter
// knows the namespace convention.
import path from "node:path";
import fs from "node:fs";

const SPECIFIER_RE = /["'`]([A-Za-z@][A-Za-z0-9@._/+-]*(?:\.[A-Za-z0-9@._/+-]+)*(?:\/[A-Za-z0-9@._+*-]+)*)["'`]/g;

export function importSpecifiers(text) {
  const out = new Set();
  for (const m of text.matchAll(SPECIFIER_RE)) {
    const s = m[1];
    if (s.startsWith(".") || s.startsWith("/")) continue;
    if (s.length < 2) continue;
    out.add(s);
  }
  return out;
}

export function sourceFiles(repo, root, { test = false, extensions } = {}) {
  const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\//;
  const TEST_FILE = /\.(test|spec)\./;
  const DEFAULT_EXT = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|go|py|rb|java|kt|rs|ex|exs|cs|php|swift|scala|sh)$/;
  const re = extensions || DEFAULT_EXT;
  const out = [];
  for (const f of repo.walk(root)) {
    if (!re.test(f)) continue;
    const isTest = TEST_PATH.test(f) || TEST_FILE.test(f) || /_test\.[a-z]+$/.test(f);
    if (isTest !== test) continue;
    out.push(f);
  }
  return out;
}

// Directory candidates that hold schema migrations or an ORM schema. Used to
// find "this component owns a database" evidence without assuming a framework.
export const MIGRATION_DIR_CANDIDATES = [
  "migrations", "db/migrations", "database/migrations", "internal/db/migrations",
  "internal/migrations", "src/db/migrations", "alembic/versions", "liquibase",
];

// Any directory named "migrations" inside a unit, at bounded depth. Framework
// and language conventions move; the name of a migration directory has been
// stable for far longer than its location.
export function findMigrationDirs(repo, root, maxDepth = 5) {
  const out = [];
  // Absolute paths throughout: `root` is repository-relative, and resolving it
  // against the process working directory would make the result depend on
  // where the compiler was invoked from.
  const base = repo.abs(root);
  const walk = (dirAbs, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (["node_modules", ".git", "vendor", "target", "dist", "build", ".next", "__pycache__"].includes(e.name)) continue;
      const abs = path.join(dirAbs, e.name);
      if (e.name === "migrations" || e.name === "migration") {
        out.push(path.relative(repo.root, abs).split(path.sep).join("/"));
        continue;
      }
      walk(abs, depth + 1);
    }
  };
  walk(base, 0);
  return out.sort();
}

export function firstExistingFile(repo, root, names) {
  for (const n of names) {
    if (repo.exists(root + "/" + n)) return root + "/" + n;
  }
  return null;
}

export function relativeTo(root, p) {
  const r = path.posix.relative(root, p);
  return r === "" ? "." : r;
}
