# Constraints

- The gateway never writes to the ledger directly; it calls the ingest service.
  - Reason: one writer per aggregate.
  - Checked by: `go test ./...`
