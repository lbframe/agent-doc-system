// Turborepo adapter: records task-graph driven verification commands and the
// pipeline they belong to. Turborepo knows how to run a task for one package
// and how to filter by dependency graph, which makes it the most precise
// verification answer available for a monorepo unit.
import { Adapter } from "./registry.mjs";
import { parseYamlDocuments } from "../core/yaml.mjs";

// Whether a declared task is a check is decided by `taskTier` alone, not by a
// second, narrower pattern. Two lists meant two places to disagree: a task that
// `TIERS` recognised — `e2e`, `playwright`, `drift:detect`, `generate:types` —
// was silently dropped because this filter had never heard of it, and the
// "untiered task" diagnostic could not fire for it either, since it sits after
// the filter. A verification entry that vanishes without a word is worse than
// one that is visibly untiered.

export class TurborepoAdapter extends Adapter {
  static adapterName = "turborepo";
  constructor() {
    super({ name: "turborepo", version: "1.0.0", kind: "ci" });
  }
  detect(ctx, root) {
    const p = root + "/turbo.json";
    if (!ctx.repo.exists(p)) return null;
    return { path: p, shape: "importable" };
  }
  extract(ctx, unit) {
    const { repo, prov, compRef } = ctx;
    const p = nearestTurboConfig(repo, unit.root);
    if (!p) return {};
    let doc;
    try {
      doc = JSON.parse(repo.readText(p));
    } catch {
      return {};
    }
    // Every declared task is considered; `taskTier` decides which are checks.
    // Filtering by a second pattern first is what silently dropped the tasks
    // that pattern had never heard of.
    const tasks = Object.keys(doc.tasks || doc.pipeline || {}).sort();
    if (!tasks.length) return {};
    const pr = prov.add("observed", p, "taskgraph-extractor", tasks.map((t) => "ver:tg:" + compRef + ":" + t));
    const pkgName = unit.pkgName;
    const scripts = Object.keys((unit.pkg || {}).scripts || {});
    const emitted = [];
    for (const t of tasks) {
      // A task-graph command is only real if this unit actually declares the
      // task. `turbo run test --filter=./apps/notifications` is not a command
      // when that package has no `test` script, and emitting it would put an
      // unrunnable command in front of an agent as if it were the answer.
      if (!scripts.includes(t)) continue;
      const tier = taskTier(t);
      if (!tier) {
        // A task with no tier is usually an ordinary package script (`dev`,
        // `docs`, `release`) and not a missing verification entry, so it is
        // dropped silently. A task that *looks* like a check but cannot be
        // tiered is a gap worth reporting, and this is the only place that can
        // tell the two apart.
        // A check task with no tier would otherwise vanish with no trace, and a
        // verification entry that is silently missing is worse than one that is
        // visibly untiered: nothing is left to notice the gap.
        ctx.diagnostics.push({
          severity: "warning",
          code: "AGENTDOC_VERIFICATION_UNTIERED",
          subject: compRef,
          refs: [compRef, p],
          message:
            "check task '" + t + "' has no recognisable tier and was not recorded as a verification entry. " +
            "Name the task test/lint/typecheck/build/e2e/integration/contract, or extend the adapter.",
        });
        continue;
      }
      const filter = pkgName ? " --filter=" + pkgName : " --filter=./" + unit.root;
      ctx.addVerification({
        id: "tg:" + compRef + ":" + t,
        componentRefs: [compRef],
        tier,
        command: "turbo run " + t + filter,
        configPaths: [p],
        provRecs: [pr],
      });
      emitted.push(t);
    }
    for (const t of tasks) if (!emitted.includes(t)) pr.subjects.delete("ver:tg:" + compRef + ":" + t);
    return {};
  }
  contracts() {
    return [];
  }
}

// The tier is derived from the whole task name, never from a fragment of it. A
// mis-tiered check is worse than an absent one: it is copied into a change set
// as though it proved something it does not, and an agent will run the cheap
// thing and believe the expensive thing was covered.
// A watch task is an interactive session, not a check. Recording `test:watch`
// as a runnable verification command hands an agent a process that never exits.
const NOT_A_CHECK = /(^|[:_-])(watch|dev|serve|start|preview)([:_-]|$)/;

const TIERS = [
  // Order matters: the most specific reading of a name wins. `e2e-lite` is an
  // integration suite that happens to contain "e2e", so it must be read before
  // the e2e row rather than after it.
  [/(^|[:_-])e2e-lite([:_-]|$)/, "integration"],
  [/(^|[:_-])(e2e|playwright|cypress|acceptance)([:_-]|$)/, "e2e"],
  [/(^|[:_-])(contract|openapi|drift|schema)([:_-]|$)/, "contract"],
  [/(^|[:_-])(integration|itest|e2e-lite)([:_-]|$)/, "integration"],
  [/(^|[:_-])(lint|typecheck|check-types|type-check|golangci|vet|fmt|format|audit)([:_-]|$)/, "static"],
  [/(^|[:_-])(unit|jest|vitest|mocha)([:_-]|$)/, "unit"],
  [/(^|[:_-])(build|compile|generate|bundle)([:_-]|$)/, "build"],
  // A bare `test`/`tests`/`verify`/`check` is a unit test by convention. A
  // repository that disagrees should name the tier, as above. This row is last
  // on purpose: `check:prettier` and `verify:lint` are formatting and lint
  // checks wearing a `check` prefix, and reading them as unit tests would put a
  // trivial command in front of an agent as if it covered behaviour.
  [/(^|[:_-])(test|tests|verify|check)([:_-]|$)/, "unit"],
];
function taskTier(t) {
  if (NOT_A_CHECK.test(t)) return null;
  for (const [re, tier] of TIERS) if (re.test(t)) return tier;
  return null;
}

// A task graph normally lives at the workspace root, not in each package.
function nearestTurboConfig(repo, root) {
  let dir = root;
  for (let i = 0; i < 12; i++) {
    const p = dir ? dir + "/turbo.json" : "turbo.json";
    if (repo.exists(p)) return p;
    if (!dir) break;
    dir = dir.split("/").slice(0, -1).join("/");
  }
  return null;
}

export { parseYamlDocuments };
