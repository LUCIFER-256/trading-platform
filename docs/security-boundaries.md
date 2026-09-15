# Security boundaries

- The API is the only future boundary for authenticated operator requests; the web application is untrusted.
- Authentication and authorization are separate. Sensitive action authorization must be enforced server-side and audited.
- Broker credentials must be server-side secrets, encrypted/managed outside source control, and unavailable to the web application and logs.
- Every future external input requires schema validation, size/rate controls, request identifiers, and audit context.
- Order idempotency is required before any order endpoint or worker submission exists.
- Provider callbacks/webhooks require source authentication and replay protection once a provider is selected.
- Phase 1 provides no network-facing server and no credential handling.
