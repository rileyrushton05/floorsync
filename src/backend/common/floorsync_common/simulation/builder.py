"""Derive a timeline from a benchmark instance and a solver's solution.

Benchmark instances stay out of the database entirely (see
``docs/database-schema.md``), so this adapter reads the two file formats the
benchmarking work produces and translates them into the neutral node and edge
vocabulary of :mod:`floorsync_common.simulation.graph`.

The translation supplies the precedence edges that a FloorSync schedule already
stores in ``schedule_dependencies``:

* job precedence -- operation ``k + 1`` of a job cannot start before operation
  ``k`` of that job has finished;
* machine sequencing -- a machine's next job cannot start before the previous one
  on that machine has finished.

Once those edges exist, the resolution is identical for both sources.
"""

from collections import deque
from itertools import pairwise

from .errors import ScheduleMismatchError
from .graph import PrecedenceEdge, PrecedenceReason, TimelineNode
from .instance import JobShopInstance
from .schedule import Schedule
from .timeline import Timeline


def _node_key(job: int, operation_index: int) -> str:
    return f"{job}:{operation_index}"


class TimelineBuilder:
    """Turn a benchmark instance and solution into a timeline. Stateless."""

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
        nodes = TimelineBuilder.to_nodes(instance)
        edges = [
            *TimelineBuilder.job_precedence_edges(instance),
            *TimelineBuilder.machine_queue_edges(instance, schedule),
        ]
        return Timeline.from_graph(nodes, edges)

    @staticmethod
    def to_nodes(instance: JobShopInstance) -> list[TimelineNode]:
        """Translate every operation in the instance into a timeline node."""
        return [
            TimelineNode(
                key=_node_key(operation.job, operation.operation_index),
                job_key=str(operation.job),
                machine_key=str(operation.machine),
                duration=operation.duration,
                job_label=f"Job {operation.job}",
                machine_label=f"Machine {operation.machine}",
                operation_label=f"Op {operation.operation_index}",
            )
            for operation in instance.operations
        ]

    @staticmethod
    def job_precedence_edges(instance: JobShopInstance) -> list[PrecedenceEdge]:
        """Return the edges implied by each job's fixed operation order.

        A benchmark job is a strict chain, unlike a FloorSync process, which may
        fan in and cross jobs.
        """
        edges: list[PrecedenceEdge] = []
        for job_id in instance.job_ids:
            chain = sorted(
                instance.operations_for_job(job_id), key=lambda item: item.operation_index
            )
            for earlier, later in pairwise(chain):
                edges.append(
                    PrecedenceEdge(
                        before=_node_key(earlier.job, earlier.operation_index),
                        after=_node_key(later.job, later.operation_index),
                        reason=PrecedenceReason.JOB_ORDER,
                    )
                )
        return edges

    @staticmethod
    def machine_queue_edges(instance: JobShopInstance, schedule: Schedule) -> list[PrecedenceEdge]:
        """Return the edges implied by each machine's visiting order.

        A job may visit one machine more than once, so a bare job identifier in a
        machine sequence is ambiguous. Occurrences are consumed in order: the
        first appearance of job ``j`` in machine ``m``'s sequence binds to ``j``'s
        first operation on ``m``, the second appearance to its second, and so on.

        Raises:
            ScheduleMismatchError: If the schedule does not sequence exactly the
                operations the instance declares.
        """
        pending: dict[tuple[int, int], deque[str]] = {}
        for operation in instance.operations:
            visit = (operation.job, operation.machine)
            pending.setdefault(visit, deque()).append(
                _node_key(operation.job, operation.operation_index)
            )

        edges: list[PrecedenceEdge] = []
        for machine_id in instance.machine_ids:
            sequence = schedule.sequence_for_machine(machine_id)
            expected = len(instance.operations_for_machine(machine_id))
            if len(sequence) != expected:
                raise ScheduleMismatchError(
                    f"Machine {machine_id} sequences {len(sequence)} operations but the "
                    f"instance declares {expected}."
                )

            previous: str | None = None
            for job_id in sequence:
                queue = pending.get((job_id, machine_id))
                if not queue:
                    raise ScheduleMismatchError(
                        f"Machine {machine_id} sequences job {job_id}, which has no remaining "
                        f"operation on that machine."
                    )
                key = queue.popleft()
                if previous is not None:
                    edges.append(
                        PrecedenceEdge(
                            before=previous,
                            after=key,
                            reason=PrecedenceReason.MACHINE_QUEUE,
                        )
                    )
                previous = key

        for (job_id, machine_id), queue in pending.items():
            if queue:
                raise ScheduleMismatchError(
                    f"Job {job_id} has {len(queue)} unsequenced operation(s) on machine "
                    f"{machine_id}."
                )

        return edges
