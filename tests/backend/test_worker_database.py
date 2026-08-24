import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from floorsync_workers import database
from floorsync_workers.database import worker_database_url, worker_session_scope


def test_worker_uses_the_synchronous_postgresql_driver() -> None:
    url = worker_database_url()

    assert url.drivername == "postgresql+psycopg"
    assert url.database == "floorsync"


def test_worker_session_scope_commits_success_and_rolls_back_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE events (name TEXT NOT NULL)"))

    monkeypatch.setattr(database, "_engine", engine)
    monkeypatch.setattr(database, "_session_factory", sessionmaker(engine, autobegin=False))

    with worker_session_scope() as session:
        session.execute(text("INSERT INTO events (name) VALUES ('committed')"))

    with pytest.raises(RuntimeError, match="roll back"), worker_session_scope() as session:
        session.execute(text("INSERT INTO events (name) VALUES ('rolled back')"))
        raise RuntimeError("roll back")

    with engine.connect() as connection:
        names = connection.execute(text("SELECT name FROM events ORDER BY name")).scalars().all()

    assert names == ["committed"]
