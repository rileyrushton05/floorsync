"""Derive a timeline from FloorSync's own schedule rows.

A FloorSync schedule already carries everything the resolution needs, so this
adapter is a translation rather than a derivation:

* ``schedule_entries`` supply the nodes, including the ``duration`` snapshotted
  from Compatibility at generation time;
* ``schedule_dependencies`` supply the edges, already labelled ``job_order`` or
  ``machine_queue``.

The adapter deliberately accepts plain records rather than ORM instances. A
timeline can then be resolved and tested without a database session, and the
query that loads a schedule stays a named, intention-revealing read in the
service layer -- ``load_schedule_inputs()`` -- as decision 0005 prefers.
"""

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from uuid import UUID

from .errors import ScheduleMismatchError
from .graph import PrecedenceEdge, PrecedenceReason, TimelineNode
from .timeline import Timeline


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
    """

    entry_id: UUID
    job_id: UUID
    machine_id: UUID
    duration: int
    job_name: str
    machine_name: str
    operation_name: str


@dataclass(frozen=True, slots=True)
class ScheduleDependencyRecord:
    """One ``schedule_dependencies`` row.

    Attributes:
        entry_id: The entry that must wait.
        depends_on_entry_id: The entry it waits for.
        reason: Why it waits, matching the stored check-constrained value.
    """

    entry_id: UUID
    depends_on_entry_id: UUID
    reason: PrecedenceReason


class FloorSyncScheduleAdapter:
    """Translate FloorSync schedule rows into a resolvable timeline. Stateless."""

    @staticmethod
    def build_timeline(
        entries: Sequence[ScheduleEntryRecord],
        dependencies: Iterable[ScheduleDependencyRecord],
    ) -> Timeline:
        """Resolve start and end times for every entry in a schedule.

        Args:
            entries: Every ``schedule_entries`` row of one schedule.
            dependencies: Every ``schedule_dependencies`` row of that schedule.

        Returns:
            A timeline with every entry placed on the clock.

        Raises:
            ScheduleMismatchError: If a dependency names an entry that is not in
                ``entries``, which means the two were loaded from different
                schedules or the dependency cache is stale.
            CyclicScheduleError: If the dependencies imply a deadlock.
        """
        nodes = FloorSyncScheduleAdapter.to_nodes(entries)
        edges = FloorSyncScheduleAdapter.to_edges(dependencies, {node.key for node in nodes})
        return Timeline.from_graph(nodes, edges)

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
    def to_edges(
        dependencies: Iterable[ScheduleDependencyRecord], known_keys: set[str]
    ) -> list[PrecedenceEdge]:
        """Translate schedule dependencies into precedence edges.

        Raises:
            ScheduleMismatchError: If a dependency names an entry outside
                ``known_keys``.
        """
        edges: list[PrecedenceEdge] = []
        for dependency in dependencies:
            before = str(dependency.depends_on_entry_id)
            after = str(dependency.entry_id)
            if before not in known_keys or after not in known_keys:
                missing = before if before not in known_keys else after
                raise ScheduleMismatchError(
                    f"Schedule dependency references entry {missing}, which is not part of the "
                    f"loaded schedule. The dependency cache may be stale, or entries and "
                    f"dependencies were loaded from different schedules."
                )
            edges.append(PrecedenceEdge(before=before, after=after, reason=dependency.reason))
        return edges

    @staticmethod
    def entries_from_rows(
        rows: Iterable[tuple[UUID, UUID, UUID, int, str, str, str]],
    ) -> list[ScheduleEntryRecord]:
        """Build entry records from a query returning columns in declared order.

        The expected column order is ``entry_id, job_id, machine_id, duration,
        job_name, machine_name, operation_name`` -- the shape of the join a
        ``load_schedule_inputs()`` read produces.
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
            )
            for (
                entry_id,
                job_id,
                machine_id,
                duration,
                job_name,
                machine_name,
                operation_name,
            ) in rows
        ]

    @staticmethod
    def dependencies_from_rows(
        rows: Iterable[tuple[UUID, UUID, str]],
    ) -> list[ScheduleDependencyRecord]:
        """Build dependency records from ``entry_id, depends_on_entry_id, reason`` rows.

        Raises:
            ScheduleMismatchError: If a stored ``reason`` is not a known value.
        """
        records: list[ScheduleDependencyRecord] = []
        for entry_id, depends_on_entry_id, reason in rows:
            try:
                parsed = PrecedenceReason(reason)
            except ValueError as exc:
                raise ScheduleMismatchError(
                    f"Schedule dependency has unknown reason '{reason}'."
                ) from exc
            records.append(
                ScheduleDependencyRecord(
                    entry_id=entry_id,
                    depends_on_entry_id=depends_on_entry_id,
                    reason=parsed,
                )
            )
        return records

    @staticmethod
    def label_lookup(records: Mapping[UUID, str]) -> dict[str, str]:
        """Return a string-keyed view of a ``UUID`` to name mapping."""
        return {str(key): value for key, value in records.items()}
