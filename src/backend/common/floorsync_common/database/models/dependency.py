from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from floorsync_common.database.models.operation import Operation


class Dependency(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A fixed, process-level ordering: before_operation must finish before after_operation starts.

    Persists independently of any schedule -- it's the process fact a scheduler reads to know what
    to generate. Supports multiple predecessors per operation (fan-in) and cross-job edges (an
    assembly step depending on operations from more than one job) by design; see the ER diagram's
    worked example.
    """

    __tablename__ = "dependencies"
    __table_args__ = (
        UniqueConstraint("before_operation_id", "after_operation_id"),
        CheckConstraint("before_operation_id <> after_operation_id", name="not_self_referential"),
    )

    before_operation_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("operations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    after_operation_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("operations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    before_operation: Mapped[Operation] = relationship(foreign_keys=[before_operation_id])
    after_operation: Mapped[Operation] = relationship(foreign_keys=[after_operation_id])
