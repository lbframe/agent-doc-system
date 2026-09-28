# 0001. The scheduler owns no business logic

## Status
accepted

## Context
Scheduled work was implemented inside the triggering service, which made the
schedule and the business rule inseparable and impossible to observe
independently.

## Decision
The scheduler component triggers endpoints and nothing else. Business rules
live in the endpoint's own system.

## Consequences
The schedule becomes an independently observable fact, which is what makes a
manifest-versus-runtime divergence detectable at all.
