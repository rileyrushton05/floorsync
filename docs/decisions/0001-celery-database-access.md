# Decision: Process-local Celery database access

## Date

2026-08-20

## Status

Accepted

## Context

The API uses SQLAlchemy's asynchronous driver, while Celery's default worker pool executes synchronous
tasks in forked child processes. Reusing the API engine would mix event-loop and process ownership.
Database connections and pools must not cross process boundaries, and tasks need an unambiguous
commit and rollback boundary.

## Decision

1. Celery tasks remain synchronous and use `psycopg` through `worker_session_scope()`.
2. Celery creates a synchronous engine and pool in each child process on `worker_process_init` and
   disposes it on `worker_process_shutdown`. The scope lazily initializes as a safe fallback for solo
   or test execution.
3. Each call to `worker_session_scope()` is one atomic task-level unit of work: success commits and an
   exception rolls back before retry or failure handling.
4. Each prefork child has a one-connection pool with no overflow because it executes one task at a
   time. Deployments provide `DATABASE_SYNC_URL` explicitly when psycopg needs driver-specific
   connection or TLS options.

```python
@celery_app.task
def process_floor_plan(floor_plan_id: UUID) -> None:
    with worker_session_scope() as session:
        floor_plan = session.get(FloorPlan, floor_plan_id)
        # Perform database work without committing inside helpers.
```

## Rationale

- A task can coordinate multiple repository calls atomically because inner helpers do not commit.
- Synchronous SQLAlchemy fits Celery's standard prefork execution model without creating and tearing
  down asyncio event loops per task.
- A pool created in each child process follows SQLAlchemy's multiprocessing safety guidance and keeps
  database connections out of the fork boundary.

## Alternatives considered

- **Reuse FastAPI's async engine in Celery:** rejected because prefork workers and repeated event loops
  make connection ownership unsafe and difficult to reason about.
- **Disable worker pooling with `NullPool`:** viable for very low task volume, but process-local pooling
  is more efficient and remains safe when lifecycle signals are observed.

## Consequences

- Celery tasks must call `worker_session_scope()` and must never receive a session as a task argument.
- Task retries must be idempotent. External calls should not occur while holding a database
  transaction; if unavoidable, timeout and retry behaviour must be designed explicitly.
- Coordinating a committed database change with event publication will eventually require an outbox
  or equivalent durable messaging pattern.
- API code uses `asyncpg`; worker code uses the synchronous `psycopg` driver.
- Alternative Celery pool types such as threads, gevent, or eventlet require a new connection-pool
  sizing and concurrency review; this decision targets Celery's default prefork pool.

## Primary references

- [SQLAlchemy: engines and multiprocessing](https://docs.sqlalchemy.org/en/20/core/connections.html#engine-disposal)
- [Celery worker lifecycle signals](https://docs.celeryq.dev/en/stable/userguide/signals.html#worker-signals)
