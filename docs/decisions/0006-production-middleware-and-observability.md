# Decision: Production middleware and observability baseline

## Date

2026-09-02

## Status

Accepted

## Context

The API currently enables permissive development CORS for one local origin and exposes a process
health endpoint. It does not yet correlate logs across a request, emit structured request completion
events, distinguish liveness from dependency readiness, constrain trusted hosts, or document which
protections belong at the application versus its deployment edge.

FloorSync will also execute asynchronous Celery tasks. Production diagnosis requires an operation to
be traceable from the initiating HTTP request into its task without logging request bodies, secrets,
or personally identifiable information.

Middleware is useful only for concerns that apply uniformly to nearly every request. Authentication,
authorization, business audit events, and expected-outcome mapping require route or domain context and
should not be reduced to generic middleware behaviour.

## Decision

### Application middleware

1. Implement one pure ASGI `RequestContextMiddleware`; do not base it on `BaseHTTPMiddleware`.
2. Assign each HTTP request a UUID request ID, store it in a `ContextVar`, return it in the
   `X-Request-ID` response header, and include it on all logs emitted during the request. An incoming
   request ID may be retained only when it is syntactically valid and the deployment is configured to
   trust the component that supplied it. Request IDs are correlation values, never credentials.
3. Emit one structured request-completion event containing, at minimum:
   - timestamp, severity, event name, service, and deployment environment;
   - request ID, method, route template, status code, and duration;
   - trace ID when tracing is enabled.
4. Log the route template such as `/api/v1/users/{user_id}`, not the concrete path, in metrics and
   aggregate logs. Never use user IDs, request IDs, emails, or concrete paths as metric labels.
5. Do not log request or response bodies, authorization headers, cookies, query strings, database
   URLs, secrets, or raw validation input. Domain audit events are separate explicit application
   events with their own retention and access policy.
6. Configure Python, Uvicorn, and Celery logging through one application-owned configuration. Emit
   newline-delimited structured JSON to stdout/stderr in deployed environments and human-readable
   logs locally. Avoid duplicate access and exception logs.
7. Use `TrustedHostMiddleware` in deployed environments with an explicit host allowlist.
8. Configure CORS from an environment-specific allowlist. Production origins, methods, exposed
   headers, and credential use must be explicit; wildcard credentials are prohibited. CORS should
   wrap the whole application when browsers must receive CORS headers on error responses.
9. Add a request-body limit as defence in depth. The public ingress remains the primary enforcement
   point so oversized bodies are rejected before consuming application resources.
10. Add a sanitized catch-all 500 Problem Details response. Unexpected exceptions are logged once at
    the exception boundary with their request ID; internal exception text and stack traces are never
    returned to clients.

### Concerns kept out of generic middleware

1. Authentication and role checks use FastAPI dependencies so routes can declare their requirements
   and OpenAPI can describe them.
2. Concrete `ExpectedOutcome` to HTTP mappings live at the web edge. The marker base is never mapped
   to a generic error response.
3. Business audit events are emitted by application services after the relevant decision is known,
   not inferred from HTTP status codes.
4. Rate limiting is enforced by a shared ingress or distributed store, not by process-local counters
   that diverge across replicas.
5. TLS termination, HTTP compression, hard connection/body limits, and public security headers are
   primarily ingress responsibilities. HTTPS redirects belong at the ingress unless the application
   has correctly configured trusted proxy headers.

### Health and telemetry

1. Provide separate endpoints:
   - `GET /health/live`: process event loop is responsive; no external dependency calls;
   - `GET /health/ready`: required dependencies are reachable and the instance may receive traffic.
2. Readiness checks must be fast and bounded by short timeouts. A transient optional dependency does
   not make the API unready unless requests cannot be served without it.
3. Introduce OpenTelemetry-compatible trace propagation before work crosses the HTTP-to-Celery
   boundary. Propagate trace/correlation context in task headers, not task business arguments.
4. Add RED metrics for the API: request rate, error rate, and duration. Use route templates and small,
   bounded label sets.
5. Add worker metrics for queue delay, task runtime, success/failure/retry counts, and queue depth.
   Celery tasks must be idempotent before late acknowledgement or automatic retry is enabled.

### Deployment baseline

1. Production containers must not run Uvicorn with `--reload`, mount source code, or run as root.
2. Run one API process per container and scale containers by default. Multiple Uvicorn workers in one
   container are allowed only when the deployment platform does not provide replication and memory
   and database-pool sizing have been reviewed.
3. Terminate TLS at a reverse proxy or managed load balancer. Trust forwarded headers only from known
   proxy IPs or networks.
4. Run Alembic migrations as an explicit release step before new application instances receive
   traffic. Application startup must not mutate the schema.
5. Supply secrets through the deployment platform's secret mechanism, not images, source control, or
   ordinary loggable environment dumps.
6. Configure graceful shutdown, request timeouts, worker soft/hard time limits, bounded retries with
   backoff and jitter, and database pool sizes from measured concurrency.
7. Back up PostgreSQL and test restoration. Define retention for logs, task results, audit events, and
   production data.

## Recommended middleware order

The conceptual inbound order is:

```text
RequestContextMiddleware
└── global CORS wrapper
    └── Starlette ServerErrorMiddleware
        └── UnhandledExceptionMiddleware
            └── TrustedHostMiddleware
                └── RequestBodyLimitMiddleware
                    └── Starlette ExceptionMiddleware
                        └── router / endpoint
```

Exact construction must be tested because `add_middleware()` wrapping order and a global CORS wrapper
are not expressed identically. Tests must cover success, handled problems, validation failures,
unhandled exceptions, invalid hosts, oversized bodies, preflight requests, and WebSocket connections.

## Rationale

- Pure ASGI middleware preserves `ContextVar` propagation and works for streaming ASGI messages.
- One generated correlation value makes ordinary logs useful before a full tracing backend is added.
- JSON on stdout works with container log collection and avoids application-managed log files.
- Route templates prevent identifiers from creating unbounded metric cardinality.
- Keeping distributed controls at the ingress or shared store makes them correct when the API has
  multiple processes or replicas.
- Separating liveness and readiness prevents a database outage from causing an endless process
  restart loop while still removing an unhealthy instance from service.

## Alternatives considered

- **Function or `BaseHTTPMiddleware` request logging:** simpler to write, but Starlette documents
  limitations in `ContextVar` propagation; correlation context is a core requirement.
- **Rely only on Uvicorn access logs:** insufficient for application request IDs, concrete expected
  outcomes, Celery correlation, and a stable structured schema.
- **Log request and response bodies for debugging:** rejected because it creates material privacy,
  secret-leakage, storage, and performance risks.
- **In-process rate limiting:** rejected because counters are inconsistent across workers and are lost
  on restart.
- **Make readiness and liveness the same deep dependency check:** rejected because it can turn a
  dependency outage into restart churn.
- **Adopt a vendor-specific monitoring SDK first:** deferred in favour of an OpenTelemetry-compatible
  boundary and vendor-neutral structured logs.

## Consequences

- Logging and request-context code becomes shared API infrastructure, not feature code.
- Context must be cleared in a `finally` block to prevent leakage between reused event-loop tasks.
- Health-check request logs should be reduced or sampled to avoid noise.
- WebSockets need connection-level correlation and lifecycle logs; an HTTP completion event alone is
  not sufficient.
- Metrics and logs have different cardinality budgets: a request ID belongs in logs and traces, never
  in metric labels.
- Production deployment requires a separate server command or image target because the current API
  image runs Uvicorn with `--reload`.
- Ingress-platform, authentication-provider, and telemetry-backend selections remain follow-up
  decisions. They must conform to the boundaries in this record.

## Primary references

- [Starlette middleware and pure ASGI guidance](https://www.starlette.io/middleware/)
- [Python logging with `contextvars`](https://docs.python.org/3/howto/logging-cookbook.html#use-of-contextvars)
- [FastAPI deployment concepts](https://fastapi.tiangolo.com/deployment/concepts/)
- [FastAPI behind a proxy](https://fastapi.tiangolo.com/advanced/behind-a-proxy/)
- [Uvicorn settings](https://www.uvicorn.org/settings/)
- [OpenTelemetry Python instrumentation](https://opentelemetry.io/docs/languages/python/instrumentation/)
- [Prometheus instrumentation practices](https://prometheus.io/docs/practices/instrumentation/)
- [Celery task retries, acknowledgement, and idempotency](https://docs.celeryq.dev/en/stable/userguide/tasks.html)
