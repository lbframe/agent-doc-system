# Verification layer specification

## 1. Scope

This specification governs deterministic verification of agent output.

## 2. Verifier isolation

Deterministic verifiers run in a separate sandbox. The verifier executable
code, its configuration, its tests, its transitive dependencies and their
resolution environment are mandatory inputs of every verification.
