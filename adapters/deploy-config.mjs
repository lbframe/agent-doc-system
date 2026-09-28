// Deployment-config adapter: platform manifests that make a root deployable.
// Only the file's existence is treated as evidence; no value from these files
// is ever reported as deployed state.
import { Adapter } from "./registry.mjs";

const DEPLOY_FILES = [
  "fly.toml", "app.yaml", "render.yaml", "railway.json", "vercel.json",
  "netlify.toml", "heroku.yml", "Procfile", "service.yaml", "k8s/deployment.yaml",
  "chart/Chart.yaml", "serverless.yml", "serverless.yaml", "ansible.cfg",
];

export class DeployConfigAdapter extends Adapter {
  static adapterName = "deploy-config";
  constructor() {
    super({ name: "deploy-config", version: "1.0.0", kind: "unit-marker" });
  }
  detect(ctx, root) {
    for (const n of DEPLOY_FILES) {
      if (ctx.repo.exists(root + "/" + n)) return { path: root + "/" + n, shape: "deployable" };
    }
    return null;
  }
  extract(ctx, unit) {
    const { repo, prov, compRef } = ctx;
    const out = { deployConfigs: [] };
    for (const n of DEPLOY_FILES) {
      const p = unit.root + "/" + n;
      if (!repo.exists(p)) continue;
      prov.add("observed", p, "deploy-extractor", ["der:" + compRef + ":/artifact"]);
      out.deployConfigs.push(p);
    }
    return out;
  }
}
