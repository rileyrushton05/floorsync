from __future__ import annotations

from typing import TYPE_CHECKING, Literal
from uuid import UUID

from sqlalchemy import CheckConstraint, ForeignKey, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from floorsync_common.database.models.operation import Operation

type DependencyOrigin = Literal["legacy", "builder_sequence"]


class Dependency(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A fixed, process-level ordering: before_operation must finish before after_operation starts.

    Persists independently of any schedule -- it's the process fact a scheduler reads to know what
    to generate. Supports multiple predecessors per operation (fan-in) and cross-job edges (an
    assembly step depending on operations from more than one job) by design; see the ER diagram's
    worked example.

    `origin` records who owns the row, so a job-definition save can rewrite its own edges without
    touching anyone else's. `builder_sequence` is an edge the definition service derived from two
    consecutive operation positions; it is deleted and re-derived on every save of that job.
    `legacy` is everything else -- a benchmark import, or an edge written through the ordering API
    -- and a definition save leaves those exactly as it found them. There is deliberately no
    job-level origin: jobs are independent, and precedence only ever joins operations.
    """

    __tablename__ = "dependencies"
    __table_args__ = (
        UniqueConstraint("before_operation_id", "after_operation_id"),
        CheckConstraint("before_operation_id <> after_operation_id", name="not_self_referential"),
        CheckConstraint("origin IN ('legacy', 'builder_sequence')", name="origin_valid"),
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
    origin: Mapped[DependencyOrigin] = mapped_column(Text, nullable=False, server_default="legacy")

    before_operation: Mapped[Operation] = relationship(foreign_keys=[before_operation_id])
    after_operation: Mapped[Operation] = relationship(foreign_keys=[after_operation_id])
