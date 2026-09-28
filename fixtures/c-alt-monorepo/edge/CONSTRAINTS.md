# Constraints

- The edge worker must not read the telemetry database directly.
  - Reason: the database sits behind the ingest service boundary.
  - Checked by: `agentdoc check`
