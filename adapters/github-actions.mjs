// GitHub Actions is verification authority, not evidence of an artifact.
// Scope each check from its own invocation; a mention elsewhere in a workflow
// says nothing about which component that command checks.
import path from "node:path";
import { Adapter } from "./registry.mjs";
import { parseYamlDocuments } from "../core/yaml.mjs";

export class GitHubActionsAdapter extends Adapter {
  static adapterName = "github-actions";
  constructor() {
    super({ name: "github-actions", version: "1.1.0", kind: "ci" });
  }
  // GitHub runs only repository-root workflows. A workflow directory is not a
  // unit marker, and nested workflows (vendored code, subtrees) are inert.
  contracts(ctx) {
    const dir = ".github/workflows";
    if (!ctx.repo.isDir(dir)) return [];
    const units = ctx.discovery.eligible.filter((u) => u.component);
    for (const f of ctx.repo.walk(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
      let doc;
      try { doc = parseYamlDocuments(ctx.repo.readText(f), f)[0]?.doc; } catch { continue; }
      const pr = ctx.prov.add("observed", f, "ci-extractor", []);
      const filters = Object.values(doc?.on || {}).flatMap((trigger) => Array.isArray(trigger?.paths) ? trigger.paths : []);
      for (const [jobName, job] of Object.entries(doc?.jobs || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        for (const [i, step] of (job?.steps || []).entries()) {
          // `uses` names an action, not a shell invocation we can classify.
          if (typeof step?.run !== "string") continue;
          const cwd = step["working-directory"] ?? job.defaults?.run?.["working-directory"] ?? doc.defaults?.run?.["working-directory"];
          const commands = simpleCommands(step.run);
          for (const [n, { command, words }] of commands.entries()) {
            // A preceding directory/environment change makes subsequent lines
            // ambiguous. Do not invent their execution context.
            if (["cd", "pushd", "popd", "source", ".", "eval", "export"].includes(words[0])) break;
            const invocation = ciInvocation(words);
            if (!invocation || command.length > 600) continue;
            const { tier, args } = invocation;
            const covered = units.filter((u) => scopedTo(u, args, cwd, filters, units)).map((u) => u.component.ref).sort();
            const suffix = f.replace(/[^A-Za-z0-9]+/g, "-") + ":" + jobName + ":" + i + (commands.length > 1 ? ":" + n : "");
            const id = (covered.length ? "ci:" : "repo-gate:") + suffix;
            const directory = literalPath(cwd);
            const record = {
              id, tier,
              command: directory && directory !== "." ? "cd " + shellQuote(directory) + " && " + command : command,
              configPaths: [f], provRecs: [pr],
            };
            if (covered.length) ctx.addVerification({ ...record, componentRefs: covered });
            else ctx.addGate(record);
            pr.subjects.add((covered.length ? "ver:" : "gate:") + id);
          }
        }
      }
    }
    return [];
  }
}

// Read only simple shell invocations, splitting newline, `;` and `&&` outside
// quotes. Control flow, pipelines, substitutions and heredocs require shell
// interpretation, so refuse the step rather than extract text inside them.
function simpleCommands(run) {
  run = run.replace(/\\\r?\n/g, " ");
  const out = [];
  let words = [], word = "", quote = null, start = 0;
  const endWord = () => { if (word) words.push(word); word = ""; };
  const endCommand = (end) => {
    endWord();
    if (words.length) out.push({ command: run.slice(start, end).trim(), words });
    words = [];
  };
  for (let i = 0; i < run.length; i++) {
    const c = run[i];
    if (c === "`" || (c === "$" && run[i + 1] === "(")) return [];
    if (c === "\\" && quote !== "'") {
      const next = run[++i];
      if (next !== "\n" && next !== undefined) word += next;
    } else if (quote) {
      if (c === quote) quote = null;
      else if (c === "\n") return [];
      else word += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && !word) {
      endCommand(i);
      while (i < run.length && run[i] !== "\n") i++;
      start = i + 1;
    } else if (c === "\n" || c === ";" || (c === "&" && run[i + 1] === "&")) {
      endCommand(i);
      if (c === "&") i++;
      start = i + 1;
    } else if (/[|&<>(){}]/.test(c)) return [];
    else if (/\s/.test(c)) endWord();
    else word += c;
  }
  if (quote) return [];
  endCommand(run.length);
  if (out.some(({ words: [first] }) => /^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function)$/.test(first))) return [];
  return out;
}

function taskTier(task) {
  if (!/^(?:test|tests|e2e|integration|lint|typecheck|type-check|build|compile|check|api:check|contract|catalog|drift)(?:$|[:_-])/.test(task || "")) return null;
  if (/(?:^|[:_-])(?:e2e|playwright|cypress)(?:$|[:_-])/.test(task)) return "e2e";
  if (/(?:contract|openapi|api:check|drift|catalog)/.test(task)) return "contract";
  if (/(?:^|[:_-])integration(?:$|[:_-])/.test(task)) return "integration";
  if (/^(?:lint|typecheck|type-check)/.test(task)) return "static";
  if (/^tests?(?:$|[:_-])/.test(task)) return "unit";
  if (/^(?:build|compile)(?:$|[:_-])/.test(task)) return "build";
  return null;
}

const VALUE_OPTIONS = new Set(["--filter", "-F", "--prefix", "--dir", "--cwd", "-C", "--workspace", "-w"]);
function ciInvocation(words) {
  let [exe, ...args] = words;
  if (exe === "env") [exe, ...args] = args;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(exe || "")) [exe, ...args] = args;
  if (["uv", "poetry"].includes(exe) && args[0] === "run") [exe, ...args] = args.slice(1);
  if (["npx", "bunx"].includes(exe)) [exe, ...args] = args;
  const result = (tier, scopeArgs = args) => tier ? { tier, args: scopeArgs } : null;
  if (["npm", "pnpm", "yarn", "bun"].includes(exe)) {
    const selectors = [];
    while (args[0]?.startsWith("-")) {
      const option = args.shift();
      selectors.push(option);
      if (VALUE_OPTIONS.has(option) && args.length) selectors.push(args.shift());
    }
    if (args[0] === "exec") {
      const inner = ciInvocation(args.slice(1));
      return inner && { ...inner, args: [...selectors, ...inner.args] };
    }
    if (args[0] === "run") args.shift();
    return result(taskTier(args[0]), [...selectors, ...args.slice(1)]);
  }
  if (exe === "node") return result(args.includes("--test") ? "unit" : null);
  if (/^python(?:3(?:\.\d+)?)?$/.test(exe) && args[0] === "-m") return ciInvocation(args.slice(1));
  if (["pytest", "unittest", "vitest", "jest", "mocha", "ava"].includes(exe)) return result("unit");
  if (["playwright", "cypress"].includes(exe) && ["test", "run"].includes(args[0])) return result("e2e", args.slice(1));
  if (["eslint", "mypy", "golangci-lint"].includes(exe)) return result("static");
  if (["ruff", "biome"].includes(exe) && ["check", "lint"].includes(args[0])) return result("static", args.slice(1));
  if (exe === "tsc") return result(args.includes("--noEmit") ? "static" : "build");
  if (["go", "cargo", "dotnet"].includes(exe)) return result(({ test: "unit", vet: "static", clippy: "static", build: "build" })[args[0]], args.slice(1));
  if (exe === "make") return result(taskTier(args[0]), args.slice(1));
  if (exe === "agentdoc" && args[0] === "compile") return result("build", args.slice(1));
  return null;
}

function literalPath(value) {
  if (typeof value !== "string" || !value || /[$`*?!{}]/.test(value) || path.posix.isAbsolute(value)) return null;
  const p = path.posix.normalize(value);
  return p === ".." || p.startsWith("../") ? null : p.replace(/\/$/, "");
}
function within(p, root) { return root === "." || p === root || p.startsWith(root + "/"); }
function shellQuote(p) { return /^[A-Za-z0-9_./-]+$/.test(p) ? p : "'" + p.replace(/'/g, "'\\''") + "'"; }

function scopedTo(unit, args, cwd, filters, units) {
  const root = path.posix.normalize(unit.root);
  const directory = literalPath(cwd);
  // A directory belongs to its deepest enclosing component, not every parent.
  if (directory && within(directory, root) && !units.some((u) => u.root !== unit.root && within(directory, u.root) && within(u.root, root))) return true;
  if (cwd !== undefined && !directory) return false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    const [option, inline] = token.split(/=(.*)/s);
    const value = inline ?? args[i + 1];
    // Package names are scope only in an explicit package selector.
    if (unit.pkgName && ["--filter", "-F", "--workspace", "-w"].includes(option) && value === unit.pkgName) return true;
    const arg = token.startsWith("-") ? inline : token;
    if (!arg || /[$`]/.test(arg)) continue;
    if (path.posix.isAbsolute(arg)) continue;
    const p = literalPath(path.posix.join(directory || ".", arg.replace(/\/[*?].*$/, "")));
    if (p && root !== "." && within(p, root)) return true;
  }
  // A literal prefix in a workflow trigger is evidence of component scope.
  // Negative filters cannot create scope and can exclude an entire root.
  const matches = (filter) => {
    if (typeof filter !== "string") return false;
    const prefix = literalPath(filter.replace(/\/[*?].*$/, ""));
    return prefix && prefix !== "." && (within(prefix, root) || within(root, prefix));
  };
  return filters.some((p) => typeof p === "string" && !p.startsWith("!") && matches(p)) &&
    !filters.some((p) => typeof p === "string" && p.startsWith("!") && within(root, literalPath(p.slice(1).replace(/\/\*\*$/, "")) || "\0"));
}
