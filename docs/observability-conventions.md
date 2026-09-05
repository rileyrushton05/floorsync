# Observability and middleware conventions

These rules apply to the FastAPI service, Celery workers, and production deployment boundary. They
define the operational baseline established by decision 0006.

## Middleware scope

Middleware must be limited to concerns that apply uniformly to nearly every request:

- request correlation and completion logging;
- trusted-host validation;
- CORS response policy;
- request-body limits; and
- sanitizing unexpected HTTP failures.

The following must not be implemented as generic middleware:

- feature authorization rules;
- concrete `ExpectedOutcome` handling;
- business audit events;
- process-local rate limiting; or
- business validation.

Authentication and authorization should use FastAPI dependencies. Business audit events belong in
application services, where the actor and domain decision are known.

## Request correlation

- Every HTTP response must include `X-Request-ID`.
- The API generates a UUID request ID unless a syntactically valid ID comes from a configured trusted
  upstream.
- Request IDs are correlation values and must never be used for authentication, authorization,
  idempotency, or ownership decisions.
- The request context must use `ContextVar` and must be reset in a `finally` block.
- Custom request-context middleware must use the pure ASGI interface rather than
  `BaseHTTPMiddleware`.
- Request context must wrap global CORS so preflight and other CORS-generated responses also receive
  correlation IDs and completion logs.
- When HTTP work creates a Celery task, correlation and trace context belongs in task headers rather
  than business arguments.

## Logging

Deployed processes must emit newline-delimited structured JSON to stdout or stderr. Local development
may use the human-readable formatter.

The canonical request completion event is `http_request_completed` and includes:

```text
timestamp, level, logger, message, event, service, environment,
request_id, method, route, status_code, duration_ms
```

- Log route templates such as `/api/v1/users/{user_id}`, not concrete identifier-bearing paths, for
  aggregate request events.
- Do not log request or response bodies, authorization headers, cookies, query strings, secrets,
  database URLs, or raw validation inputs.
- Exception details must be logged at the exception boundary but never returned to clients.
- Avoid duplicate Uvicorn access logs when application request completion logging is enabled.
- Health-check completion logs should use `DEBUG` or be sampled.
- Logging a concrete expected outcome and choosing its severity must be explicit. The
  `ExpectedOutcome` base must not have a generic error-logging rule.
- Audit logs are separate domain events with an explicit actor, action, target, result, retention
  policy, and access policy.

## Metrics and tracing

- API monitoring should expose request rate, error rate, and duration.
- Worker monitoring should expose queue delay, task duration, success, failure, retry, and queue
  depth.
- Metric labels must use bounded values such as route template, method, and status class.
- Request IDs, user IDs, entity IDs, emails, concrete paths, and exception messages must not be metric
  labels.
- New cross-process work must support OpenTelemetry-compatible propagation even if no telemetry
  backend is configured yet.

## Transport security

- Production CORS origins, methods, and headers must be explicit configuration.
- `allow_credentials=True` must not be combined with wildcard origins, methods, or headers.
- Production hosts must be allowlisted.
- Public ingress is responsible for TLS termination, HTTP compression, hard body and connection
  limits, and distributed rate limiting.
- Forwarded headers must only be trusted from known proxy IP addresses or networks.
- Application request-body limiting remains enabled as defence in depth.
- Unexpected HTTP failures must return sanitized RFC 9457 Problem Details.

## Health endpoints

- `/health/live` must be shallow and must not contact external dependencies.
- `/health/ready` must check dependencies required to serve traffic with short, bounded timeouts.
- Optional dependency failure must not make the API unready unless normal requests cannot be served.
- The legacy `/health` endpoint remains temporarily for local tooling and compatibility.

## Celery operations

- A task must be idempotent before late acknowledgement or automatic retry is enabled.
- Retry only known transient failures.
- Retries must be bounded and use backoff and jitter.
- External calls must have explicit timeouts.
- Long-running tasks must have reviewed soft and hard time limits.
- Task logs must include the task ID and propagated request or trace correlation when available.

## Production checklist

- [ ] Uvicorn does not run with `--reload` in the production image.
- [ ] Containers do not run as root.
- [ ] CORS origins and trusted hosts are environment-specific.
- [ ] Secrets are supplied by the deployment platform and never logged.
- [ ] Proxy-header trust is restricted to the actual ingress.
- [ ] Liveness and readiness probes target the correct endpoints.
- [ ] Alembic runs as an explicit release step.
- [ ] Database pool sizing matches process and replica concurrency.
- [ ] Graceful shutdown and request/task timeouts are configured.
- [ ] PostgreSQL backup restoration has been tested.
- [ ] Log, audit, task-result, and production-data retention is defined.
- [ ] Alerts cover sustained errors, latency, readiness failure, and worker backlog.

## Governing decision

- [0006: production middleware and observability](decisions/0006-production-middleware-and-observability.md)
