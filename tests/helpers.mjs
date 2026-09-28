// Test helpers: build a throwaway repository on disk, compile it, and assert on
// diagnostics. Every test owns its fixture and removes it afterwards.
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../core/compile.mjs";

export const SYSTEM_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  const text = String(content);
  writeFileSync(abs, text.endsWith("\n") ? text + "\n" : text);
}

export function read(dir, rel) {
  return readFileSync(path.join(dir, rel), "utf8");
}

export function exists(dir, rel) {
  return existsSync(path.join(dir, rel));
}

export function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

export function commitAll(dir, message = "fixture") {
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "core.hooksPath=/dev/null", "commit", "-m", message, "--allow-empty"]);
}

// A minimal but complete repository: one TypeScript service, one contract, one
// database, one CI workflow. Enough that a schema or discovery regression shows
// up as a specific error code rather than as noise.
export function baseFixture(t, { descriptors, config, extra = {}, contract = "openapi" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdoc-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);

  write(dir, "package.json", JSON.stringify({ name: "root", private: true, scripts: { lint: "eslint ." } }));
  write(dir, "service/package.json", JSON.stringify({
    name: "@t/svc", version: "1.0.0", main: "dist/index.js",
    scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
    dependencies: { pg: "^8.13.1" },
  }));
  write(dir, "service/tsconfig.json", JSON.stringify({ compilerOptions: { composite: true } }));
  write(dir, "service/src/index.ts", 'export const NAME = "svc";\nexport const PORT = 8080;\n');
  write(dir, "service/src/db.ts", 'export const pool = { total: 1 };\nexport const DATABASE_URL = "postgres://x";\n');
  write(dir, "service/db/migrations/0001_init.sql", "CREATE TABLE t (id text primary key);\n");
  write(dir, "service/Dockerfile", "FROM node:22-alpine\n");
  write(dir, "service/CONSTRAINTS.md", "# Constraints\n\n- One rule.\n  - Reason: because.\n  - Checked by: `pnpm test`\n");
  write(dir, ".github/workflows/ci.yml", "name: ci\non: { pull_request: {} }\njobs:\n  t:\n    steps:\n      - run: pnpm --filter @t/svc test\n");

  if (contract === "openapi") {
    write(dir, "contracts/svc.openapi.yaml", 'openapi: 3.1.0\ninfo:\n  title: SVC\n  version: "1.0.0"\npaths:\n  /t:\n    get:\n      operationId: getT\n      responses: { "200": { description: ok } }\ncomponents: {}\n');
  }

  write(dir, "agentdoc/agentdoc.config.yaml", config ?? DEFAULT_CONFIG);
  write(dir, "agentdoc/domains.yaml", 'apiVersion: agentdoc.dev/v1\nkind: Domain\nmetadata:\n  name: d1\n  description: "A domain for the test fixture."\nspec: {}\n');
  write(dir, "agentdoc/systems.yaml", 'apiVersion: agentdoc.dev/v1\nkind: System\nmetadata:\n  name: s1\n  description: "A system inside the test domain."\nspec:\n  domain: d1\n');
  write(dir, "agentdoc/apis.yaml", 'apiVersion: agentdoc.dev/v1\nkind: API\nmetadata:\n  name: svc-api\n  description: "Canonical HTTP surface of the test service."\nspec:\n  type: openapi\n  provider: component:default/svc\n  contract:\n    ref: contracts/svc.openapi.yaml\n');
  write(dir, "agentdoc/resources.yaml", 'apiVersion: agentdoc.dev/v1\nkind: Resource\nmetadata:\n  name: svc-postgres\n  description: "Logical database owned by the test service."\nspec:\n  type: logical-database\n  system: s1\n');
  write(dir, "agentdoc/journeys.yaml", "schemaVersion: agentdoc.dev/journeys/v1\njourneys: []\n");

  const list = descriptors ?? [
    'apiVersion: agentdoc.dev/v1\nkind: Component\nmetadata:\n  name: svc\n  description: "Serves the test surface."\nspec:\n  type: service\n  system: s1\n  context:\n    constraints:\n      - service/CONSTRAINTS.md\n',
  ];
  write(dir, "service/agentdoc.yaml", list[0]);
  for (const [rel, content] of Object.entries(extra)) write(dir, rel, content);
  write(dir, ".gitignore", "/.agentdoc/\n");
  commitAll(dir);
  return dir;
}

export const DEFAULT_CONFIG = [
  "apiVersion: agentdoc.dev/config/v1",
  "namespace: default",
  "discovery:",
  "  componentDescriptorName: agentdoc.yaml",
  "  componentDescriptors:",
  "    - service/**/agentdoc.yaml",
  "  centralDescriptors:",
  "    - agentdoc/domains.yaml",
  "    - agentdoc/systems.yaml",
  "    - agentdoc/apis.yaml",
  "    - agentdoc/resources.yaml",
  "  journeyDefinitions: agentdoc/journeys.yaml",
  "  contractRoots:",
  "    - contracts",
  "adapters:",
  "  - node",
  "  - typescript",
  "  - openapi",
  "  - database",
  "  - dockerfile",
  "  - github-actions",
  "authority:",
  "  rules: []",
  "reviewedOverrides: []",
  "warningAcceptances: []",
  "output:",
  "  graph: .agentdoc/graph.json",
  "  observations: agentdoc/observations",
  "",
].join("\n");

export function codes(res) {
  return (res.errors || []).map((e) => e.code);
}

export function hasCode(res, code) {
  return codes(res).includes(code);
}

// Reviewed overrides pin their evidence by content hash, and those digests are
// re-verified on every compile. Tests therefore have to state a real digest, or
// the override fails for the wrong reason and the test proves nothing about the
// behaviour it names. This computes the current digest from the fixture.
export function evidence(dir, paths) {
  return paths
    .map((p) => {
      const buf = readFileSync(path.join(dir, p));
      return "      - path: " + p + "\n        sha256: " + createHash("sha256").update(buf).digest("hex");
    })
    .join("\n");
}

export function graphOf(dir) {
  return JSON.parse(read(dir, ".agentdoc/graph.json"));
}

export function cli(dir, args) {
  return execFileSync("node", [path.join(SYSTEM_ROOT, "bin", "agentdoc.mjs"), ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function cliFails(dir, args) {
  try {
    cli(dir, args);
    return null;
  } catch (e) {
    return { status: e.status, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

export { compile };
