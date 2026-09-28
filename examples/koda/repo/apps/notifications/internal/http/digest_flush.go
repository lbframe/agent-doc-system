package http

// DigestFlush is the endpoint the platform scheduler triggers hourly, gated to
// hour 3. The route literal is what lets the catalog resolve the declared
// trigger target to this component.
const DigestFlushRoute = "/api/internal/notifications/digest-flush"

func DigestFlush() error { return nil }
