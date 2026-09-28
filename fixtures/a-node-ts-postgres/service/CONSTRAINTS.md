# Constraints

- Every order mutation must be idempotent on `Idempotency-Key`.
  - Reason: clients retry on timeout.
  - Checked by: `pnpm --filter @orders/service test`
- Money is stored in integer cents; never floating point.
  - Reason: rounding is a support incident.
  - Checked by: `pnpm --filter @orders/service test`
