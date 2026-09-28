// Explicit warning dispositions.
//
// An accepted warning is not an ignored warning. It carries a typed identity, a
// classification, a reason, a review condition, the exact observed refs it was
// written against, and content hashes of the evidence. If the evidence changes,
// the acceptance stops matching and compilation fails: a review is forced, not
// inherited. Acceptance can never downgrade an error.
import { AgentDocError, CODES, ACCEPTABLE_WARNING_CODES } from "./codes.mjs";
import { assertRepoPath, sha256Hex } from "./fsx.mjs";
import { scanForSecrets } from "./secrets.mjs";
import { CONFIG_PATH } from "./descriptors.mjs";

export function applyWarningAcceptances(repo, acceptances, diagnostics) {
  const errors = [];
  const seen = new Set();
  for (const acceptance of acceptances) {
    try {
      const { code, subject, observedRefs, evidence } = acceptance;
      if (!ACCEPTABLE_WARNING_CODES.includes(code)) {
        throw new AgentDocError(
          CODES.WARNING_ACCEPTANCE,
          "warning code " + code + " is not acceptable; only " + ACCEPTABLE_WARNING_CODES.join(", ") + " may be accepted",
          { path: CONFIG_PATH }
        );
      }
      const key = code + "|" + subject;
      if (seen.has(key)) throw new AgentDocError(CODES.WARNING_ACCEPTANCE, "duplicate warning acceptance for " + key, { path: CONFIG_PATH });
      seen.add(key);
      scanForSecrets(acceptance, CONFIG_PATH);

      const matches = diagnostics.filter((d) => d.code === code && d.subject === subject);
      if (matches.length !== 1 || matches[0].severity !== "warning") {
        throw new AgentDocError(
          CODES.WARNING_ACCEPTANCE,
          "warning acceptance must match exactly one current warning: " + key + " — remove it or review the underlying fact",
          { path: CONFIG_PATH }
        );
      }
      const diagnostic = matches[0];
      if (JSON.stringify([...observedRefs].sort()) !== JSON.stringify([...(diagnostic.refs || [])].sort())) {
        throw new AgentDocError(
          CODES.WARNING_ACCEPTANCE,
          "observed refs changed for " + key + " — re-review the current consumers or component",
          { path: CONFIG_PATH }
        );
      }
      const paths = new Set();
      for (const item of evidence) {
        assertRepoPath(item.path, CONFIG_PATH);
        if (paths.has(item.path)) {
          throw new AgentDocError(CODES.WARNING_ACCEPTANCE, "duplicate acceptance evidence path: " + item.path, { path: CONFIG_PATH });
        }
        paths.add(item.path);
        if (sha256Hex(repo.readBytes(item.path)) !== item.sha256) {
          throw new AgentDocError(
            CODES.WARNING_ACCEPTANCE,
            "warning acceptance evidence changed: " + item.path + " — review the disposition before updating its digest",
            { path: CONFIG_PATH }
          );
        }
      }
      diagnostic.acceptance = acceptance;
    } catch (e) {
      if (!(e instanceof AgentDocError)) throw e;
      errors.push(e);
    }
  }
  return errors;
}
