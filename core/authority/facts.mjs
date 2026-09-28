// Fact model.
//
// A "fact" is a claim about one (subject, key) pair. Multiple facts may exist
// for the same pair when different evidence classes disagree — that is a
// conflict, and it is surfaced, never reconciled silently.
//
// Well-known keys are namespaced by domain so an authority rule can be written
// per fact-kind rather than per project. See SPEC.md "Fact keys".
export const FACT_KEYS = Object.freeze({
  // what a scheduler actually runs
  "schedule.cron": "the cron expression a platform scheduler evaluates for this component's job",
  // what a binding actually points at
  "binding.kind": "the kind of platform resource a declared binding resolves to",
  "binding.target": "the concrete instance a declared binding resolves to",
  // what an external API actually accepts
  "contract.supports": "capabilities an external contract actually accepts",
  "contract.version": "the deployed version of a contract",
  // component shape
  "component.deployable": "whether the component ships as an independently deployable artifact",
  "component.importable": "whether the component ships as an independently importable library",
  "component.runtime": "the runtime the deployed artifact executes on",
  "component.language": "the implementation language of the component",
  // governance
  "placement.system": "the system a component is placed in",
  "placement.domain": "the domain a component or system is placed in",
  "resource.ownership": "which component owns a logical resource",
  "schedule.enabled": "whether a scheduled job is enabled in the scheduler",
  "schedule.target": "the endpoint a scheduled job invokes",
});

export function isKnownFactKey(key) {
  return Object.prototype.hasOwnProperty.call(FACT_KEYS, key);
}

export function knownFactKeys() {
  return Object.keys(FACT_KEYS);
}

export function assertFactKeyShape(key) {
  return typeof key === "string" && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(key) && key.length <= 80;
}
