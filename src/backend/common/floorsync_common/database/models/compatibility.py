from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import ForeignKey, Integer, Numeric, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from floorsync_common.database.models.machine import Machine
    from floorsync_common.database.models.operation import Operation


class Compatibility(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Which machines can run which operations, and what it costs when they do.

    duration is occupancy time in minutes, including any required cooldown -- not pure processing
    time -- since occupancy is what actually blocks the next operation on the same machine.

    A break never blocks the machine here, at any level -- a machine's login is tied to the
    machine, not a specific person ("each machine has its own login"), so relief coverage during a
    break is just someone else using the same login. The only thing that ever makes a machine
    unschedulable is Unavailability (genuinely broken or reserved). See docs/database-schema.md.
    """

    __tablename__ = "compatibilities"
    __table_args__ = (UniqueConstraint("operation_id", "machine_id"),)

    operation_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("operations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    machine_id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("machines.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    duration: Mapped[int] = mapped_column(Integer, nullable=False)
    energy: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)

    operation: Mapped[Operation] = relationship()
    machine: Mapped[Machine] = relationship()
