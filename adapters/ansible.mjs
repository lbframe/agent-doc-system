// Ansible adapter: what host provisioning actually installs.
//
// Reads the playbooks under a unit root without running anything and without
// evaluating a single Jinja expression. From every task reachable from a
// playbook (plays, roles, includes, blocks) it records the host paths the
// task creates and the services it manages. That inventory is the DERIVED side
// of a normative requirement whose `satisfiedBy` names this adapter and whose
// `expects` names a path or a service:
//
//   provided   a reachable, unconditional task installs it          deterministic
//   absent     no reachable task does, and every task is transparent  deterministic
//
// Anything weaker is a candidate, which the authority engine never elects: a
// matching task behind a `when`, or an absence claimed over a tree that holds
// an opaque task (a shell command, a package install, a templated path, a role
// that is not in the repository). An absence is only a fact when the adapter
// could have seen the opposite.
import { Adapter } from "./registry.mjs";
import { parseYamlDocuments } from "../core/yaml.mjs";
import { AgentDocError } from "../core/codes.mjs";

// Modules that create the path they name, and the arguments naming it.
const PATH_MODULES = {
  copy: ["dest"],
  template: ["dest"],
  unarchive: ["dest", "creates"],
  get_url: ["dest"],
  git: ["dest"],
  synchronize: ["dest"],
  pip: ["virtualenv"],
};
// `file` creates only for these states; `lineinfile`/`blockinfile` only with
// `create: true`.
const FILE_CREATING_STATES = new Set(["directory", "touch", "link", "hard"]);
const SERVICE_MODULES = new Set(["systemd", "systemd_service", "service"]);
// Commands can do anything; their `creates` is the one thing they promise.
const COMMAND_MODULES = new Set(["command", "shell", "script", "raw"]);
// Modules that change no file the adapter would be asked about.
const INERT_MODULES = new Set([
  "debug", "set_fact", "assert", "fail", "meta", "pause", "wait_for", "stat", "ping", "setup",
  "include_vars", "group_by", "add_host", "user", "group", "uri", "slurp", "fetch", "set_stats",
]);
// Task keywords, i.e. everything on a task that is not its module.
const TASK_KEYWORDS = new Set([
  "name", "when", "loop", "with_items", "with_dict", "with_fileglob", "loop_control", "register", "notify",
  "become", "become_user", "become_method", "tags", "vars", "environment", "args", "ignore_errors", "changed_when",
  "failed_when", "until", "retries", "delay", "no_log", "delegate_to", "run_once", "check_mode", "diff",
  "listen", "timeout", "throttle", "any_errors_fatal", "module_defaults", "collections", "connection",
]);
const INCLUDES = new Set(["include_tasks", "import_tasks", "include"]);
const ROLE_INCLUDES = new Set(["include_role", "import_role"]);

export class AnsibleAdapter extends Adapter {
  static adapterName = "ansible";
  constructor() {
    super({ name: "ansible", version: "1.0.0", kind: "source" });
  }

  // A unit that holds a playbook is a deployable infrastructure unit.
  detect(ctx, root) {
    const pb = playbooks(ctx.repo, root);
    return pb.length ? { path: pb[0].path, shape: "deployable" } : null;
  }

  extract(ctx, unit) {
    const inv = inventory(ctx.repo, unit.root);
    if (!inv.files.length) return {};
    for (const r of ctx.requirements || []) {
      if (r.subject !== ctx.compRef || !r.satisfiedBy.includes("ansible") || !r.expects) continue;
      const verdict = judge(inv, r.expects);
      const files = verdict.files.length ? verdict.files : inv.files;
      ctx.addFact(r.subject, r.key, verdict.value, {
        evidenceClass: "DERIVED",
        confidence: verdict.certain ? "deterministic" : "candidate",
        provRecs: files.map((f) => ctx.prov.add("observed", f, "ansible-extractor", ["ass:pending"])),
        semantics: "ansible: " + verdict.why,
      });
    }
    return {
      provisioning: {
        installs: inv.installs.map((i) => ({ path: i.path, file: i.file, task: i.task, conditional: i.conditional })),
        services: inv.services.map((s) => ({ name: s.name, file: s.file, task: s.task, conditional: s.conditional })),
        opaque: inv.opaque,
      },
    };
  }
}

function judge(inv, expects) {
  const target = expects.installs || expects.service;
  const what = expects.installs ? "path " + target : "service " + target;
  const hits = expects.installs
    ? inv.installs.filter((i) => i.path === target || i.path.startsWith(target + "/"))
    : inv.services.filter((s) => s.name === target || s.name === target + ".service");
  const sure = hits.filter((h) => !h.conditional);
  if (sure.length) {
    return { value: "provided", certain: true, files: uniq(sure.map((h) => h.file)), why: what + " installed by " + describe(sure[0]) };
  }
  if (hits.length) {
    return { value: "provided", certain: false, files: uniq(hits.map((h) => h.file)), why: what + " installed only conditionally by " + describe(hits[0]) };
  }
  if (inv.opaque.length) {
    return {
      value: "absent", certain: false, files: [],
      why: "no task installs " + what + ", but absence cannot be proven: " + inv.opaque.slice(0, 3).join("; ") +
        (inv.opaque.length > 3 ? " (+" + (inv.opaque.length - 3) + " more)" : ""),
    };
  }
  return { value: "absent", certain: true, files: [], why: "no reachable task installs " + what };
}

function describe(h) {
  return h.file + (h.task ? " (" + h.task + ")" : "");
}

function uniq(a) {
  return [...new Set(a)].sort();
}

function parse(repo, file) {
  try {
    return parseYamlDocuments(repo.readText(file), file, { allowSequenceRoot: true }).map((d) => d.doc);
  } catch (e) {
    if (e instanceof AgentDocError) return null;
    throw e;
  }
}

function isYaml(f) {
  return /\.ya?ml$/.test(f);
}

function playbooks(repo, root) {
  const out = [];
  for (const f of repo.walk(root)) {
    if (!isYaml(f) || /(^|\/)(tasks|handlers|vars|defaults|meta|group_vars|host_vars|templates|files)\//.test(f.slice(root.length))) continue;
    const docs = parse(repo, f);
    if (!docs) continue;
    const plays = docs.flatMap((d) => (Array.isArray(d) ? d : []));
    if (plays.length && plays.every((p) => p && typeof p === "object" && (p.hosts !== undefined || p.import_playbook !== undefined))) {
      out.push({ path: f, plays });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

// Every task reachable from a playbook under `root`, walked in a fixed order.
function inventory(repo, root) {
  const inv = { files: new Set(), installs: [], services: [], opaque: [] };
  const seen = new Set();
  const opaque = (file, task, why) => inv.opaque.push(file + (task ? " (" + task + ")" : "") + ": " + why);

  const dirOf = (p) => p.split("/").slice(0, -1).join("/");
  const join = (dir, rel) => {
    const parts = (dir ? dir.split("/") : []).concat(rel.split("/"));
    const out = [];
    for (const s of parts) {
      if (s === "" || s === ".") continue;
      if (s === "..") { if (!out.length) return null; out.pop(); } else out.push(s);
    }
    return out.join("/");
  };
  const templated = (v) => typeof v === "string" && /\{\{|\{%/.test(v);

  const findRole = (name, fromDir) => {
    for (const base of [fromDir, root]) {
      for (const ext of ["yml", "yaml"]) {
        const p = join(base, "roles/" + name + "/tasks/main." + ext);
        if (p && repo.exists(p)) return p;
      }
    }
    return null;
  };

  const walkFile = (file, conditional, kind) => {
    const key = file + "|" + conditional + "|" + kind;
    if (seen.has(key)) return;
    seen.add(key);
    inv.files.add(file);
    const docs = parse(repo, file);
    if (!docs) { opaque(file, null, "not parseable as YAML"); return; }
    const list = docs.flatMap((d) => (Array.isArray(d) ? d : []));
    if (kind === "playbook") for (const p of list) walkPlay(file, p, conditional);
    else walkTasks(file, list, conditional);
  };

  const walkPlay = (file, play, conditional) => {
    if (!play || typeof play !== "object") return;
    if (play.import_playbook !== undefined) {
      const ref = String(play.import_playbook);
      const p = !templated(ref) && join(dirOf(file), ref);
      if (p && repo.exists(p)) walkFile(p, conditional || play.when !== undefined, "playbook");
      else opaque(file, null, "imported playbook not resolvable in the repository: " + ref);
      return;
    }
    const cond = conditional || play.when !== undefined;
    for (const section of ["pre_tasks", "roles", "tasks", "post_tasks", "handlers"]) {
      const items = play[section];
      if (!Array.isArray(items)) continue;
      if (section === "roles") {
        for (const r of items) {
          const name = typeof r === "string" ? r : r && (r.role || r.name);
          walkRole(file, String(name), cond || (r && typeof r === "object" && r.when !== undefined));
        }
      } else {
        walkTasks(file, items, cond);
      }
    }
  };

  const walkRole = (file, name, conditional) => {
    const main = !templated(name) && findRole(name, dirOf(file));
    if (main) walkFile(main, conditional, "tasks");
    else opaque(file, null, "role not found in the repository: " + name);
  };

  const walkTasks = (file, tasks, conditional) => {
    for (const t of tasks) {
      if (!t || typeof t !== "object" || Array.isArray(t)) continue;
      const cond = conditional || t.when !== undefined;
      const label = typeof t.name === "string" ? t.name : null;
      if (Array.isArray(t.block)) {
        walkTasks(file, t.block, cond);
        // A rescue runs only when the block failed: never an unconditional install.
        for (const k of ["rescue", "always"]) if (Array.isArray(t[k])) walkTasks(file, t[k], cond || k === "rescue");
        continue;
      }
      const modKey = Object.keys(t).find((k) => !TASK_KEYWORDS.has(k));
      if (!modKey) continue;
      const mod = modKey.split(".").pop();
      const raw = t[modKey];
      const args = { ...parseFreeForm(raw), ...(t.args && typeof t.args === "object" ? t.args : {}) };
      // A loop runs the module once per item with a templated argument; the
      // adapter does not expand it.
      const looped = t.loop !== undefined || Object.keys(t).some((k) => k.startsWith("with_"));

      if (INCLUDES.has(mod)) {
        const ref = typeof raw === "string" ? raw.split(/\s+/)[0] : args.file;
        const p = ref && !templated(ref) && join(dirOf(file), String(ref));
        if (p && repo.exists(p)) walkFile(p, cond, "tasks");
        else opaque(file, label, "included task file not resolvable in the repository: " + ref);
        continue;
      }
      if (ROLE_INCLUDES.has(mod)) {
        walkRole(file, String(args.name), cond);
        continue;
      }
      const record = (list, entry) => list.push({ ...entry, file, task: label, conditional: cond });
      if (PATH_MODULES[mod] || mod === "file" || mod === "lineinfile" || mod === "blockinfile") {
        let names = PATH_MODULES[mod] || ["path", "dest", "name"];
        if (mod === "file" && !FILE_CREATING_STATES.has(String(args.state || "file"))) names = [];
        if ((mod === "lineinfile" || mod === "blockinfile") && !isTrue(args.create)) names = [];
        for (const n of names) {
          const v = args[n];
          if (v === undefined) continue;
          if (templated(v) || looped) { opaque(file, label, mod + " " + n + " is templated: " + v); continue; }
          record(inv.installs, { path: normalisePath(String(v)) });
        }
        continue;
      }
      if (SERVICE_MODULES.has(mod)) {
        const n = args.name;
        if (n === undefined) continue;
        if (templated(n) || looped) opaque(file, label, mod + " name is templated: " + n);
        else record(inv.services, { name: String(n) });
        continue;
      }
      if (COMMAND_MODULES.has(mod)) {
        if (args.creates !== undefined && !templated(args.creates) && !looped) {
          record(inv.installs, { path: normalisePath(String(args.creates)) });
        } else {
          opaque(file, label, mod + " task without a literal `creates`");
        }
        continue;
      }
      if (INERT_MODULES.has(mod)) continue;
      opaque(file, label, "module " + modKey + " is not modeled and may change the host");
    }
  };

  for (const pb of playbooks(repo, root)) walkFile(pb.path, false, "playbook");
  const byPath = (a, b) => (a.path + a.file < b.path + b.file ? -1 : a.path + a.file > b.path + b.file ? 1 : 0);
  return {
    files: [...inv.files].sort(),
    installs: inv.installs.sort(byPath),
    services: inv.services.sort((a, b) => (a.name + a.file < b.name + b.file ? -1 : 1)),
    opaque: [...new Set(inv.opaque)].sort(),
  };
}

// `file: path=/a state=directory` — the key=value shorthand.
function parseFreeForm(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return {};
  const out = {};
  for (const m of raw.matchAll(/(\w+)=("[^"]*"|'[^']*'|\S+)/g)) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  return out;
}

function isTrue(v) {
  return v === true || /^(yes|true)$/i.test(String(v));
}

function normalisePath(p) {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}
