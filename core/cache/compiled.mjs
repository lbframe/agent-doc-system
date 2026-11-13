// One bounded, atomic cache record per repository. Cache errors only cost work.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "../fsx.mjs";

const LIMIT = 32 * 1024 * 1024;
const digest = (record) => sha256Hex(JSON.stringify([record.key, record.serialized, record.stats]));
export function readCompiledCache(file, key) {
  try {
    if (fs.statSync(file).size > LIMIT) return null;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record.version !== 1 || record.key !== key || typeof record.serialized !== "string") return null;
    if (!record.stats || digest(record) !== record.digest) return null;
    return record;
  } catch { return null; }
}

export function writeCompiledCache(file, record) {
  let temporary;
  try {
    for (const dir of [path.dirname(file), path.dirname(path.dirname(file))]) {
      if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) return false;
    }
    const text = JSON.stringify({ ...record, version: 1, digest: digest(record) });
    if (Buffer.byteLength(text) > LIMIT) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    temporary = file + "." + randomUUID() + ".tmp";
    fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
    return true;
  } catch { return false; }
  finally { if (temporary) { try { fs.rmSync(temporary, { force: true }); } catch { /* cache is optional */ } } }
}
