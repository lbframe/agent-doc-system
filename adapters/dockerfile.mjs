// Dockerfile adapter: a Dockerfile is deployable-artifact evidence.
import { Adapter } from "./registry.mjs";

export class DockerfileAdapter extends Adapter {
  static adapterName = "dockerfile";
  constructor() {
    super({ name: "dockerfile", version: "1.0.0", kind: "unit-marker" });
  }
  detect(ctx, root) {
    for (const n of ["Dockerfile", "Dockerfile.prod", "Containerfile"]) {
      if (ctx.repo.exists(root + "/" + n)) return { path: root + "/" + n, shape: "deployable" };
    }
    return null;
  }
  extract(ctx, unit) {
    const { repo, prov, compRef } = ctx;
    const out = { dockerfiles: [] };
    for (const n of ["Dockerfile", "Dockerfile.prod", "Containerfile"]) {
      const p = unit.root + "/" + n;
      if (!repo.exists(p)) continue;
      prov.add("observed", p, "deploy-extractor", ["der:" + compRef + ":/artifact"]);
      out.dockerfiles.push(p);
    }
    return out;
  }
}
