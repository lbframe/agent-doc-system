// Fact store.
//
// Every claim that any evidence class makes about a (subject, key) pair lands
// here, whatever produced it. Keeping them in one place is what makes conflict
// detection uniform: a scheduled cron declared in a config file and a
// scheduled cron read out of a live scheduler are simply two facts on the same
// key, and the conflict engine has no way to accidentally treat one as the
// other.
import { assertFactKeyShape } from "./authority/facts.mjs";
import { AgentDocError, CODES } from "./codes.mjs";

export class FactStore {
  constructor() {
    this.facts = [];
    this.bySubjectKey = new Map();
  }
  add({
    subject, key, value, evidenceClass, confidence, provRecs, semantics,
    observed, review, source,
  }) {
    if (!assertFactKeyShape(key)) {
      // A malformed key is a compiler defect, not user input, so it surfaces as
      // a catalog error rather than an unhandled exception.
      throw new AgentDocError(CODES.CONFIG, "malformed fact key " + JSON.stringify(key) + " for subject " + subject);
    }
    const id = "a-" + String(this.facts.length + 1).padStart(4, "0");
    const fact = {
      id,
      subject,
      key,
      value,
      evidenceClass,
      confidence,
      status: "unresolved",
      provRecs: provRecs || [],
      semantics: semantics || null,
      observed: observed || null,
      review: review || null,
      source: source || null,
    };
    this.facts.push(fact);
    const gk = subject + "\u0000" + key;
    if (!this.bySubjectKey.has(gk)) this.bySubjectKey.set(gk, []);
    this.bySubjectKey.get(gk).push(fact);
    return fact;
  }
  groups() {
    return [...this.bySubjectKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  forSubject(subject) {
    return this.facts.filter((f) => f.subject === subject);
  }
}
