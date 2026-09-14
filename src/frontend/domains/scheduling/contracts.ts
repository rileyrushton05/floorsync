/** The backend timeline contract, owned by the scheduling domain rather than a UI feature. */
export interface TimelineLane {
    key: string;
    label: string;
}

export interface TimelineOperation {
    key: string;
    job_key: string;
    machine_key: string;
    label: string;
    start: number;
    end: number;
    machine_slot: number;
}

export interface ScheduleTimeline {
    schedule_id: string;
    makespan: number;
    machines: TimelineLane[];
    jobs: TimelineLane[];
    operations: TimelineOperation[];
}
