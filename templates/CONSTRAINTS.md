# Constraints

Repository-wide rules that an agent must not violate. Anything that is *not*
repository-wide belongs in the owning component's `CONSTRAINTS.md`, which the
graph routes to automatically.

## Rule format
One rule, one imperative sentence, one reason. A rule that cannot be checked by
reading code or running a command belongs in an ADR, not here.

## Rules
- <!-- rule -->
  - Reason: <!-- why -->
  - Checked by: <!-- command or test that proves it -->

## Changing a rule
A rule change is an ADR. Record why the old rule stopped being true.
