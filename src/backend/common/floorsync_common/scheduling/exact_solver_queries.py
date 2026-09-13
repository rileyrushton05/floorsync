"""Named reads that feed the exact FAJSP solver (`gurobi_exact_solver.py`).

Intention-revealing queries per decision 0005: each loads exactly the rows
`load_data_from_db.load_fajsp_from_db` needs, and returns plain tuples rather than
ORM instances so the parsing step can be tested without a database session.

Every function takes a caller-owned `Session` and never commits.
"""

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from floorsync_common.database.models.compatibility import Compatibility
from floorsync_common.database.models.dependency import Dependency
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.operation import Operation


def load_active_machines(db: Session) -> Sequence[tuple[UUID, str]]:
    """Load every machine the solver may assign work to.

    Inactive machines are excluded: they have no eligible route for ReSchedEngine
    either (see `resched.py`'s `active_machine_ids`), and the exact solver should
    size the same problem, not a larger one for Gurobi to explore.
    """
    statement = (
        select(Machine.id, Machine.name)
        .where(Machine.active.is_(True))
        .order_by(Machine.name, Machine.id)
    )
    return db.execute(statement).tuples().all()


def load_operations(db: Session) -> Sequence[UUID]:
    """Load every operation id.

    Ordering only keeps the read deterministic -- the solver derives each job's
    actual processing order from `load_precedences`, not from this order.
    """
    statement = select(Operation.id).order_by(Operation.job_id, Operation.position)
    return [row[0] for row in db.execute(statement).tuples().all()]


def load_routes(db: Session) -> Sequence[tuple[UUID, UUID, int]]:
    """Load operation-machine processing options, restricted to active machines.

    A route onto an inactive machine is not a real option today, so it is
    excluded rather than handed to the solver as something it could assign.
    """
    statement = (
        select(Compatibility.operation_id, Compatibility.machine_id, Compatibility.duration)
        .join(Machine, Machine.id == Compatibility.machine_id)
        .where(Machine.active.is_(True))
        .order_by(Compatibility.operation_id, Compatibility.machine_id)
    )
    return db.execute(statement).tuples().all()


def load_precedences(db: Session) -> Sequence[tuple[UUID, UUID]]:
    """Load every precedence edge: `before_operation_id` must finish before `after_operation_id`."""
    statement = select(Dependency.before_operation_id, Dependency.after_operation_id)
    return db.execute(statement).tuples().all()
