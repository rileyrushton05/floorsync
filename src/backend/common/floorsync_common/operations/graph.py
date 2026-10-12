"""Pure graph algorithms over operation precedence edges.

Nothing here touches the database: callers hand in `(before, after)` pairs and get facts back. Kept
apart from `operations.service` so that engine adapters and input validation, which must stay free
of session and model imports, can depend on it without dragging the persistence layer in.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Hashable, Iterable, Sequence
from uuid import UUID


def find_dependency_cycle(edges: Sequence[tuple[UUID, UUID]]) -> tuple[UUID, ...]:
    """Return the operations caught in a cycle, or an empty tuple when the graph is acyclic.

    Kahn's algorithm: repeatedly remove an operation nothing is waiting on. Whatever cannot be
    removed is exactly the set caught in a cycle -- more useful to report than one arbitrary path,
    since there may be several cycles and every one of them has to be broken.

    Pure and total, so the caller decides what a cycle means. `ReSched` would reject cyclic input
    anyway, but far later and without naming the operations responsible.
    """

    successors: dict[UUID, list[UUID]] = {}
    incoming: dict[UUID, int] = {}
    for before, after in edges:
        successors.setdefault(before, []).append(after)
        successors.setdefault(after, [])
        incoming.setdefault(before, 0)
        incoming[after] = incoming.get(after, 0) + 1

    ready = [operation for operation, count in incoming.items() if count == 0]
    removed = 0
    while ready:
        operation = ready.pop()
        removed += 1
        for following in successors[operation]:
            incoming[following] -= 1
            if incoming[following] == 0:
                ready.append(following)

    if removed == len(incoming):
        return ()
    return tuple(sorted(operation for operation, count in incoming.items() if count > 0))


def branching_operations[Operation: Hashable](
    edges: Iterable[tuple[Operation, Operation]],
) -> set[Operation]:
    """Return every operation with more than one predecessor or more than one successor.

    That is the line between a set of straight chains and a general precedence graph: fan-in (an
    operation waiting on several) or fan-out (several waiting on one). ReSched takes only straight
    chains, so this one definition is shared by its strategy limits and by the import preview's
    warning, and the two cannot drift apart. Generic over the identifier, since an import plan
    names operations before the database has given them ids.
    """

    edge_list = list(edges)
    predecessors = Counter(after for _, after in edge_list)
    successors = Counter(before for before, _ in edge_list)
    return {operation for operation, count in predecessors.items() if count > 1} | {
        operation for operation, count in successors.items() if count > 1
    }


__all__ = ["branching_operations", "find_dependency_cycle"]
