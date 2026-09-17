"""Adapter between FloorSync's scheduling contract and the ReSched FJSP policy."""

from __future__ import annotations

import importlib.util
import sys
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from itertools import pairwise
from pathlib import Path
from typing import Any, ClassVar
from uuid import UUID

from floorsync_common.outcomes import ExpectedOutcome
from floorsync_common.scheduling.contracts import (
    ScheduleDependencySpec,
    ScheduledOperation,
    ScheduleGenerated,
    ScheduleMetrics,
    SchedulePlan,
    SchedulingInput,
    SchedulingInputInvalid,
    SchedulingIssue,
)
from floorsync_common.scheduling.input_checks import resched_strategy_limits, validate_input


@dataclass(frozen=True, slots=True)
class ReSchedRuntimeUnavailable(ExpectedOutcome):
    detail: str


type ReSchedGenerateResult = ScheduleGenerated | SchedulingInputInvalid | ReSchedRuntimeUnavailable


class ReSchedEngine:
    """Run ReSched unchanged, then map its solution into FloorSync's schedule format."""

    strategy = "resched_reinforce_v1"
    _model_params: ClassVar[dict[str, int]] = {
        "action_space": 2,
        "embedding_dim": 128,
        "block_num": 2,
        "head_num": 8,
        "qkv_dim": 16,
        "ff_hidden_dim": 512,
    }

    @staticmethod
    def generate(problem: SchedulingInput) -> ReSchedGenerateResult:
        issues, chains = ReSchedEngine._validate(problem)
        if issues:
            return SchedulingInputInvalid(issues=issues)
        try:
            return ScheduleGenerated(plan=ReSchedEngine._run(problem, chains))
        except ReSchedRuntimeError as error:
            return ReSchedRuntimeUnavailable(detail=str(error))

    @staticmethod
    def unsupported(problem: SchedulingInput) -> tuple[SchedulingIssue, ...]:
        """What this policy cannot take on coherent data; see `resched_strategy_limits`."""

        return resched_strategy_limits(problem)

    @staticmethod
    def _validate(
        problem: SchedulingInput,
    ) -> tuple[tuple[SchedulingIssue, ...], tuple[tuple[UUID, ...], ...]]:
        """Accept only the standard FJSP input represented by the pretrained ReSched policy.

        Data coherence is `input_checks.validate_input`'s job, shared with the exact solver and the
        pre-scheduling validation endpoint; this adds the policy's own limits and, once both are
        clear, lays the operations out as the linear chains the runtime consumes.
        """

        issues = validate_input(problem) + ReSchedEngine.unsupported(problem)
        if issues:
            return issues, ()

        operation_ids = {operation.id for operation in problem.operations}
        predecessor: dict[UUID, UUID] = {}
        successor: dict[UUID, UUID] = {}
        for edge in problem.dependencies:
            predecessor[edge.after_operation_id] = edge.before_operation_id
            successor[edge.before_operation_id] = edge.after_operation_id

        chains: list[tuple[UUID, ...]] = []
        for start in sorted(operation_ids - set(predecessor), key=str):
            chain = [start]
            while chain[-1] in successor:
                chain.append(successor[chain[-1]])
            chains.append(tuple(chain))
        scheduled_operations = {operation_id for chain in chains for operation_id in chain}
        if scheduled_operations != operation_ids:
            # Unreachable once `validate_input` has refused every cycle, kept as the last line of
            # defence because the runtime would loop forever on one.
            return (
                (
                    SchedulingIssue(
                        "cyclic_dependencies",
                        "ReSched requires acyclic linear job dependencies.",
                    ),
                ),
                (),
            )
        return (), tuple(chains)

    @staticmethod
    def _run(problem: SchedulingInput, chains: tuple[tuple[UUID, ...], ...]) -> SchedulePlan:
        np, torch, fjsp_environment, model_type, build_model_input = ReSchedEngine._load_runtime()
        ordered_operation_ids = tuple(operation_id for chain in chains for operation_id in chain)
        active_machines = tuple(
            sorted(
                (machine for machine in problem.machines if machine.active),
                key=lambda machine: str(machine.id),
            )
        )
        operation_index = {
            operation_id: index for index, operation_id in enumerate(ordered_operation_ids)
        }
        machine_index = {machine.id: index for index, machine in enumerate(active_machines)}
        route_by_pair = {(route.operation_id, route.machine_id): route for route in problem.routes}

        duration = np.zeros((1, len(ordered_operation_ids), len(active_machines)), dtype=np.float32)
        for (operation_id, machine_id), route in route_by_pair.items():
            if machine_id in machine_index:
                duration[0, operation_index[operation_id], machine_index[machine_id]] = (
                    route.duration_minutes
                )
        dependency = np.zeros(
            (1, len(ordered_operation_ids), len(ordered_operation_ids)), dtype=np.bool_
        )
        connection = np.zeros_like(dependency)
        for chain in chains:
            for position, operation_id in enumerate(chain):
                target_index = operation_index[operation_id]
                for successor_id in chain[position + 1 :]:
                    connection[0, target_index, operation_index[successor_id]] = True
                if position:
                    dependency[0, operation_index[chain[position - 1]], target_index] = True
        job_indexes = np.concatenate(
            [
                np.full(len(chain), job_index, dtype=np.int64)
                for job_index, chain in enumerate(chains)
            ]
        )[None, :]
        operation_positions = np.concatenate(
            [np.arange(len(chain), dtype=np.int64) for chain in chains]
        )[None, :]

        environment = fjsp_environment()
        environment.load_data(
            1,
            job_indexes,
            operation_positions,
            duration,
            dependency,
            connection,
        )
        state = environment.reset_state()
        model = model_type(**ReSchedEngine._model_params)
        model.load_state_dict(torch.load(ReSchedEngine._checkpoint_path(), map_location="cpu"))
        model.eval()
        model.set_decode_type("greedy")
        with torch.no_grad():
            done = False
            while not done:
                model_state, _ = build_model_input(state, environment)
                action, _ = model(model_state)
                state, _, done = environment.step(action)

        operation_by_job_position = {
            (job_index, position): operation_id
            for job_index, chain in enumerate(chains)
            for position, operation_id in enumerate(chain)
        }
        machines_by_index = {index: machine for index, machine in enumerate(active_machines)}
        assignments = []
        for job_index, position, machine_id in zip(
            environment.solution.job_idx[0],
            environment.solution.operation_idx[0],
            environment.solution.machine_idx[0],
            strict=True,
        ):
            operation_id = operation_by_job_position[(int(job_index), int(position))]
            machine = machines_by_index[int(machine_id)]
            route = route_by_pair[(operation_id, machine.id)]
            operation_offset = operation_index[operation_id]
            starts_at = state.start_time[0, operation_offset, int(machine_id)]
            ends_at = state.finish_time[0, operation_offset, int(machine_id)]
            assignments.append(
                ScheduledOperation(
                    operation_id=operation_id,
                    machine_id=machine.id,
                    starts_at=problem.starts_at + timedelta(minutes=int(starts_at)),
                    ends_at=problem.starts_at + timedelta(minutes=int(ends_at)),
                    duration_minutes=route.duration_minutes,
                    energy=route.energy,
                    machine_salary_per_minute=machine.salary_per_minute,
                )
            )
        return ReSchedEngine._to_plan(problem, tuple(assignments))

    @staticmethod
    def _to_plan(
        problem: SchedulingInput,
        assignments: tuple[ScheduledOperation, ...],
    ) -> SchedulePlan:
        dependencies = [
            ScheduleDependencySpec(
                schedule_operation_id=edge.after_operation_id,
                depends_on_operation_id=edge.before_operation_id,
                reason="job_order",
            )
            for edge in problem.dependencies
        ]
        existing_edges = {
            (dependency.schedule_operation_id, dependency.depends_on_operation_id)
            for dependency in dependencies
        }
        for machine_id in {assignment.machine_id for assignment in assignments}:
            queue = sorted(
                (assignment for assignment in assignments if assignment.machine_id == machine_id),
                key=lambda assignment: (
                    assignment.starts_at,
                    assignment.ends_at,
                    str(assignment.operation_id),
                ),
            )
            for previous, current in pairwise(queue):
                edge = (current.operation_id, previous.operation_id)
                if edge not in existing_edges:
                    dependencies.append(
                        ScheduleDependencySpec(
                            schedule_operation_id=current.operation_id,
                            depends_on_operation_id=previous.operation_id,
                            reason="machine_queue",
                        )
                    )
                    existing_edges.add(edge)
        ordered = tuple(
            sorted(
                assignments,
                key=lambda assignment: (
                    assignment.starts_at,
                    assignment.ends_at,
                    str(assignment.operation_id),
                ),
            )
        )
        latest_end = max(assignment.ends_at for assignment in ordered)
        energy_values = [assignment.energy for assignment in ordered]
        salary_values = [assignment.machine_salary_per_minute for assignment in ordered]
        return SchedulePlan(
            assignments=ordered,
            dependencies=tuple(dependencies),
            metrics=ScheduleMetrics(
                makespan_minutes=int((latest_end - problem.starts_at).total_seconds() // 60),
                total_energy=(
                    sum((energy for energy in energy_values if energy is not None), Decimal("0"))
                    if all(energy is not None for energy in energy_values)
                    else None
                ),
                total_labour_cost=(
                    sum(
                        (
                            Decimal(assignment.duration_minutes) * salary
                            for assignment, salary in zip(ordered, salary_values, strict=True)
                            if salary is not None
                        ),
                        Decimal("0"),
                    )
                    if all(salary is not None for salary in salary_values)
                    else None
                ),
            ),
        )

    @staticmethod
    def _load_runtime() -> tuple[Any, Any, Any, Any, Any]:
        if importlib.util.find_spec("numpy") is None or importlib.util.find_spec("torch") is None:
            raise ReSchedRuntimeError(
                "Install the 'resched' optional dependency group to run ReSched."
            )
        source_directory = ReSchedEngine._source_directory()
        if not source_directory.is_dir():
            raise ReSchedRuntimeError("The ReSched git submodule has not been initialised.")
        if not ReSchedEngine._checkpoint_path().is_file():
            raise ReSchedRuntimeError("The configured ReSched checkpoint is unavailable.")
        if str(source_directory) not in sys.path:
            sys.path.insert(0, str(source_directory))
        try:
            import numpy as np
            import torch
            from SchedulingEnvironment import FJSPEnv  # type: ignore[import-not-found]
            from SchedulingModel import Model, build_model_input  # type: ignore[import-not-found]
        except ImportError as error:
            raise ReSchedRuntimeError(f"Unable to import ReSched: {error}") from error
        return np, torch, FJSPEnv, Model, build_model_input

    @staticmethod
    def _source_directory() -> Path:
        return Path(__file__).resolve().parents[3] / "third_party" / "ReSched" / "REINFORCE"

    @staticmethod
    def _checkpoint_path() -> Path:
        return (
            ReSchedEngine._source_directory().parent
            / "ckpt"
            / "REINFORCE"
            / "FJSP"
            / "Old-SD1-10x05.pth"
        )


class ReSchedRuntimeError(RuntimeError):
    """Expected deployment/configuration failure of the optional learned runtime."""
