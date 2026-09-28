// GitHub Actions adapter.
//
// CI is a verification authority: a workflow that names a component's paths is
// the check that must be run for that component. Recording the mapping means
// an agent changing a component is told which gate covers it, instead of
// guessing or running everything.
import { Adapter } from "./registry.mjs";
import { parseYamlDocuments } from "../core/yaml.mjs";

export class GitHubActionsAdapter extends Adapter {
  static adapterName = "github-actions";
  constructor() {
    super({ name: "github-actions", version: "1.0.0", kind: "ci" });
  }
  detect(ctx, root) {
    const p = root + "/.github/workflows";
    if (!ctx.repo.isDir(p)) return null;
    return { path: p, shape: "importable" };
  }
  contracts(ctx) {
    const dir = ".github/workflows";
    if (!ctx.repo.isDir(dir)) return [];
    const out = [];
    const files = ctx.repo.walk(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
    const units = ctx.discovery.eligible.filter((u) => u.component);
    for (const f of files) {
      let text = "";
      try {
        text = ctx.repo.readText(f);
      } catch {
        continue;
      }
      let doc = null;
      try {
        doc = parseYamlDocuments(text, f)[0]?.doc;
      } catch {
        doc = null;
      }
      const steps = [];
      if (doc && doc.jobs) {
        for (const [jobName, job] of Object.entries(doc.jobs)) {
          for (const step of (job && job.steps) || []) {
            const run = [step.run, step.uses].filter(Boolean).join(" ");
            if (!run) continue;
            steps.push({ job: jobName, run: String(run) });
          }
        }
      }
      const covered = new Set();
      for (const u of units) {
        if (text.includes(u.root + "/") || (u.pkgName && text.includes(u.pkgName))) covered.add(u.component.ref);
      }
      const pr = ctx.prov.add("observed", f, "ci-extractor", []);
      const subjects = [];
      steps.forEach((s, i) => {
        if (!/[a-z0-9]/i.test(s.run)) return;
        const command = s.run.trim().slice(0, 600);
        // A step that installs dependencies or checks out code is not a check.
        // Recording it as one would bury the commands that actually gate.
        const tier = ciTier(command);
        if (!tier) return;
        const id = "ci:" + f.replace(/[^A-Za-z0-9]+/g, "-") + ":" + s.job + ":" + i;
        if (covered.size) {
          ctx.addVerification({
            id,
            componentRefs: [...covered].sort(),
            tier,
            command,
            configPaths: [f],
            provRecs: [pr],
          });
          subjects.push("ver:" + id);
        } else {
          // A gate that names no component is repository-wide: it applies to
          // everything, so it is recorded once as a gate rather than
          // duplicated onto every component.
          // The graph id must not itself start with the provenance prefix, or
          // the subject key becomes ambiguous. "repo-gate:" is unambiguous.
          const gid = "repo-gate:" + f.replace(/[^A-Za-z0-9]+/g, "-") + ":" + s.job + ":" + i;
          ctx.addGate({ id: gid, tier: ciTier(command), command, configPaths: [f], provRecs: [pr] });
          subjects.push("gate:" + gid);
        }
      });
      for (const s of subjects) pr.subjects.add(s);
      void steps;
      void covered;
    }
    return out;
  }
}

// Returns null for a step that is not a check. Install, checkout, cache and
// upload steps gate nothing and would only add noise to a routing surface.
const NOT_A_CHECK = /^\s*(?:-\s*)?(?:uses:\s*actions\/(?:checkout|cache|upload|download|setup-|artifact)|run:\s*(?:\w*\s*)?(?:pnpm|npm|yarn|bun)\s+(?:i|install|ci)\b)/i;

function ciTier(run) {
  if (NOT_A_CHECK.test(run.trim())) return null;
  if (/^uses:/.test(run.trim()) && !/check|lint|test|build|audit|scan/i.test(run)) return null;
  if (/e2e|playwright|cypress/.test(run)) return "e2e";
  if (/contract|openapi|api:check|drift|catalog/.test(run)) return "contract";
  if (/integration/.test(run)) return "integration";
  if (/lint|typecheck|type-check|golangci|vet/.test(run)) return "static";
  if (/\btest\b|pytest|vitest|jest|go test/.test(run)) return "unit";
  if (/\bbuild\b|tsc|compile/.test(run)) return "build";
  return null;
}
