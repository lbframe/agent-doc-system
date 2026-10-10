# Python verifier profile

## Runtime root

The verifier runtime is an exact, root-owned, read-only installation at
`/var/lib/agent-platform-runtime/verification-python-v1`. It is an
independently pinned dependency closure and must not depend on a developer or
product virtual environment.

## Required contents

- a CPython ELF interpreter and its standard library;
- the installed distributions;
- shared/ELF dependencies;
- a native executor;
- a complete regular-file tree hash.
