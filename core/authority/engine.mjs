// Authority rules and conflict resolution.
//
// There is deliberately NO global precedence order. Authority depends on the
// fact: an OpenAPI file may be authoritative for the desired wire contract
// while a runtime observation is authoritative for what is deployed right now,
// and source code is authoritative for the behaviour shipped by a commit.
//
// A fact with an authority rule gets an election. A fact with NO matching rule
// and disagreeing evidence stays UNRESOLVED and raises a conflict. That is the
// fail-closed default: silence is not a resolution.
import { AgentDocError, CODES } from "../codes.mjs";
import { EVIDENCE_CLASSES, CONFIDENCE } from "./classes.mjs";

export class AuthorityEngine {
  constructor(rules) {
    this.rules = (rules || []).map((r) => {
      let re;
      try {
        re = new RegExp(r.keyPattern, "u");
      } catch {
        throw new AgentDocError(CODES.CONFIG, "authority rule " + r.id + " has an invalid keyPattern: " + r.keyPattern);
      }
      for (const c of r.elect) {
        if (!EVIDENCE_CLASSES.includes(c) || c === "UNRESOLVED") {
          throw new AgentDocError(CODES.CONFIG, "authority rule " + r.id + " cannot elect " + c);
        }
      }
      return { ...r, re };
    });
    for (let i = 0; i < this.rules.length; i++) {
      for (let j = i + 1; j < this.rules.length; j++) {
        if (this.rules[i].id === this.rules[j].id) {
          throw new AgentDocError(CODES.CONFIG, "duplicate authority rule id " + this.rules[i].id);
        }
      }
    }
  }
  // Returns the most specific matching rule (longest pattern wins) or null.
  ruleFor(subject, key) {
    const target = subject + " " + key;
    let best = null;
    for (const r of this.rules) {
      if (!r.re.test(target)) continue;
      if (!best || r.keyPattern.length > best.keyPattern.length) best = r;
    }
    return best;
  }
}

// Group assertions by (subject, key) and elect at most one per group.
//
// Election basis, in the order it is attempted — and each basis is only
// reachable when a rule explicitly allows it:
//   reviewed-override  an explicit human interpretation exists
//   authority-rule     the rule's elect list contains exactly one class present
//   superset           the elected value strictly contains the others
//   recency            the newest runtime observation, and only if the rule says so
//   none               fail closed
export function resolveAssertions(assertions, authority) {
  const groups = new Map();
  for (const a of assertions) {
    // An assertion a later observation supersedes stays in the graph as
    // history but does not compete here: it cannot win an election and cannot
    // anchor a conflict.
    if (a.status === "superseded") continue;
    const gk = a.subject + "\u0000" + a.key;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(a);
  }

  const conflicts = [];
  const elections = [];

  for (const [gk, list] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const [subject, key] = gk.split("\u0000");
    const distinct = distinctValues(list);

    if (distinct.length === 1) {
      // Agreement across evidence classes is corroboration, not a conflict —
      // but a lone heuristic candidate is not agreement with anything. It stays
      // UNRESOLVED and never becomes an elected fact.
      const allCandidate = list.every((a) => a.confidence === "candidate");
      for (const a of list) a.status = allCandidate ? "candidate" : "elected";
      const rule = authority.ruleFor(subject, key);
      elections.push({ subject, key, ruleId: rule ? rule.id : "agreement", basis: "authority-rule", elected: list[0] });
      if (allCandidate) {
        conflicts.push({
          subject,
          key,
          kind: "ambiguity",
          status: "unresolved",
          assertionIds: list.map((a) => a.id).sort(),
          election: {
            elected: null,
            basis: "none",
            ruleId: rule ? rule.id : "no-rule",
            rationale: "only heuristic candidates exist for '" + key + "'; deterministic discovery cannot resolve it",
            reviewWhen: rule ? rule.reviewWhen : null,
            contradicted: [],
          },
        });
      }
      continue;
    }

    const rule = authority.ruleFor(subject, key);
    const candidates = list.filter((a) => a.confidence !== "candidate");
    const candidateOnly = list.length !== candidates.length;

    // `reviewWhen` travels with the election so a consumer can report when this
    // decision must be re-examined. A null here means "no rule governs it", which
    // is a real state — and one that must never be rendered as if a condition
    // existed.
    const election = {
      elected: null,
      basis: "none",
      ruleId: rule ? rule.id : "no-rule",
      rationale: null,
      reviewWhen: rule ? rule.reviewWhen : null,
      contradicted: [],
    };
    let status = "unresolved";

    // 1. reviewed override wins outright, but the divergence is still recorded.
    const reviewed = candidates.filter((a) => a.evidenceClass === "REVIEWED_OVERRIDE");
    if (rule && rule.elect.length === 1 && rule.elect[0] === "REVIEWED_OVERRIDE" && reviewed.length === 1) {
      election.elected = reviewed[0];
      election.basis = "reviewed-override";
      election.rationale = rule.rationale;
      status = "accepted";
    }

    // 2. authority rule with a single elected class present among candidates.
    if (!election.elected && rule) {
      const allowed = rule.elect.filter((c) => candidates.some((a) => a.evidenceClass === c));
      if (allowed.length === 1) {
        const winners = candidates.filter((a) => a.evidenceClass === allowed[0]);
        if (winners.length === 1) {
          election.elected = winners[0];
          election.basis = "authority-rule";
          election.rationale = rule.rationale;
          status = "resolved";
        } else if (winners.length > 1) {
          election.rationale = "multiple same-class assertions disagree; no election";
        }
      } else if (allowed.length > 1) {
        election.rationale = "authority rule " + rule.id + " elects several classes that are all present; no deterministic election";
      }
    }

    // 3. superset: one candidate's value contains every other candidate's value.
    if (!election.elected && candidates.length > 1) {
      const sup = candidates.find((c) => candidates.every((o) => o === c || containsValue(c.value, o.value)));
      if (sup) {
        election.elected = sup;
        election.basis = "superset";
        election.rationale = "one observed value strictly contains the others";
        status = "resolved";
      }
    }

    // 4. recency: only when the rule names recency and the winner is a runtime fact.
    if (!election.elected && rule && rule.elect.includes("OBSERVED_RUNTIME")) {
      const runtime = candidates.filter((a) => a.evidenceClass === "OBSERVED_RUNTIME");
      const dated = runtime.filter((a) => a.observed && a.observed.at);
      if (dated.length > 1) {
        const newest = dated.sort((a, b) => (a.observed.at < b.observed.at ? -1 : 1)).pop();
        election.elected = newest;
        election.basis = "recency";
        election.rationale = "newest runtime observation, per authority rule " + rule.id;
        status = "resolved";
      }
    }

    if (!election.elected) {
      election.rationale = election.rationale || (
        rule
          ? "authority rule " + rule.id + " does not resolve this disagreement"
          : "no authority rule governs '" + key + "' for " + subject + "; fail closed"
      );
    }

    for (const a of list) {
      if (a === election.elected) a.status = "elected";
      else if (a.confidence === "candidate") a.status = "candidate";
      else a.status = "contradicted";
    }
    election.contradicted = list.filter((a) => a !== election.elected && a.confidence !== "candidate").map((a) => a.id);

    const kind = classifyConflict(list, election, candidateOnly);
    conflicts.push({
      subject,
      key,
      kind,
      status,
      assertionIds: list.map((a) => a.id).sort(),
      election,
    });
    elections.push({ subject, key, ruleId: election.ruleId, basis: election.basis, elected: election.elected });
  }

  return { conflicts, elections };
}

function classifyConflict(list, election, candidateOnly) {
  const classes = new Set(list.map((a) => a.evidenceClass));
  if (election.basis === "reviewed-override") return "reviewed-divergence";
  // An observation that declares itself superseded no longer competes: a newer
  // capture of the same authority system replaces it outright.
  if (list.some((a) => a.observed && a.observed.supersedes)) return "supersession";
  if (classes.has("OBSERVED_RUNTIME") && classes.has("AUTHORED")) return "contradiction";
  if (classes.has("OBSERVED_RUNTIME") && classes.size === 1) return "staleness";
  if (candidateOnly) return "ambiguity";
  if (classes.size > 1) return "contradiction";
  return "ambiguity";
}

export function distinctValues(list) {
  const seen = new Map();
  for (const a of list) {
    const k = stable(a.value);
    if (!seen.has(k)) seen.set(k, a.value);
  }
  return [...seen.values()];
}

function containsValue(big, small) {
  if (Array.isArray(big) && Array.isArray(small)) {
    return small.every((s) => big.some((b) => stable(b) === stable(s))) && big.length > small.length;
  }
  return false;
}

export function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}

export function assertConfidence(c) {
  if (!CONFIDENCE.includes(c)) throw new Error("unknown confidence " + c);
  return c;
}
