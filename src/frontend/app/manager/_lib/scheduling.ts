import type {
    GeneratedSchedule,
    JobDef,
    Machine,
    MachineLoad,
    Priority,
    ScheduleResult,
    ScheduledOperation,
} from "./types";

const PRIORITY_RANK: Record<Priority, number> = { High: 0, Med: 1, Low: 2 };

/** Sum of every operation's duration — the machine time a job consumes. */
export function totalWorkMins(job: JobDef): number {
    return job.operations.reduce((total, op) => total + op.durationMins, 0);
}

/** Jobs that list `jobId` as a dependency. */
export function dependentsOf(jobs: JobDef[], jobId: string): JobDef[] {
    return jobs.filter((job) => job.dependsOn.includes(jobId));
}

/**
 * Would making `jobId` depend on `candidateId` close a loop? True when
 * `candidateId` already depends on `jobId`, directly or transitively.
 */
export function wouldCreateCycle(jobs: JobDef[], jobId: string, candidateId: string): boolean {
    if (jobId === candidateId) return true;
    const byId = new Map(jobs.map((job) => [job.id, job]));
    const seen = new Set<string>();
    const stack = [candidateId];
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (current === jobId) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        stack.push(...(byId.get(current)?.dependsOn ?? []));
    }
    return false;
}

/**
 * Everything that has to be true before a selection can be laid out. Returns
 * human-readable problems rather than throwing, so the UI can list them all at
 * once instead of surfacing them one failure at a time.
 */
export function validateSelection(jobs: JobDef[], machines: Machine[], selectedIds: string[]): string[] {
    const errors: string[] = [];
    const selected = jobs.filter((job) => selectedIds.includes(job.id));

    if (selected.length === 0) {
        return ["Select at least one job to schedule."];
    }

    const machineIds = new Set(machines.map((machine) => machine.id));
    const selectedIdSet = new Set(selectedIds);

    for (const job of selected) {
        if (job.operations.length === 0) {
            errors.push(`${job.id} “${job.name}” has no operations.`);
        }
        for (const op of job.operations) {
            if (op.durationMins <= 0) {
                errors.push(`${job.id} · ${op.name} needs a duration greater than zero.`);
            }
            if (!machineIds.has(op.machineId)) {
                errors.push(`${job.id} · ${op.name} is assigned to a machine that no longer exists.`);
            }
        }
        for (const depId of job.dependsOn) {
            if (!selectedIdSet.has(depId)) {
                const dep = jobs.find((candidate) => candidate.id === depId);
                errors.push(
                    `${job.id} depends on ${depId}${dep ? ` “${dep.name}”` : ""}, which is not in this selection.`,
                );
            }
        }
    }

    return errors;
}

/**
 * Kahn's algorithm over the dependency graph, breaking ties by priority and
 * then by id so the same selection always produces the same plan. Returns null
 * if the selection contains a dependency cycle.
 */
function topologicalOrder(selected: JobDef[]): JobDef[] | null {
    const selectedIds = new Set(selected.map((job) => job.id));
    const remaining = new Map(selected.map((job) => [job.id, job]));
    const outstanding = new Map(
        selected.map((job) => [job.id, job.dependsOn.filter((depId) => selectedIds.has(depId)).length]),
    );

    const ordered: JobDef[] = [];
    while (remaining.size > 0) {
        const ready = [...remaining.values()].filter((job) => outstanding.get(job.id) === 0);
        if (ready.length === 0) return null; // every remaining job is waiting on another: a cycle

        ready.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id.localeCompare(b.id));
        const next = ready[0];
        ordered.push(next);
        remaining.delete(next.id);

        for (const job of remaining.values()) {
            if (job.dependsOn.includes(next.id)) {
                outstanding.set(job.id, (outstanding.get(job.id) ?? 1) - 1);
            }
        }
    }
    return ordered;
}

interface Interval {
    start: number;
    end: number;
}

/**
 * First moment at or after `notBefore` where `duration` fits between the
 * machine's existing bookings. Backfilling idle gaps rather than always
 * appending is what keeps a low-priority short job from pushing the makespan
 * out when a machine is free earlier.
 */
function earliestSlot(bookings: Interval[], notBefore: number, duration: number): number {
    let candidate = notBefore;
    for (const booking of bookings) {
        if (booking.end <= candidate) continue;
        if (booking.start - candidate >= duration) return candidate;
        candidate = Math.max(candidate, booking.end);
    }
    return candidate;
}

function insertBooking(bookings: Interval[], booking: Interval): void {
    const index = bookings.findIndex((existing) => existing.start > booking.start);
    bookings.splice(index === -1 ? bookings.length : index, 0, booking);
}

/**
 * Lay the selected jobs out across the machines.
 *
 * A priority-ordered list scheduler: walk the jobs in dependency-then-priority
 * order and give each operation the earliest slot on its machine that respects
 * (a) the previous operation in the same job, (b) the machine already being
 * booked, and (c) every job this one depends on having finished.
 *
 * Greedy, not optimal — it will not reorder or pre-empt to shorten the
 * makespan — but it is deterministic and every placement is explainable, which
 * matters more than optimality for a plan a person has to trust.
 */
export function generateSchedule(jobs: JobDef[], machines: Machine[], selectedIds: string[]): ScheduleResult {
    const errors = validateSelection(jobs, machines, selectedIds);
    if (errors.length > 0) return { ok: false, errors };

    const selected = jobs.filter((job) => selectedIds.includes(job.id));
    const ordered = topologicalOrder(selected);
    if (!ordered) {
        return {
            ok: false,
            errors: ["These jobs depend on each other in a loop, so no order can satisfy them all."],
        };
    }

    const bookings = new Map<string, Interval[]>(machines.map((machine) => [machine.id, []]));
    const ops: ScheduledOperation[] = [];
    const jobStart: Record<string, number> = {};
    const jobFinish: Record<string, number> = {};

    for (const job of ordered) {
        // A job cannot open before everything it depends on has closed.
        const readyAt = job.dependsOn.reduce((latest, depId) => Math.max(latest, jobFinish[depId] ?? 0), 0);

        let previousOpEnd = readyAt;
        job.operations.forEach((op, index) => {
            const machineBookings = bookings.get(op.machineId)!;
            const startMins = earliestSlot(machineBookings, previousOpEnd, op.durationMins);
            const endMins = startMins + op.durationMins;

            insertBooking(machineBookings, { start: startMins, end: endMins });
            ops.push({
                jobId: job.id,
                opId: op.id,
                opName: op.name,
                opIndex: index + 1,
                opTotal: job.operations.length,
                machineId: op.machineId,
                startMins,
                endMins,
            });

            if (index === 0) jobStart[job.id] = startMins;
            previousOpEnd = endMins;
        });

        jobFinish[job.id] = previousOpEnd;
    }

    const makespanMins = ops.reduce((latest, op) => Math.max(latest, op.endMins), 0);
    const machineLoad: MachineLoad[] = machines.map((machine) => {
        const busyMins = ops
            .filter((op) => op.machineId === machine.id)
            .reduce((total, op) => total + (op.endMins - op.startMins), 0);
        return {
            machineId: machine.id,
            busyMins,
            utilisationPct: makespanMins === 0 ? 0 : Math.round((busyMins / makespanMins) * 100),
        };
    });

    return {
        ok: true,
        schedule: {
            ops,
            order: ordered.map((job) => job.id),
            jobStart,
            jobFinish,
            machineLoad,
            makespanMins,
            generatedAt: new Date().toISOString(),
        },
    };
}

/** 135 -> "2h 15m". Durations and offsets are always shown relative to T+0. */
export function formatDuration(mins: number): string {
    const hours = Math.floor(mins / 60);
    const minutes = Math.round(mins % 60);
    if (hours === 0) return `${minutes}m`;
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
}

/** 135 -> "T+2:15" */
export function formatOffset(mins: number): string {
    const hours = Math.floor(mins / 60);
    const minutes = Math.round(mins % 60);
    return `T+${hours}:${String(minutes).padStart(2, "0")}`;
}
