# Architecture (stale)

The ingest worker receives telemetry and writes it to InfluxDB. A cron job runs
nightly to roll up aggregates.
