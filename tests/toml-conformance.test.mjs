import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parse } from "../core/toml.mjs";
import { AgentDocError, CODES } from "../core/codes.mjs";

// Upstream fixtures and expected values: see fixtures/toml/LICENSE and README.md.
const corpus = new URL("./fixtures/toml/", import.meta.url);
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    return entry.isDirectory() ? files(url) : entry.name.endsWith(".toml") ? [url] : [];
  });
}

function float(value) {
  if (value.endsWith("inf")) return value.startsWith("-") ? -Infinity : Infinity;
  return Number(value);
}

function date(value) {
  return value.replace("t", "T").replace(" ", "T").replace("z", "Z")
    .replace("+00:00", "Z").replace(/(\.\d*?)0+(?=Z|[+-]\d\d:|$)/, "$1")
    .replace(/\.(?=Z|[+-]\d\d:|$)/, "");
}

function compare(actual, expected) {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.equal(actual.length, expected.length);
    expected.forEach((value, i) => compare(actual[i], value));
  } else if (typeof expected.type === "string" && typeof expected.value === "string") {
    const { type, value } = expected;
    if (type === "integer") {
      const integer = BigInt(value);
      assert.equal(actual, integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(integer) : integer);
    } else if (type === "float") {
      assert.equal(actual, float(value));
    } else if (type === "bool") {
      assert.equal(actual, value === "true");
    } else if (type.startsWith("date") || type === "time-local") {
      assert.equal(typeof actual, "string");
      assert.equal(date(actual), date(value));
    } else {
      assert.equal(type, "string");
      assert.equal(actual, value);
    }
  } else {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
    for (const key of Object.keys(expected)) compare(actual[key], expected[key]);
  }
}

function rejects(src, path = "manifest.toml") {
  assert.throws(() => parse(src, path), (error) => {
    assert.ok(error instanceof AgentDocError);
    assert.equal(error.code, CODES.YAML_PARSE);
    assert.equal(error.path, path);
    assert.ok(error.line >= 1);
    return true;
  });
}

for (const file of files(new URL("valid/", corpus))) {
  test("TOML 1.0 valid: " + file.href.slice(corpus.href.length), () => {
    const expected = JSON.parse(fs.readFileSync(new URL(file.href.replace(/\.toml$/, ".json")), "utf8"));
    const bytes = fs.readFileSync(file);
    compare(parse(bytes, file.pathname), expected);
    compare(parse(bytes.toString("utf8"), file.pathname), expected);
  });
}
for (const file of files(new URL("invalid/", corpus))) {
  test("TOML 1.0 invalid: " + file.href.slice(corpus.href.length), () => {
    rejects(fs.readFileSync(file), file.pathname);
  });
}

test("TOML: implicit parents may be declared once; array children follow the latest element", () => {
  assert.deepEqual(parse("[a.b]\nx = 1\n[a]\ny = 2\n"), { a: { b: { x: 1 }, y: 2 } });
  assert.deepEqual(parse("[[a]]\n[a.b]\nx = 1\n[[a]]\n[a.b]\nx = 2\n"), {
    a: [{ b: { x: 1 } }, { b: { x: 2 } }],
  });
  assert.deepEqual(parse("a.b = 1\na.c = 2\n[a.d]\nx = 3\n"), { a: { b: 1, c: 2, d: { x: 3 } } });
  assert.deepEqual(parse("x = { a.b = 1, a.c = 2 }"), { x: { a: { b: 1, c: 2 } } });
});

test("TOML: prototype names are ordinary own keys without changing object prototypes", () => {
  const doc = parse("__proto__.safe = true\nconstructor.toString = 1\ntoString = 2\n");
  assert.deepEqual(Object.keys(doc), ["__proto__", "constructor", "toString"]);
  assert.equal(Object.getPrototypeOf(doc), Object.prototype);
  assert.equal(Object.getPrototypeOf(doc.__proto__), Object.prototype);
  assert.deepEqual(doc.__proto__, { safe: true });
  assert.deepEqual(doc.constructor, { toString: 1 });
  assert.equal(doc.toString, 2);
  assert.equal(Object.hasOwn(Object.prototype, "safe"), false);
  rejects("[__proto__]\n[__proto__]\n");
});

test("TOML: integer precision, float overflow and signed zero", () => {
  assert.deepEqual(parse("a = 9007199254740991\nb = 9007199254740993\nc = -9223372036854775808\nd = 0x7fff_ffff_ffff_ffff\ne = 0o777777777777777777777\nf = 0b111111111111111111111111111111111111111111111111111111111111111"), {
    a: Number.MAX_SAFE_INTEGER, b: 9007199254740993n, c: -9223372036854775808n,
    d: 9223372036854775807n, e: 9223372036854775807n, f: 9223372036854775807n,
  });
  assert.deepEqual(parse("a = 1e999\nb = -1e999\nc = -0\nd = -0.0"), { a: Infinity, b: -Infinity, c: 0, d: -0 });
});

test("TOML: Unicode scalars, UTF-8 bytes and CRLF preserve string values", () => {
  const source = 'x = "�😀"\r\ny = """\r\na\r\nb"""\r\n';
  for (const input of [source, Buffer.from(source), new Uint8Array(Buffer.from(source))]) {
    assert.deepEqual(parse(input), { x: "�😀", y: "a\nb" });
  }
  rejects('x = "\ud800"');
  rejects('# \udfff');
  rejects('\ufeffx = 1');
  rejects(Buffer.from('\ufeffx = 1'));
  rejects('x = "bare\rreturn"');
});

test("TOML: delimiters and dates reject adjacent invalid forms", () => {
  for (const quote of ['"', "'"]) {
    assert.equal(parse("x = " + quote.repeat(3) + "hello" + quote.repeat(4)).x, "hello" + quote);
    assert.equal(parse("x = " + quote.repeat(3) + "hello" + quote.repeat(5)).x, "hello" + quote.repeat(2));
    rejects("x = " + quote.repeat(3) + "hello" + quote.repeat(6));
  }
  assert.deepEqual(parse("x = 2024-02-29 # comment\ny = [2024-02-29 , 2024-02-29t12:00:00z]"), {
    x: "2024-02-29", y: ["2024-02-29", "2024-02-29t12:00:00z"],
  });
  rejects("x = 2024-02-29T23:59:60Z");
  rejects("x = 12:00:60");
  rejects("x = 0000-01-01");
  rejects("x = { a = 1, # comment\n}");
  rejects("x = { a = 1\n}");
  assert.throws(() => parse("# valid\r\nx = { a = 1, }", "manifest.toml"), (error) => {
    assert.equal(error.line, 2);
    assert.equal(error.path, "manifest.toml");
    assert.equal(error.code, CODES.YAML_PARSE);
    return true;
  });
});
