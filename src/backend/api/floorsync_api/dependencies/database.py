from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from floorsync_common.database.session import session_factory


async def get_db_session() -> AsyncIterator[AsyncSession]:
    """Provide one SQLAlchemy session per API request."""

    async with session_factory() as session:
        yield session


DbSession = Annotated[AsyncSession, Depends(get_db_session)]
