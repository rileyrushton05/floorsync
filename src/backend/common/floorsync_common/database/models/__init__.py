"""ORM models and reusable model conventions.

Import every concrete model module here so Alembic can discover its metadata.
"""

from floorsync_common.database.models.category import Category
from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.dependency import Dependency
from floorsync_common.database.models.job import Job
from floorsync_common.database.models.live_update_outbox import LiveUpdateOutbox
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin
from floorsync_common.database.models.operation import Operation
from floorsync_common.database.models.schedule import Schedule
from floorsync_common.database.models.schedule_dependency import ScheduleDependency
from floorsync_common.database.models.schedule_entry import ScheduleEntry
from floorsync_common.database.models.schedule_job_selection import ScheduleJobSelection
from floorsync_common.database.models.simulation import Simulation
from floorsync_common.database.models.simulation_event import SimulationEvent
from floorsync_common.database.models.unavailability import Unavailability
from floorsync_common.database.models.user import User
from floorsync_common.database.models.user_credential import UserCredential

__all__ = [
    "Category",
    "Compatibility",
    "Dependency",
    "Job",
    "LiveUpdateOutbox",
    "Machine",
    "Operation",
    "Schedule",
    "ScheduleDependency",
    "ScheduleEntry",
    "ScheduleJobSelection",
    "Simulation",
    "SimulationEvent",
    "TimestampMixin",
    "UUIDPrimaryKeyMixin",
    "Unavailability",
    "User",
    "UserCredential",
]
