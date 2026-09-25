import type { JobDefinition, JobDefinitionInput } from "../data/api";
import type { JobDef, OperationDef, OperationRoute, Priority } from "@/domains/scheduling/types";

const PRIORITY_FROM_API: Record<JobDefinition["priority"], Priority> = {
    high: "High",
    med: "Med",
    low: "Low",
};

const PRIORITY_TO_API: Record<Priority, JobDefinition["priority"]> = {
    High: "high",
    Med: "med",
    Low: "low",
};

function toRoute(route: JobDefinition["operations"][number]["routes"][number]): OperationRoute {
    return { machineId: route.machine_id, durationMins: route.duration_minutes, energy: route.energy };
}

function toOperation(operation: JobDefinition["operations"][number]): OperationDef {
    return {
        id: operation.id,
        name: operation.name,
        routes: operation.routes.map(toRoute),
    };
}

export function toJobDefinition(job: JobDefinition): JobDef {
    return {
        id: job.id,
        name: job.name,
        priority: PRIORITY_FROM_API[job.priority],
        createdAt: job.created_at,
        archivedAt: job.archived_at,
        backlogStatus: job.backlog_status,
        plannedByScheduleIds: job.planned_by_schedule_ids,
        operations: [...job.operations]
            .sort((left, right) => left.position - right.position)
            .map(toOperation),
    };
}

function toRoutes(operation: OperationDef): JobDefinitionInput["operations"][number]["routes"] {
    return operation.routes.map((route) => ({
        machine_id: route.machineId,
        duration_minutes: route.durationMins,
        energy: route.energy,
    }));
}

export function toJobDefinitionInput(job: Omit<JobDef, "id">, retainOperationIds: boolean): JobDefinitionInput {
    return {
        name: job.name,
        priority: PRIORITY_TO_API[job.priority],
        operations: job.operations.map((operation) => ({
            ...(retainOperationIds && !operation.id.startsWith("new-op-") ? { id: operation.id } : {}),
            name: operation.name,
            routes: toRoutes(operation),
        })),
    };
}
