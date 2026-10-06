from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin


class LiveUpdateOutbox(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One notification that must reach the live dashboards, written in the same transaction as
    the change it describes (#148).

    Redis pub/sub is fire-and-forget: a message published while Redis is down is simply gone. So
    the change and this row commit together, the API publishes the row straight after commit, and
    a relay retries any row still unpublished. If the transaction rolls back neither the change
    nor the row exists, so nothing can be announced that did not happen.

    `payload` is the versioned wire contract (`live_updates.contracts`), not a serialised model:
    it is what crosses Redis and what a client deduplicates on, so it must not change shape when a
    column does. It is the one JSONB column in the schema, justified because it is written once,
    never queried by field, and read back whole.

    `aggregate_id` is deliberately not a foreign key. The outbox is generic over topics, and the
    row is a record of a notification owed, not part of the simulation's own history; it outlives
    nothing and constrains nothing. The `(aggregate_id, sequence)` uniqueness is what matters: a
    simulation can never announce the same sequence twice.
    """

    __tablename__ = "live_update_outbox"
    __table_args__ = (
        UniqueConstraint("aggregate_id", "sequence"),
        CheckConstraint("topic IN ('simulation.changed')", name="topic_valid"),
        CheckConstraint("sequence > 0", name="sequence_positive"),
        CheckConstraint("attempt_count >= 0", name="attempt_count_non_negative"),
        # The relay's only read: the unpublished rows, oldest due first. Partial so the index
        # stays the size of the backlog rather than of the history.
        Index(
            "ix_live_update_outbox_unpublished",
            "next_attempt_at",
            "created_at",
            postgresql_where=text("published_at IS NULL"),
        ),
    )

    topic: Mapped[str] = mapped_column(Text, nullable=False)
    aggregate_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    sequence: Mapped[int] = mapped_column(BigInteger, nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempt_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
