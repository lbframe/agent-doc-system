// Secret material must never reach the compiled graph, a report, a log line,
// or a prompt. Two layers:
//
//  1. Source scanning — every authored/observed document is scanned before it
//     can influence any output.
//  2. Output scanning — the serialized graph, every report and every query
//     payload is scanned again, because derivations and extractor heuristics can
//     synthesize a secret-shaped string that no source scan would have caught.
import { AgentDocError, CODES } from "./codes.mjs";

const PATTERNS = [
  { re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/, why: "private key material" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, why: "AWS-style access key id" },
  { re: /\bASIA[0-9A-Z]{16}\b/, why: "AWS-style temporary access key id" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, why: "GitHub token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, why: "GitHub fine-grained token" },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, why: "Slack token" },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, why: "provider secret key" },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, why: "JWT-shaped token" },
  { re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/, why: "URL with embedded credentials" },
  {
    re: /\b(?:secret|password|passwd|passphrase|token|api[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)\b\s*[:=]\s*["']?[^\s"',;]{8,}/i,
    why: "credential assignment",
  },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/, why: "bearer token" },
  { re: /\b(?:curl|wget)\b[^\n]*\s-[a-z]*u\s+\S+:\S+/i, why: "inline credentials on a command line" },
  { re: /\bAuthorization\s*[:=]\s*["']?[^\s"']{8,}/i, why: "authorization header value" },
  { re: /\baws_secret_access_key\b\s+\S{16,}/i, why: "AWS secret access key" },
  { re: /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token)\b\s+["']?[A-Za-z0-9_\-]{16,}/i, why: "credential passed as an argument" },
];

function scanString(value, where) {
  // Values this system already redacted are not secrets. Removing the marker
  // before matching stops the output scanner from refusing to emit its own
  // redaction, which would make a redacted command unusable.
  const v = String(value).replace(/\[REDACTED[^\]]*\]/g, "");
  for (const { re, why } of PATTERNS) {
    if (re.test(v)) {
      throw new AgentDocError(CODES.SECRET, "secret-like value (" + why + ") at " + where + ": agentdoc sources and outputs must never contain credentials", {});
    }
  }
}

// Recursive scan of an in-memory document.
export function scanForSecrets(node, path, pointer = "") {
  if (node == null) return;
  if (typeof node === "string") return scanString(node, pointer || "/");
  if (typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => scanForSecrets(item, path, pointer + "/" + i));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    scanForSecrets(v, path, pointer + "/" + k.replace(/~/g, "~0").replace(/\//g, "~1"));
  }
}

// Scan serialized text (a graph, a report, a query payload). Throws on the
// first hit; the caller decides whether that is fatal.
export function assertNoSecretsInText(text, what) {
  const scrubbed = String(text).replace(/\[REDACTED[^\]]*\]/g, "");
  for (const { re, why } of PATTERNS) {
    const m = re.exec(scrubbed);
    if (m) {
      throw new AgentDocError(
        CODES.SECRET,
        "refusing to emit " + what + ": secret-like value (" + why + ") near offset " + m.index
      );
    }
  }
}

// Verification commands are a routing index, not a credential transport. Keep
// the runnable shape; strip any inline assignment or DSN password.
const SECRET_NAME = /(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE_?KEY|CREDENTIAL|ACCESS_?KEY)/i;

export function redactCommand(command) {
  return String(command)
    // Assignment form. The name is matched structurally and then tested, rather
    // than by a single backtracking pattern: "API_KEY" must be recognised as
    // an API key, which a greedy name group would swallow whole.
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)=([^\s;"'`]+)/g, (m, name, value) =>
      SECRET_NAME.test(name) ? name + "=[REDACTED]" : m)
    .replace(/\b((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp|https?):\/\/)[^:@/\s]+:[^@/\s]+@/gi,
      "$1[REDACTED]@")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g, "$1[REDACTED]")
    // `curl -u user:pass` and `<credential-name> <value>` as separate arguments.
    .replace(/(\s-[a-zA-Z]*u\s+)(\S+):(\S+)/g, "$1$2:[REDACTED]")
    .replace(/\b(aws_secret_access_key|aws_access_key_id)(\s+)([A-Za-z0-9/+=]{12,})/gi, "$1$2[REDACTED]")
    .replace(/\b(Authorization)(\s*[:=]\s*)(\S{8,})/gi, "$1$2[REDACTED]")
    .replace(/\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token)(\s+)(["']?)([A-Za-z0-9_-]{16,})/gi, "$1$2$3[REDACTED]");
}
