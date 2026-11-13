import { sha256Hex } from "../fsx.mjs";

// Bounded content-addressed JSON parsing across snapshots in one process.
// Values are cloned on both boundaries: extractors may mutate their result.
export class ParseCache {
  constructor(maxBytes = 8 * 1024 * 1024) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.entries = new Map();
  }
  get(text) {
    const key = sha256Hex("json@1\0" + text);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }
  set(text, value) {
    const bytes = Buffer.byteLength(text);
    if (bytes > this.maxBytes) return;
    const key = sha256Hex("json@1\0" + text);
    if (this.entries.has(key)) this.bytes -= this.entries.get(key).bytes;
    this.entries.delete(key);
    while ((this.bytes + bytes > this.maxBytes || this.entries.size >= 1000) && this.entries.size) {
      const oldest = this.entries.keys().next().value;
      this.bytes -= this.entries.get(oldest).bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { bytes, value: structuredClone(value) });
    this.bytes += bytes;
  }
}
