# Constraints

- The scheduler may not contain a business rule.
  - Reason: a rule hidden in a trigger cannot be reviewed with its system.
  - Checked by: `agentdoc check`
- A trigger change requires a new runtime observation before merge.
  - Reason: the manifest states intent; only the scheduler states fact.
  - Checked by: `agentdoc check` fails when the observation is stale.
