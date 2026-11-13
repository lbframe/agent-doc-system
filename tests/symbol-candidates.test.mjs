import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { indexTypeScriptSymbols } from "../core/context/symbols.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-symbols-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "api.ts"), "// export function falseComment() {}\nexport function lookup(id: string) { return id; }\nconst message = 'export class FalseString {}';\nexport interface Entry { id: string }\n");
  fs.writeFileSync(path.join(root, "consumer.ts"), "import { lookup } from './api';\nexport const entry = lookup('one');\n// lookup('fake')\nconst text = `lookup('template')`;\n");
  return root;
}

test("symbol candidates: explicit TypeScript files produce navigable partial candidates", (t) => {
  const root = fixture(t);
  const index = indexTypeScriptSymbols(root, ["consumer.ts", "api.ts", "./api.ts"]);
  assert.equal(index.coverage.partial, true);
  assert.equal(index.coverage.checkSelection, "unchanged");
  assert.deepEqual(index.files.map((f) => f.path), ["api.ts", "consumer.ts"]);
  const api = index.files[0];
  assert.ok(api.declarations.some((d) => d.name === "lookup" && d.exported && d.line === 2));
  assert.ok(api.declarations.some((d) => d.name === "Entry" && d.kind === "interface"));
  assert.ok(!api.declarations.some((d) => d.name === "falseComment" || d.name === "FalseString"));
  const refs = index.files[1].references.filter((r) => r.name === "lookup");
  assert.deepEqual(refs.map((r) => r.line), [1, 2]);
  assert.match(api.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(indexTypeScriptSymbols(root, ["api.ts", "consumer.ts"]), index);
});

test("symbol candidates: evidence changes with source and unrelated files are not scanned", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "unrequested.ts"), "export function unrelated() {}\n");
  const first = indexTypeScriptSymbols(root, ["api.ts"]);
  fs.appendFileSync(path.join(root, "api.ts"), "export type Added = string;\n");
  const next = indexTypeScriptSymbols(root, ["api.ts"]);
  assert.notEqual(first.files[0].sha256, next.files[0].sha256);
  assert.ok(next.files[0].declarations.some((d) => d.name === "Added"));
  assert.equal(next.files.length, 1);
  assert.ok(!next.files[0].declarations.some((d) => d.name === "unrelated"));
});

test("symbol candidates: unsupported, escaping and symlink-escaping paths are refused", (t) => {
  const root = fixture(t);
  for (const files of [["../api.ts"], ["/tmp/api.ts"], ["api.js"], ["missing.ts"], []]) {
    assert.throws(() => indexTypeScriptSymbols(root, files), { code: "AGENTDOC_SYMBOL_REQUEST" });
  }
  fs.symlinkSync(path.join(root, ".."), path.join(root, "escape"));
  assert.throws(() => indexTypeScriptSymbols(root, ["escape/outside.ts"]), { code: "AGENTDOC_SYMBOL_REQUEST" });
});
