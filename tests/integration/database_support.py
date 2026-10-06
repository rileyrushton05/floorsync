"""Session helpers shared by every integration test that talks to the test database.

Kept out of any one feature's test module, so reorganising one feature's tests cannot break
another's collection. The database itself comes from the `database_url` fixture in `conftest.py`.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

type Sessions = async_sessionmaker[AsyncSession]


def run[T](database_url: str, test: Callable[[Sessions], Awaitable[T]]) -> T:
    """Run one test body with a session factory bound to the test database."""

    async def body() -> T:
        engine = create_async_engine(database_url, poolclass=NullPool)
        try:
            return await test(async_sessionmaker(engine, expire_on_commit=False, autobegin=False))
        finally:
            await engine.dispose()

    return asyncio.run(body())


@asynccontextmanager
async def transaction(sessions: Sessions) -> AsyncIterator[AsyncSession]:
    async with sessions() as db, db.begin():
        yield db
