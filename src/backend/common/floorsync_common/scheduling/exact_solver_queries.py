"""Named reads that feed the exact FAJSP solver (`gurobi_exact_solver.py`).

Intention-revealing queries per decision 0005: each loads exactly the rows
`load_data_from_db.load_fajsp_from_db` needs, and returns plain tuples rather than
ORM instances so the parsing step can be tested without a database session.

Every function takes a caller-owned `Session` and never commits.
"""

from collections.abc import Sequence
from decimal import Decimal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.dependency import Dependency
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.operation import Operation


def load_active_machines(db: Session) -> Sequence[tuple[UUID, str, Decimal | None]]:
    """Load every machine the solver may assign work to, with its labour cost.

    Inactive machines are excluded: they have no eligible route for ReSchedEngine
    either (see `resched.py`'s `active_machine_ids`), and the exact solver should
    size the same problem, not a larger one for Gurobi to explore. `salary` is
    carried along so a persisted schedule entry can snapshot its labour cost the
    same way `ReSchedEngine` does.
    """
    statement = (
        select(Machine.id, Machine.name, Machine.salary)
        .where(Machine.active.is_(True))
        .order_by(Machine.name, Machine.id)
    )
    return db.execute(statement).tuples().all()


def load_operations(db: Session) -> Sequence[tuple[UUID, UUID, int]]:
    """Load every operation id together with its job id and builder position.

    `job_id` is required to group operations into jobs -- without it, an operation
    with no precedence edges (a single-operation job) can't be placed in any job at
    all. `position` is carried along only as a deterministic tiebreaker among an
    job's operations that share no precedence order; the solver still derives each
    job's actual processing order from `load_precedences`, not from this column.
    """
    statement = select(Operation.id, Operation.job_id, Operation.position).order_by(
        Operation.job_id, Operation.position
    )
    return db.execute(statement).tuples().all()


def load_routes(db: Session) -> Sequence[tuple[UUID, UUID, int, Decimal | None]]:
    """Load operation-machine processing options, restricted to active machines.

    A route onto an inactive machine is not a real option today, so it is
    excluded rather than handed to the solver as something it could assign.
    `energy` is carried along so a persisted schedule entry can snapshot it,
    the same way `ReSchedEngine` does.
    """
    statement = (
        select(
            Compatibility.operation_id,
            Compatibility.machine_id,
            Compatibility.duration,
            Compatibility.energy,
        )
        .join(Machine, Machine.id == Compatibility.machine_id)
        .where(Machine.active.is_(True))
        .order_by(Compatibility.operation_id, Compatibility.machine_id)
    )
    return db.execute(statement).tuples().all()


def load_precedences(db: Session) -> Sequence[tuple[UUID, UUID]]:
    """Load every precedence edge: `before_operation_id` must finish before `after_operation_id`."""
    statement = select(Dependency.before_operation_id, Dependency.after_operation_id)
    return db.execute(statement).tuples().all()
