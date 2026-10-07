import asyncio
from datetime import datetime
from uuid import UUID

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import InvalidRequestError
from sqlalchemy.orm import DeclarativeBase

from floorsync_common.database.base import Base
from floorsync_common.database.models import TimestampMixin, UUIDPrimaryKeyMixin
from floorsync_common.database.session import session_factory, session_scope


class ConventionBase(DeclarativeBase):
    pass


class ConventionExample(UUIDPrimaryKeyMixin, TimestampMixin, ConventionBase):
    __tablename__ = "convention_example"


def test_database_access_requires_an_explicit_transaction() -> None:
    async def exercise_session() -> None:
        async with session_factory() as session:
            with pytest.raises(InvalidRequestError):
                await session.execute(text("SELECT 1"))

    asyncio.run(exercise_session())


def test_async_session_scope_starts_a_transaction() -> None:
    async def exercise_scope() -> None:
        async with session_scope() as session:
            assert session.in_transaction()

    asyncio.run(exercise_scope())


def test_model_mixins_define_uuid_and_timezone_aware_timestamps() -> None:
    mapper = inspect(ConventionExample)

    assert mapper.columns.id.primary_key
    assert mapper.columns.id.type.python_type is UUID
    assert mapper.columns.created_at.type.python_type is datetime
    assert mapper.columns.created_at.type.timezone is True
    assert mapper.columns.updated_at.type.timezone is True


def test_every_model_fetches_database_computed_timestamps_on_update() -> None:
    # Without eager defaults an UPDATE expires `updated_at`, and reading it afterwards needs a lazy
    # reload that async SQLAlchemy cannot do (MissingGreenlet, a 500). A model that defines its own
    # `__mapper_args__` would silently drop the mixin's, which is what this catches.
    mappers = [
        mapper
        for mapper in Base.registry.mappers
        if "updated_at" in mapper.columns and mapper.columns.updated_at.onupdate is not None
    ]

    assert mappers
    assert [m.class_.__name__ for m in mappers if m.eager_defaults is not True] == []
