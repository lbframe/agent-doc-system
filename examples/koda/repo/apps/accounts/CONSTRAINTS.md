# Constraints

- Every service-to-service read of family data goes through the canonical
  accounts M2M contract.
  - Reason: family relationships have exactly one authority.
  - Checked by: `pnpm --filter @koda/accounts test`
- The OIDC token endpoint path is part of the public contract and may not change
  without a new ADR.
  - Reason: every Go service resolves it by literal path.
  - Checked by: `agentdoc validate`
