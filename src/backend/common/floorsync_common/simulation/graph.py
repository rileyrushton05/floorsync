"""The format-neutral core of the timeline calculation.

Everything in this module is expressed as opaque string keys and integer
durations, so the same longest-path resolution serves both sources of schedules
FloorSync has:

* **FloorSync schedules**, where ``schedule_entries`` supply the nodes and
  ``schedule_dependencies`` already supply the edges;
* **benchmark instances**, where the edges have to be derived first from job
  precedence and each machine's visiting order.

Keeping the core keyed by strings rather than by ``UUID`` or by benchmark
integers is what lets one implementation, and one set of correctness tests,
cover both. Adapters own the translation; this module owns the arithmetic.
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from enum import StrEnum

from .errors import CyclicScheduleError


class PrecedenceReason(StrEnum):
    """Why one scheduled operation must wait for another.

    The values match the ``reason`` check constraint on ``schedule_dependencies``
    so a stored row maps onto an edge without translation.
    """

    JOB_ORDER = "job_order"
    """The predecessor is an earlier step of the same production process."""

    MACHINE_QUEUE = "machine_queue"
    """The predecessor occupies the same machine earlier in its queue."""


@dataclass(frozen=True, slots=True)
class TimelineNode:
    """One unit of work awaiting placement on the clock.

    Attributes:
        key: Identifier unique within a single timeline. Adapters use the
            stringified ``schedule_entries.id`` for FloorSync schedules and a
            ``"job:operation"`` pair for benchmark instances.
        job_key: Identifier of the job or process this work belongs to, used to
            group a job's operations.
        machine_key: Identifier of the machine that processes this work, used to
            group a machine's lane.
        duration: Processing time. Minutes for FloorSync schedules, abstract
            units for benchmark instances; the resolution never interprets it.
        job_label: Human-readable job name for display.
        machine_label: Human-readable machine name for display.
        operation_label: Human-readable name of this step for display.
    """

    key: str
    job_key: str
    machine_key: str
    duration: int
    job_label: str
    machine_label: str
    operation_label: str


@dataclass(frozen=True, slots=True)
class PrecedenceEdge:
    """A constraint that ``before`` must finish before ``after`` starts."""

    before: str
    after: str
    reason: PrecedenceReason


def resolve_start_times(
    nodes: Sequence[TimelineNode], edges: Iterable[PrecedenceEdge]
) -> dict[str, int]:
    """Return the earliest feasible start time of every node.

    Kahn's algorithm relaxes each edge exactly once, so a node's start time is
    final when it is dequeued. A node left unvisited means a cycle, which is
    reported rather than silently producing wrong times.

    Args:
        nodes: Every node to place, in any order.
        edges: Precedence constraints between those nodes.

    Returns:
        Mapping of node key to start time.

    Raises:
        CyclicScheduleError: If the constraints imply a deadlock, so no feasible
            start times exist.
        KeyError: If an edge names a node that is not in ``nodes``.
    """
    duration_of = {node.key: node.duration for node in nodes}
    successors: dict[str, list[str]] = {node.key: [] for node in nodes}
    in_degree = dict.fromkeys(duration_of, 0)

    for edge in edges:
        if edge.before not in duration_of:
            raise KeyError(f"Precedence edge names unknown node '{edge.before}'.")
        if edge.after not in duration_of:
            raise KeyError(f"Precedence edge names unknown node '{edge.after}'.")
        successors[edge.before].append(edge.after)
        in_degree[edge.after] += 1

    starts = dict.fromkeys(duration_of, 0)
    remaining = dict(in_degree)
    queue = [key for key, degree in remaining.items() if degree == 0]
    ready = list(queue)
    visited = 0

    while ready:
        key = ready.pop()
        visited += 1
        finish = starts[key] + duration_of[key]
        for following in successors[key]:
            if finish > starts[following]:
                starts[following] = finish
            remaining[following] -= 1
            if remaining[following] == 0:
                ready.append(following)

    if visited != len(duration_of):
        stuck = [key for key, degree in remaining.items() if degree > 0][:5]
        raise CyclicScheduleError(
            "Precedence and machine queueing imply a deadlock; no feasible start times exist. "
            f"Nodes involved include: {', '.join(stuck)}."
        )

    return starts
