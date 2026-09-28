// Unit discovery.
//
// The core has no opinion about folder names. Which roots are units comes from
// two inputs only: the configured globs, and whatever the enabled adapters
// recognise as a unit marker. A root is eligible when it is either explicitly
// configured (supplementalRoots) or carries a unit marker from an adapter.
import path from "node:path";
import { AgentDocError, CODES } from "./codes.mjs";
import { expandGlob, globToRegExp, assertGlob } from "../core/fsx.mjs";

// Directories that are never units. Overridable, because "infra" or "tools"
// may be a legitimate unit in another project.
export const DEFAULT_NOT_UNIT_ROOTS = ["agentdoc", "docs", "scripts", "node_modules", ".github"];

export function discoverUnits(repo, cfg, adapters) {
  const notUnit = new Set(cfg.discovery.notUnitRoots || DEFAULT_NOT_UNIT_ROOTS);
  const extraDeployable = new Set();
  const extraImportable = new Set();
  const units = new Map();
  const get = (root) => {
    if (!units.has(root)) {
      units.set(root, { root, markers: [], deployable: false, importable: false, facts: {}, adapterFacts: {} });
    }
    return units.get(root);
  };

  // Candidate roots, derived without any knowledge of the layout:
  //   - the parent directory of every component descriptor (a descriptor can
  //     only sit at a unit root, by the location rule);
  //   - whatever an adapter recognises from a workspace file;
  //   - whatever the configuration declares explicitly.
  const candidates = new Set();
  const descriptorRoots = new Set();
  for (const g of cfg.discovery.componentDescriptors) {
    assertGlob(g, "agentdoc config");
    for (const f of expandGlob(repo, g)) {
      const dir = path.posix.dirname(f);
      if (!notUnit.has(dir) && repo.isDir(dir)) {
        candidates.add(dir);
        descriptorRoots.add(dir);
      }
    }
  }
  for (const r of cfg.discovery.supplementalRoots || []) candidates.add(r);

  // Adapters may contribute roots the descriptor globs cannot know about: a
  // Go workspace member, a workspace file member with no descriptor yet. The
  // core stays ignorant of the layout; only adapters know the layout.
  for (const a of adapters) {
    if (!a.roots) continue;
    for (const r of a.roots({ repo, cfg }) || []) {
      if (typeof r === "string") candidates.add(r);
      else if (r && typeof r === "object" && r.root) {
        candidates.add(r.root);
        if (r.deployable) extraDeployable.add(r.root);
        if (r.importable) extraImportable.add(r.root);
      }
    }
  }

  for (const root of [...candidates].sort()) {
    if (notUnit.has(root)) continue;
    if (!repo.isDir(root)) continue;
    const u = get(root);
    u.explicit = (cfg.discovery.supplementalRoots || []).includes(root) || descriptorRoots.has(root);
    if (extraDeployable.has(root)) u.deployable = true;
    if (extraImportable.has(root)) u.importable = true;
    for (const a of adapters) {
      const marker = a.detect ? a.detect({ repo, cfg, root }, root) : null;
      if (marker) {
        u.markers.push({ adapter: a.name, path: marker.path || marker, shape: marker.shape || "both" });
        const shape = markerShape(marker);
        if (shape === "deployable" || shape === "both") u.deployable = true;
        if (shape === "importable" || shape === "both") u.importable = true;
      }
    }
  }

  const list = [...units.values()].sort((a, b) => (a.root < b.root ? -1 : 1));
  const eligible = list.filter((u) => u.deployable || u.importable || u.explicit);
  return { units: list, eligible };
}

function markerShape(marker) {
  // Adapters may return {path, shape}. Default to "both" so a bare marker keeps
  // the unit eligible without asserting artifact shape it cannot prove.
  if (marker && typeof marker === "object") return marker.shape || "both";
  return "both";
}

export function descriptorDir(file) {
  return path.posix.dirname(file);
}

// Exactly one descriptor per eligible unit, and no descriptor outside one.
export function matchComponents(eligible, componentEntities) {
  const errors = [];
  const byDir = new Map();
  for (const e of componentEntities) {
    const dir = descriptorDir(e.file);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(e);
  }
  for (const u of eligible) {
    const descs = byDir.get(u.root) || [];
    if (descs.length === 0) {
      const why = u.markers.map((m) => m.adapter).join(", ") || "configured";
      errors.push(new AgentDocError(
        CODES.COVERAGE_ZERO,
        "unit '" + u.root + "' is recognised (" + why + ") but has no component descriptor at " + u.root + "/<descriptor>",
        { ref: u.root }
      ));
    } else if (descs.length > 1) {
      errors.push(new AgentDocError(
        CODES.COVERAGE_MULTI,
        "unit '" + u.root + "' matches " + descs.length + " component descriptors",
        { path: descs[0].file }
      ));
    } else {
      u.component = descs[0];
    }
  }
  const unitRoots = new Set(eligible.map((u) => u.root));
  for (const e of componentEntities) {
    const dir = descriptorDir(e.file);
    if (unitRoots.has(dir)) continue;
    // A descriptor is a human claim that a component exists. When no adapter
    // can corroborate a deployable or importable artifact in that source root,
    // the claim is unsupported. This is reported rather than ignored: it is
    // either a missing adapter, a wrong descriptor location, or a component
    // that no longer exists.
    errors.push(new AgentDocError(
      CODES.COMPONENT_UNCORROBORATED,
      "component descriptor at '" + dir + "' is not matched by any recognised unit: " +
        "no adapter found a deployable or importable artifact in that source root. " +
        "Check the descriptor location, or enable the adapter for this technology.",
      { path: e.file, ref: e.ref }
    ));
  }
  return { errors };
}

// Directories covered by configured globs, used by audit to spot documentation
// or contracts that no descriptor claims.
export function configuredGlobs(cfg) {
  return [...cfg.discovery.componentDescriptors, ...cfg.discovery.centralDescriptors];
}
