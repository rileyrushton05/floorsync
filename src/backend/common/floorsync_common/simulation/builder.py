"""Resolve a schedule's ordering into concrete start and end times.

The builder combines the two constraint sets that together pin every operation
to the clock:

* job precedence, from the instance: operation ``k + 1`` of a job cannot start
  before operation ``k`` of that job has finished;
* machine sequencing, from the schedule: a machine's next job cannot start
  before the previous one on that machine has finished.

Both are encoded as edges of a directed acyclic graph, and a topological longest
path over that graph gives the earliest feasible start for every operation. This
is the same reasoning the benchmark solvers use to validate a solution, kept here
as a reusable step that yields a full timeline rather than a single makespan.
"""

from collections import deque
from itertools import pairwise

from .errors import CyclicScheduleError, ScheduleMismatchError
from .instance import JobShopInstance
from .schedule import Schedule
from .timeline import ScheduledOperation, Timeline


class TimelineBuilder:
    """Turn an instance and a schedule into a timeline. Stateless."""

    @staticmethod
    def build(instance: JobShopInstance, schedule: Schedule) -> Timeline:
        """Resolve start and end times for every operation in the instance.

        Args:
            instance: The problem definition.
            schedule: A solver's machine sequences for that instance.

        Returns:
            A timeline with every operation placed on the clock.

        Raises:
            ScheduleMismatchError: If the schedule does not sequence exactly the
                operations the instance declares.
            CyclicScheduleError: If the two constraint sets imply a deadlock, so
                no feasible start times exist.
        """
        operations = instance.operations
        successors: list[list[int]] = [[] for _ in operations]
        in_degree = [0] * len(operations)

        for chain in TimelineBuilder._job_chains(instance):
            for earlier, later in pairwise(chain):
                successors[earlier].append(later)
                in_degree[later] += 1

        slots = TimelineBuilder._apply_machine_sequences(instance, schedule, successors, in_degree)
        starts = TimelineBuilder._longest_paths(instance, successors, in_degree)

        placed = [
            ScheduledOperation(
                operation=operation,
                start_time=starts[position],
                end_time=starts[position] + operation.duration,
                machine_slot=slots[position],
            )
            for position, operation in enumerate(operations)
        ]
        return Timeline.from_operations(placed)

    @staticmethod
    def _job_chains(instance: JobShopInstance) -> list[list[int]]:
        """Return each job's operation positions, in the order it must run them."""
        chains: dict[int, list[tuple[int, int]]] = {}
        for position, operation in enumerate(instance.operations):
            chains.setdefault(operation.job, []).append((operation.operation_index, position))
        return [
            [position for _, position in sorted(entries)] for _, entries in sorted(chains.items())
        ]

    @staticmethod
    def _apply_machine_sequences(
        instance: JobShopInstance,
        schedule: Schedule,
        successors: list[list[int]],
        in_degree: list[int],
    ) -> list[int]:
        """Add machine-order edges and return each operation's queue position.

        A job may visit one machine more than once, so a bare job identifier in a
        machine sequence is ambiguous. Occurrences are consumed in order: the
        first appearance of job ``j`` in machine ``m``'s sequence binds to ``j``'s
        first operation on ``m``, the second appearance to its second, and so on.
        """
        pending: dict[tuple[int, int], deque[int]] = {}
        for position, operation in enumerate(instance.operations):
            pending.setdefault((operation.job, operation.machine), deque()).append(position)

        slots = [0] * len(instance.operations)

        for machine_id in instance.machine_ids:
            sequence = schedule.sequence_for_machine(machine_id)
            expected = len(instance.operations_for_machine(machine_id))
            if len(sequence) != expected:
                raise ScheduleMismatchError(
                    f"Machine {machine_id} sequences {len(sequence)} operations but the "
                    f"instance declares {expected}."
                )

            previous: int | None = None
            for slot, job_id in enumerate(sequence):
                queue = pending.get((job_id, machine_id))
                if not queue:
                    raise ScheduleMismatchError(
                        f"Machine {machine_id} sequences job {job_id}, which has no remaining "
                        f"operation on that machine."
                    )
                position = queue.popleft()
                slots[position] = slot
                if previous is not None:
                    successors[previous].append(position)
                    in_degree[position] += 1
                previous = position

        for (job_id, machine_id), queue in pending.items():
            if queue:
                raise ScheduleMismatchError(
                    f"Job {job_id} has {len(queue)} unsequenced operation(s) on machine "
                    f"{machine_id}."
                )

        return slots

    @staticmethod
    def _longest_paths(
        instance: JobShopInstance,
        successors: list[list[int]],
        in_degree: list[int],
    ) -> list[int]:
        """Return the earliest feasible start of every operation.

        Kahn's algorithm relaxes each edge exactly once, so a node's start time is
        final when it is dequeued. A node left unvisited means a cycle, which is
        reported rather than silently producing wrong times.
        """
        operations = instance.operations
        starts = [0] * len(operations)
        remaining = list(in_degree)
        queue = deque(position for position, degree in enumerate(remaining) if degree == 0)
        visited = 0

        while queue:
            position = queue.popleft()
            visited += 1
            finish = starts[position] + operations[position].duration
            for following in successors[position]:
                starts[following] = max(starts[following], finish)
                remaining[following] -= 1
                if remaining[following] == 0:
                    queue.append(following)

        if visited != len(operations):
            stuck = [
                operations[position] for position, degree in enumerate(remaining) if degree > 0
            ][:5]
            detail = ", ".join(f"job {item.job} op {item.operation_index}" for item in stuck)
            raise CyclicScheduleError(
                "Job precedence and machine sequencing imply a deadlock; no feasible start "
                f"times exist. Operations involved include: {detail}."
            )

        return starts
