from sqlalchemy import Text
from sqlalchemy.orm import Mapped, mapped_column

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin


class Job(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A production job made up of one or more operations."""

    __tablename__ = "jobs"

    name: Mapped[str] = mapped_column(Text, nullable=False)
