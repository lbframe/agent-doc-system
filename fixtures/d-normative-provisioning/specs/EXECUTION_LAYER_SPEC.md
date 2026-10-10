# Execution layer specification

## 1. Scope

This specification governs how agent work is executed on the production host.

## 12. Sandboxing

Each run executes in an isolated sandbox with no network access by default.

## 13. Host configuration

The inventory selects the full validation environment; its configuration is
reproduced on the production host. Host configuration is declarative and
idempotent and is applied with Ansible.
