from collections.abc import Iterator
from contextlib import contextmanager
from os import getpid

from sqlalchemy import Engine, create_engine
from sqlalchemy.engine import URL, make_url
from sqlalchemy.orm import Session, sessionmaker

from floorsync_common.settings import settings

_engine: Engine | None = None
_engine_pid: int | None = None
_session_factory: sessionmaker[Session] | None = None


def worker_database_url() -> URL:
    """Use the same PostgreSQL database through Celery's synchronous driver."""

    if settings.database_sync_url is not None:
        return make_url(settings.database_sync_url)

    # Convenient local/test fallback. Deployments should set DATABASE_SYNC_URL
    # explicitly when driver-specific SSL or connection options are required.
    return make_url(settings.database_url).set(drivername="postgresql+psycopg")


def initialize_worker_database() -> None:
    """Create a connection pool owned by the current worker process."""

    global _engine, _engine_pid, _session_factory

    if _engine is not None:
        # A copied parent-process pool must be replaced without touching the
        # parent's connections. Reinitialization in the same process may close it.
        _engine.dispose(close=_engine_pid == getpid())
    _engine = create_engine(
        worker_database_url(),
        pool_pre_ping=True,
        pool_size=1,
        max_overflow=0,
    )
    _engine_pid = getpid()
    _session_factory = sessionmaker(
        _engine,
        expire_on_commit=False,
        autobegin=False,
    )


def dispose_worker_database() -> None:
    """Release the current worker process's connection pool."""

    global _engine, _engine_pid, _session_factory

    _session_factory = None
    if _engine is not None:
        _engine.dispose(close=_engine_pid == getpid())
        _engine = None
        _engine_pid = None


@contextmanager
def worker_session_scope() -> Iterator[Session]:
    """Commit one task-level transaction or roll it back on failure."""

    if _session_factory is None:
        initialize_worker_database()

    session_factory = _session_factory
    if session_factory is None:  # pragma: no cover - initialization invariant
        raise RuntimeError("Worker database session factory was not initialized")

    with session_factory.begin() as session:
        yield session
