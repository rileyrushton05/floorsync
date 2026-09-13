import type { ScheduleTimeline } from "@/app/_lib/api";
import type { GeneratedSchedule, JobDef, Machine, MachineLoad, ScheduledOperation } from "./types";

/**
 * Translate a schedule timeline from the API into the planning model.
 *
 * The simulation view already knows how to draw a `GeneratedSchedule` against a
 * list of machines and jobs, so the seam between the API and the view is a
 * translation rather than a second renderer. Everything below is renaming and
 * regrouping: **no time is recomputed here.** Start and end times arrive already
 * placed by the backend's resolver and are passed through untouched, which is
 * the point — the view shows the backend's arithmetic rather than repeating it.
 *
 * **Identity.** Lane keys are the API's unique identifiers and stay the id every
 * screen keys off; lane labels are only for display — a seeded benchmark reads
 * `abz5/J03` and `abz5/M07` while a real floor would read whatever it was
 * called. Two jobs can share a label, so the label can never double as the id.
 *
 * **Operators** are a floor concept the timeline does not carry — it answers what
 * is scheduled, not who is standing at the machine — so the lane shows the
 * machine alone.
 */

const NO_OPERATOR = "Unassigned";

export interface TimelinePlan {
    machines: Machine[];
    jobs: JobDef[];
    schedule: GeneratedSchedule;
}

export function timelineToPlan(timeline: ScheduleTimeline): TimelinePlan {
    const machines: Machine[] = timeline.machines.map((machine) => ({
        id: machine.key,
        name: machine.label,
        operator: NO_OPERATOR,
    }));

    // Position within a job is read off the resolved start times rather than the
    // operation key, so "op 3 of 10" means third to run — which is what the job
    // progress readouts claim it means.
    const byJob = new Map<string, ScheduleTimeline["operations"]>();
    for (const operation of timeline.operations) {
        const chain = byJob.get(operation.job_key);
        if (chain) chain.push(operation);
        else byJob.set(operation.job_key, [operation]);
    }
    for (const chain of byJob.values()) {
        chain.sort((left, right) => left.start - right.start);
    }

    const ops: ScheduledOperation[] = [];
    const jobs: JobDef[] = [];
    const jobStart: Record<string, number> = {};
    const jobFinish: Record<string, number> = {};

    // Lane order comes from the backend, so the legend, the job table and the
    // chart rows agree with it rather than with three local sorts.
    for (const lane of timeline.jobs) {
        const chain = byJob.get(lane.key) ?? [];
        const jobId = lane.key;

        jobs.push({
            id: jobId,
            name: lane.label,
            priority: "Med",
            operations: chain.map((operation) => ({
                id: operation.key,
                name: operation.label,
                machineId: operation.machine_key,
                durationMins: operation.end - operation.start,
            })),
        });

        chain.forEach((operation, index) => {
            ops.push({
                jobId,
                opId: operation.key,
                opName: operation.label,
                opIndex: index + 1,
                opTotal: chain.length,
                machineId: operation.machine_key,
                startMins: operation.start,
                endMins: operation.end,
            });
        });

        if (chain.length > 0) {
            jobStart[jobId] = chain[0].start;
            jobFinish[jobId] = Math.max(...chain.map((operation) => operation.end));
        }
    }

    const busyByMachine = new Map<string, number>();
    for (const operation of timeline.operations) {
        const busy = busyByMachine.get(operation.machine_key) ?? 0;
        busyByMachine.set(operation.machine_key, busy + (operation.end - operation.start));
    }
    const machineLoad: MachineLoad[] = machines.map((machine) => {
        const busyMins = busyByMachine.get(machine.id) ?? 0;
        return {
            machineId: machine.id,
            busyMins,
            utilisationPct:
                timeline.makespan === 0 ? 0 : Math.round((busyMins / timeline.makespan) * 100),
        };
    });

    return {
        machines,
        jobs,
        schedule: {
            ops,
            order: jobs.map((job) => job.id),
            jobStart,
            jobFinish,
            machineLoad,
            makespanMins: timeline.makespan,
            generatedAt: new Date().toISOString(),
        },
    };
}
