#!/usr/bin/env node
// Local-only, disposable copies; no network and no edits to shipped corpora.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../../core/compile.mjs";
import { compileSnapshot } from "../../core/snapshot.mjs";
import { prepare, serializePacket } from "../../core/context/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentdoc-context-bench-"));
const corpora = ["fixtures/a-node-ts-postgres", "fixtures/b-go-multi-service", "fixtures/c-alt-monorepo", "fixtures/e-rust-workspace", "fixtures/f-python-workspace", "examples/koda/repo"];
const measure = (fn) => { const start = performance.now(); const result = fn(); return { ms: performance.now() - start, result }; };
const rounds = 3;
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
try {
  const results = [];
  for (const [index, corpus] of corpora.entries()) {
    const dir = path.join(temp, String(index));
    fs.cpSync(path.join(root, corpus), dir, { recursive: true, filter: (file) => ![".agentdoc", ".git"].includes(path.basename(file)) });
    const full = measure(() => compile(dir, { noGit: true, telemetry: true }));
    assert.deepEqual(full.result.errors, []);
    const cold = measure(() => compileSnapshot(dir, { noGit: true }));
    assert.equal(cold.result.serialized, full.result.serialized);
    const warm = [];
    for (let i = 0; i < rounds; i++) {
      const hit = measure(() => compileSnapshot(dir, { noGit: true }));
      assert.equal(hit.result.cache.hit, true);
      assert.equal(hit.result.serialized, full.result.serialized);
      warm.push(hit);
    }
    const subject = full.result.graph.entities.find(e => e.kind === "Component").ref;
    const request = { task: "Review changes to this component", paths: [subject], intent: "review", budget: { tokens: 4096 } };
    fs.rmSync(path.join(dir, ".agentdoc/cache/compiled-v1.json"), { force: true });
    const prepareCold = measure(() => prepare(dir, request, { noGit: true }));
    const prepareWarm = [];
    for (let i = 0; i < rounds; i++) {
      const hit = measure(() => prepare(dir, request, { noGit: true }));
      assert.equal(serializePacket(hit.result), serializePacket(prepareCold.result));
      prepareWarm.push(hit.ms);
    }
    const source = [...full.result.repo.readPaths.keys()].find(file => /\.(ts|js|go|rs|py)$/.test(file));
    let changed;
    if (source) {
      fs.appendFileSync(path.join(dir, source), "\n");
      changed = measure(() => compileSnapshot(dir, { noGit: true }));
      assert.equal(changed.result.cache.hit, false);
      assert.equal(changed.result.serialized, compile(dir, { noGit: true }).serialized);
    }
    results.push({ corpus, fullCompileMs: full.ms, snapshotColdMs: cold.ms,
      snapshotWarmMedianMs: median(warm.map(x => x.ms)), prepareColdMs: prepareCold.ms,
      prepareWarmMedianMs: median(prepareWarm), graphEquivalent: true, packetEquivalent: true,
      fullCounters: full.result.telemetry, coldCounters: cold.result.telemetry,
      warmCounters: warm[0].result.telemetry,
      changedSnapshot: changed ? { source, ms: changed.ms, counters: changed.result.telemetry, graphEquivalent: true } : null });
  }
  process.stdout.write(JSON.stringify({ method: "3 warm repeats; cold means no persistent compiled record, not empty operating-system caches; same Node process", node: process.version,
    platform: process.platform, arch: process.arch, cpus: os.cpus().length, memoryBytes: os.totalmem(), results }, null, 2) + "\n");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
