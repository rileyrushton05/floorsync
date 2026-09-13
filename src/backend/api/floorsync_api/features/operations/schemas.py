from datetime import datetime
from decimal import Decimal
from typing import Annotated
from uuid import UUID

from pydantic import StringConstraints, model_validator

from floorsync_api.schemas import RequestSchema, ResponseSchema

type OperationName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class OperationCreateRequest(RequestSchema):
    """A step a manager is adding to a job.

    Only a name. What the step costs is a property of the machine that runs it and is recorded
    through the capability endpoints, and where it sits in the order is recorded through the job's
    dependencies -- neither is a field on the step itself.
    """

    name: OperationName


class OperationUpdateRequest(RequestSchema):
    """A partial update. `name` is NOT NULL, so an explicit null is rejected rather than stored."""

    name: OperationName | None = None

    @model_validator(mode="after")
    def reject_null_name(self) -> "OperationUpdateRequest":
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("name cannot be null")
        return self


class DependencyEdgeRequest(RequestSchema):
    """One ordering edge: `before` must finish before `after` starts."""

    before_operation_id: UUID
    after_operation_id: UUID


class JobDependenciesReplaceRequest(RequestSchema):
    """The complete ordering for one job, replacing whatever is currently stored.

    A job's ordering is every edge whose `after_operation_id` is one of its own operations, so this
    can express a step waiting on an operation in a different job -- allowed on purpose -- while
    still leaving every edge owned by exactly one job.
    """

    edges: list[DependencyEdgeRequest]

    @model_validator(mode="after")
    def reject_self_and_repeated_edges(self) -> "JobDependenciesReplaceRequest":
        """Refuse here what the database refuses anyway, so the caller gets a reason not a 500.

        Mirrors the `not_self_referential` check constraint and the uniqueness of
        (before_operation_id, after_operation_id) on `dependencies`.
        """

        seen: set[tuple[UUID, UUID]] = set()
        for edge in self.edges:
            if edge.before_operation_id == edge.after_operation_id:
                raise ValueError("an operation cannot wait on itself")
            pair = (edge.before_operation_id, edge.after_operation_id)
            if pair in seen:
                raise ValueError("the same edge is listed more than once")
            seen.add(pair)
        return self


class DependencyResponse(ResponseSchema):
    """One stored ordering edge."""

    before_operation_id: UUID
    after_operation_id: UUID


class JobDependenciesResponse(ResponseSchema):
    """A job's complete ordering."""

    edges: list[DependencyResponse]


class OperationCompatibilityResponse(ResponseSchema):
    """What one machine costs for this operation. Managed through the capability endpoints."""

    machine_id: UUID
    duration: int
    energy: Decimal | None


class OperationResponse(ResponseSchema):
    id: UUID
    job_id: UUID
    name: str
    created_at: datetime
    updated_at: datetime


class OperationDetailResponse(OperationResponse):
    """One operation with its machine options and its place in the ordering.

    `predecessors` and `successors` are operation ids rather than full edges: one end of every such
    edge is this operation, so repeating it would say nothing.
    """

    compatibilities: list[OperationCompatibilityResponse]
    predecessors: list[UUID]
    successors: list[UUID]
