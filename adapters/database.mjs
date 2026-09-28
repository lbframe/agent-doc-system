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

const ORM_CONFIG = [
  "drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs",
  "prisma/schema.prisma", "schema.prisma",
  "knexfile.js", "knexfile.ts", "sequelize.config.js", "ormconfig.json",
];

export class DatabaseAdapter extends Adapter {
  static adapterName = "database";
  constructor() {
    super({ name: "database", version: "1.0.0", kind: "source" });
  }
  extract(ctx, unit) {
    const { repo, prov, compRef } = ctx;
    const root = unit.root;
    const migrationDirs = findMigrationDirs(repo, root);
    const ormConfig = firstExistingFile(repo, root, ORM_CONFIG);
    if (!migrationDirs.length && !ormConfig) return {};

    let evidencePath = ormConfig;
    if (migrationDirs.length) {
      evidencePath = repo.walk(migrationDirs[0])[0] || migrationDirs[0];
    }
    const pr = prov.add("observed", evidencePath, "migration-extractor", ["der:" + compRef + ":/bindings"]);

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
      return { migrationAuthority: evidencePath };
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
      return { migrationAuthority: evidencePath };
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
    return {
      migrationAuthority: evidencePath,
      bindings: [{ kind: "database", logicalResourceRef: target.ref, resolution: "resolved", provenanceIds: null, _provs: new Set([pr]) }],
    };
  }
}

const POOL_HINT = /(createPool|new Pool|pg\.Pool|psycopg2?\.connect|sql\.Open|mysql\.createConnection|Pool\(|DataSource|prisma\.(datasource|client)|DATABASE_URL|DB_DSN)/;

function hasConnectionEvidence(ctx, unit) {
  for (const f of ctx.repo.walk(unit.root)) {
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
