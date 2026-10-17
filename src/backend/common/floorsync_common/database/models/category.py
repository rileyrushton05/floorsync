from sqlalchemy import Index, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from floorsync_common.database.base import Base
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin


class Category(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A grouping of machines that perform similar work (cutting, polishing, ...)."""

    __tablename__ = "categories"

    name: Mapped[str] = mapped_column(Text, nullable=False)


# Unique ignoring case: to a manager, "Cutting" and "cutting" are one category.
Index("uq_categories_lower_name", func.lower(Category.name), unique=True)
