"""Build a timeline from FloorSync's own schedule rows.

A FloorSync schedule already carries everything playback needs: ``schedule_entries`` supply the
work, including the ``duration`` snapshotted from Compatibility at generation time, and the
``start_time`` the scheduler resolved at generation time (see decision 0011). This adapter is a
translation, not a resolution -- unlike
:class:`~floorsync_common.simulation.builder.TimelineBuilder`, which still derives timing for
benchmark instances that carry no stored start time at all.

The adapter deliberately accepts plain records rather than ORM instances. A timeline can then be
built and tested without a database session, and the query that loads a schedule stays a named,
intention-revealing read in the service layer -- ``load_schedule_entries()`` -- as decision 0005
prefers.
"""

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from .errors import ScheduleMismatchError
from .graph import TimelineNode
from .timeline import ScheduledOperation, Timeline


@dataclass(frozen=True, slots=True)
class ScheduleEntryRecord:
    """One ``schedule_entries`` row with the names needed to display it.

    Attributes:
        entry_id: Primary key of the schedule entry.
        job_id: Job the assigned operation belongs to.
        machine_id: Machine the operation is assigned to.
        duration: Snapshotted processing time in minutes.
        job_name: Display name of the job.
        machine_name: Display name of the machine.
        operation_name: Display name of the operation.
        start_time: When the scheduler placed this operation, or ``None`` for a
            schedule generated before decision 0011 -- see
            :exc:`~floorsync_common.simulation.errors.ScheduleMismatchError`.
    """

    entry_id: UUID
    job_id: UUID
    machine_id: UUID
    duration: int
    job_name: str
    machine_name: str
    operation_name: str
    start_time: datetime | None


class FloorSyncScheduleAdapter:
    """Translate FloorSync schedule rows into a timeline. Stateless."""

    @staticmethod
    def build_timeline(entries: Sequence[ScheduleEntryRecord]) -> Timeline:
        """Place every entry in a schedule using the start time the scheduler already resolved.

        Args:
            entries: Every ``schedule_entries`` row of one schedule.

        Returns:
            A timeline with every entry placed on the clock.

        Raises:
            ScheduleMismatchError: If an entry has no stored ``start_time``, which means the
                schedule predates decision 0011 and must be regenerated before it can be
                simulated.
        """
        starts: dict[str, datetime] = {
            str(entry.entry_id): entry.start_time
            for entry in entries
            if entry.start_time is not None
        }
        if len(starts) != len(entries):
            missing = [entry.entry_id for entry in entries if entry.start_time is None]
            raise ScheduleMismatchError(
                f"{len(missing)} schedule entr{'y' if len(missing) == 1 else 'ies'} have no "
                f"stored start_time, so this schedule predates decision 0011 and cannot be "
                f"simulated. Regenerate it. First affected entry: {missing[0]}."
            )

        nodes = FloorSyncScheduleAdapter.to_nodes(entries)
        origin = min(starts.values())

        placed = []
        for node in nodes:
            start = round((starts[node.key] - origin).total_seconds() / 60)
            placed.append(
                ScheduledOperation(
                    node=node, start_time=start, end_time=start + node.duration, machine_slot=0
                )
            )
        return Timeline.from_operations(placed)

    @staticmethod
    def to_nodes(entries: Sequence[ScheduleEntryRecord]) -> list[TimelineNode]:
        """Translate schedule entries into timeline nodes."""
        return [
            TimelineNode(
                key=str(entry.entry_id),
                job_key=str(entry.job_id),
                machine_key=str(entry.machine_id),
                duration=entry.duration,
                job_label=entry.job_name,
                machine_label=entry.machine_name,
                operation_label=entry.operation_name,
            )
            for entry in entries
        ]

    @staticmethod
    def entries_from_rows(
        rows: Iterable[tuple[UUID, UUID, UUID, int, str, str, str, datetime | None]],
    ) -> list[ScheduleEntryRecord]:
        """Build entry records from a query returning columns in declared order.

        The expected column order is ``entry_id, job_id, machine_id, duration,
        job_name, machine_name, operation_name, start_time`` -- the shape of the
        join a ``load_schedule_entries()`` read produces.
        """
        return [
            ScheduleEntryRecord(
                entry_id=entry_id,
                job_id=job_id,
                machine_id=machine_id,
                duration=duration,
                job_name=job_name,
                machine_name=machine_name,
                operation_name=operation_name,
                start_time=start_time,
            )
            for (
                entry_id,
                job_id,
                machine_id,
                duration,
                job_name,
                machine_name,
                operation_name,
                start_time,
            ) in rows
        ]

    @staticmethod
    def label_lookup(records: Mapping[UUID, str]) -> dict[str, str]:
        """Return a string-keyed view of a ``UUID`` to name mapping."""
        return {str(key): value for key, value in records.items()}
