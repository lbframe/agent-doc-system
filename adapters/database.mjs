// Database adapter: migration and schema evidence.
//
// Two distinct outcomes, deliberately kept apart:
//   - an authored logical-database Resource that matches → a resolved binding
//     and a uses-resource relation;
//   - no match → a *candidate* fact plus a warning. Migration authority alone
//     does not establish database ownership, so the system refuses to invent
//     the edge. This mirrors a real review in the reference project where a
//     library shipped migrations but explicitly did not own a database.
import { Adapter } from "./registry.mjs";
import { firstExistingFile, findMigrationDirs } from "../core/sourcescan.mjs";
import { canonicalPath, joinPath } from "../core/paths.mjs";

const ORM_CONFIG = [
  "drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs",
  "prisma/schema.prisma", "schema.prisma",
  "knexfile.js", "knexfile.ts", "sequelize.config.js", "ormconfig.json",
];
// Probed only for a Cargo package. Adding it to the list above would record
// a new existence probe on every non-Rust unit and change those graphs.
const RUST_ORM_CONFIG = ["diesel.toml"];

export class DatabaseAdapter extends Adapter {
  static adapterName = "database";
  constructor() {
    super({ name: "database", version: "1.0.0", kind: "source" });
  }
  extract(ctx, unit) {
    const { repo, prov, compRef } = ctx;
    const root = unit.root;
    const migrationDirs = findMigrationDirs(repo, root);
    const ormConfig = firstExistingFile(repo, root, unit.cargoPackage ? ORM_CONFIG.concat(RUST_ORM_CONFIG) : ORM_CONFIG);
    if (!migrationDirs.length && !ormConfig) return {};

    let evidencePath = ormConfig;
    if (migrationDirs.length) {
      evidencePath = repo.walkUnit(root, migrationDirs[0])[0] || migrationDirs[0];
    }
    const alembicDir = migrationDirs.find((d) => d === "alembic/versions" || d.endsWith("/alembic/versions"));
    if (alembicDir) {
      const ini = joinPath(root, "alembic.ini");
      const pyproject = joinPath(root, "pyproject.toml");
      if (repo.exists(ini)) {
        const text = repo.readText(ini);
        if (/^\s*\[alembic\]/m.test(text) || /^\s*script_location\s*=/m.test(text)) evidencePath = ini;
      } else if (repo.exists(pyproject) && /\[tool\.alembic\]/.test(repo.readText(pyproject))) {
        evidencePath = pyproject;
      }
    }
    const pr = prov.add("observed", evidencePath, "migration-extractor", ["der:" + compRef + ":/bindings"]);
    // Where this unit's migrations live, recorded in the graph so `impact`
    // classifies a change from the graph rather than from a list of names.
    // Authority over a directory, never ownership of a database: these records
    // create no binding.
    const recorded = recordMigrationDirs(ctx, unit, migrationDirs, ormConfig, pr);
    const withDirs = (out) => (recorded.length ? { ...out, migrationDirs: recorded } : out);

    // A component that both migrates and opens a connection owns the database.
    const opensConnection = hasConnectionEvidence(ctx, unit);
    if (!opensConnection) {
      ctx.diagnostics.push({
        severity: "warning",
        code: "AGENTDOC_RESOURCE_CANDIDATE",
        subject: compRef,
        refs: [compRef],
        message:
          "migration or schema authority under '" + root + "' has no matching authored logical-database Resource, " +
          "and no connection-pool evidence: migration authority alone does not establish database ownership",
        paths: [evidencePath],
      });
      ctx.addFact(compRef, "resource.ownership", null, {
        evidenceClass: "DERIVED", confidence: "candidate", provRecs: [pr],
        semantics: "a schema exists here, but which component owns the logical database is unresolved",
      });
      return withDirs({ migrationAuthority: evidencePath });
    }

    const name = compRef.split("/")[1];
    const target = ctx.sources.byKindName.get("Resource/" + name + "-postgres")
      || ctx.sources.byKindName.get("Resource/" + name + "-database")
      || ctx.sources.byKindName.get("Resource/" + name + "-db")
      || findDatabaseResource(ctx, name);
    if (!target) {
      ctx.diagnostics.push({
        severity: "warning",
        code: "AGENTDOC_RESOURCE_CANDIDATE",
        subject: compRef,
        refs: [compRef],
        message:
          "component '" + name + "' has migration and connection authority but no authored logical-database Resource; " +
          "declare one or record why the database is owned elsewhere",
        paths: [evidencePath],
      });
      ctx.addFact(compRef, "resource.ownership", null, {
        evidenceClass: "DERIVED", confidence: "candidate", provRecs: [pr],
        semantics: "this component opens a database connection, but no authored Resource claims ownership",
      });
      return withDirs({ migrationAuthority: evidencePath });
    }
    ctx.addFact(compRef, "resource.ownership", target.name, {
      evidenceClass: "DERIVED", confidence: "deterministic", provRecs: [pr],
      semantics: "migration and connection authority in this root resolve to the authored logical database",
    });
    // Migrations and a connection string are the same dependency a declared
    // client matcher would find, so the edge carries the same instance key and
    // the two routes merge into one fact.
    const client = ctx.clientKeyForResourceType("logical-database");
    const attrs = client ? { via: "migrations+connection", client } : { via: "migrations+connection" };
    ctx.addEdge("usesResource", compRef, target.ref, attrs, [pr], "DERIVED");
    return withDirs({
      migrationAuthority: evidencePath,
      bindings: [{ kind: "database", logicalResourceRef: target.ref, resolution: "resolved", provenanceIds: null, _provs: new Set([pr]) }],
    });
  }
}

const POOL_HINT = /(createPool|new Pool|pg\.Pool|PgPool|psycopg2?\.connect|asyncpg\.(?:connect|create_pool)|sql\.Open|mysql\.createConnection|Pool\(|DataSource|prisma\.(datasource|client)|DATABASE_URL|DB_DSN|sqlx::migrate!|tokio_postgres|tokio-postgres|deadpool|sea_orm|sea-orm|diesel::|create_engine\s*\(|\bDATABASES\s*=)/;

function hasConnectionEvidence(ctx, unit) {
  for (const f of ctx.repo.walkUnit(unit.root)) {
    if (/\.(ts|tsx|js|mjs|go|py|rb|java|kt|rs|ex|cs|php)$/.test(f)) {
      if (/(^|\/)(tests?|__tests__)\//.test(f)) continue;
      if (POOL_HINT.test(ctx.repo.readText(f))) return true;
    }
  }
  return false;
}

// A Resource whose name starts with the component name and whose type is a
// database. A deterministic naming convention, not a guess: an ambiguous match
// is left unresolved.
function findDatabaseResource(ctx, name) {
  const cands = ctx.sources.entities.filter(
    (e) => e.kind === "Resource" && e.doc.spec.type === "logical-database" && e.name.startsWith(name)
  );
  return cands.length === 1 ? cands[0] : null;
}

// ── migration directories ───────────────────────────────────────────────────
//
// Two routes, each with its own evidence:
//   - a directory named by convention (`migrations`, `migration`,
//     `alembic/versions`), evidenced by a file inside it;
//   - Drizzle Kit's `out`, evidenced by the config file that states it.
// Prisma Migrate writes to `prisma/migrations`, which the first route covers.
function recordMigrationDirs(ctx, unit, conventionDirs, ormConfig, pr) {
  const { repo, prov, compRef } = ctx;
  const subject = "der:" + compRef + ":/migrationDirs";
  const byPath = new Map();
  const add = (dir, via, rec) => {
    if (!byPath.has(dir)) byPath.set(dir, { path: dir, via: new Set(), _provs: new Set() });
    byPath.get(dir).via.add(via);
    byPath.get(dir)._provs.add(rec);
  };
  for (const dir of conventionDirs) {
    // A directory with no file in the input set has nothing a change could
    // touch, and nothing to cite as evidence.
    const file = repo.walkUnit(unit.root, dir)[0];
    if (!file) continue;
    let rec;
    if (file === pr.path) {
      rec = pr;
      pr.subjects.add(subject);
    } else {
      rec = prov.add("observed", file, "migration-extractor", [subject]);
    }
    add(dir, /(^|\/)alembic\/versions$/.test(dir) ? "alembic-versions" : "directory-name", rec);
  }
  if (ormConfig && /(^|\/)drizzle\.config\.[cm]?[jt]s$/.test(ormConfig)) {
    const dir = drizzleOutDir(ctx, unit, ormConfig);
    if (dir) add(dir, "drizzle-config", prov.add("observed", ormConfig, "drizzle-config-extractor", [subject]));
  }
  return [...byPath.values()]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((d) => ({ path: d.path, via: [...d.via].sort(), provenanceIds: null, _provs: d._provs }));
}

// Drizzle Kit writes migrations to `out`, `./drizzle` when absent. The config
// is code, and it is never executed: only a string literal is read. Anything
// else — an expression, an environment variable, a spread that could carry
// `out`, several `out` keys — is reported and not guessed, because a wrong
// directory would route migrations to the wrong database silently.
function drizzleOutDir(ctx, unit, configPath) {
  const { repo, compRef } = ctx;
  const unresolved = (why) => {
    ctx.diagnostics.push({
      severity: "warning",
      code: "AGENTDOC_MIGRATION_DIR_UNRESOLVED",
      subject: compRef,
      refs: [compRef],
      message:
        "Drizzle migration directory in '" + configPath + "' is not recorded: " + why + ". " +
        "Declare it with spec.migrationPaths on the logical-database Resource it migrates",
      paths: [configPath],
    });
    return null;
  };
  const parsed = drizzleOut(repo.readText(configPath));
  if (parsed.error) return unresolved(parsed.error);
  const value = parsed.value ?? "./drizzle";
  // Relative to the directory drizzle-kit runs from, which is the config's own
  // directory in the documented layout (and the unit root here).
  const base = configPath.includes("/") ? configPath.slice(0, configPath.lastIndexOf("/")) : ".";
  const dir = value.startsWith("/") ? null : canonicalPath(joinPath(base, value));
  if (!dir || dir === "." || dir === canonicalPath(unit.root)) {
    return unresolved("out " + JSON.stringify(value) + " is not a directory inside the unit at '" + unit.root + "'");
  }
  if (!repo.ownsUnitPath(unit.root, dir)) {
    return unresolved("out " + JSON.stringify(value) + " is outside the unit at '" + unit.root + "'");
  }
  // Not generated yet: nothing to classify. The probe is an input, so the
  // first generated migration invalidates the graph.
  if (!repo.isDir(dir)) return null;
  return dir;
}

// Static read of `out` from a Drizzle config. Comments are removed and string
// literals set aside first, so neither `// out: "x"` nor a string containing
// "out:" is mistaken for the key.
export function drizzleOut(text) {
  const strings = [];
  let code = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      code += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < text.length) {
        if (text[j] === "\\") {
          value += text[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (text[j] === c) { closed = true; break; }
        if (c !== "`" && text[j] === "\n") break;
        value += text[j];
        j++;
      }
      if (!closed) return { error: "the config could not be read statically" };
      // A template with a substitution is an expression, not a literal.
      strings.push(c === "`" && value.includes("${") ? null : value);
      code += "\u0000" + (strings.length - 1) + "\u0000";
      i = j + 1;
      continue;
    }
    code += c;
    i++;
  }
  const hits = [];
  for (const m of code.matchAll(/(?:^|[{,\s])(?:out|\u0000(\d+)\u0000)\s*(:|[,}])/g)) {
    // A quoted key counts only when it says "out".
    if (m[1] !== undefined && strings[Number(m[1])] !== "out") continue;
    hits.push(m);
  }
  if (hits.length === 0) {
    // A spread could bring `out` in from elsewhere; the default is then a guess.
    if (/\.\.\.\s*[A-Za-z_$(]/.test(code)) return { error: "the config spreads another object that may set out" };
    return { value: null };
  }
  if (hits.length > 1) return { error: "out is set more than once" };
  const m = hits[0];
  if (m[2] !== ":") return { error: "out is a shorthand property, not a string literal" };
  const rest = code.slice(m.index + m[0].length);
  const lit = /^\s*\u0000(\d+)\u0000\s*(?:[,}]|$)/.exec(rest);
  const value = lit ? strings[Number(lit[1])] : null;
  if (typeof value !== "string" || value.trim() === "") return { error: "out is not a string literal" };
  return { value };
}
