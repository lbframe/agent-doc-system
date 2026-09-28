# Architecture

This file explains *why the shape is what it is*. It does not enumerate
components, contracts or data stores: `agentdoc query` returns those from the
compiled graph, and a hand-maintained list would be wrong within a week.

## How to read the system
- `agentdoc query <path>` for one component and its boundaries.
- `agentdoc impact <paths>` for what a change forces you to keep consistent.
- `agentdoc audit` for the current classification of every fact.

## Structural decisions
<!-- One entry per decision, each linking to the ADR that records it. -->

## Boundaries and why they exist
<!-- Which components may talk to which, and what enforces it. -->

## Deliberate non-relationships
<!-- Things that look like they should be coupled and are not. -->
