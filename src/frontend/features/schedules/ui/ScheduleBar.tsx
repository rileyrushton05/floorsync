import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import type { ScheduleOption } from "../model";

const STATUS_INTENT = {
    confirmed: "success",
    draft: "warning",
    discarded: "secondary",
} as const;

/** Presentational schedule picker: data and selection intent arrive entirely as props. */
export function ScheduleBar({
    schedules,
    selectedId,
    onSelect,
    timelineSummary,
}: {
    schedules: ScheduleOption[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    timelineSummary: { jobs: number; machines: number; operations: number } | null;
}) {
    const selected = schedules.find((schedule) => schedule.id === selectedId) ?? null;
    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-navbar px-7 py-2.5">
            <Select
                aria-label="Which schedule to simulate"
                className="min-w-[22rem]"
                selectedKey={selectedId}
                onSelectionChange={(key) => {
                    if (typeof key === "string") onSelect(key);
                }}
            >
                <Label className="sr-only">Schedule</Label>
                <SelectTrigger />
                <SelectContent items={schedules}>
                    {(schedule: ScheduleOption) => (
                        <SelectItem id={schedule.id} textValue={schedule.label}>
                            {schedule.label}
                        </SelectItem>
                    )}
                </SelectContent>
            </Select>

            {selected && <Badge intent={STATUS_INTENT[selected.status]}>{selected.status}</Badge>}

            {timelineSummary && (
                <span className="text-muted-fg text-xs">
                    {timelineSummary.jobs} jobs × {timelineSummary.machines} machines, {timelineSummary.operations} operations
                    — resolved by the API from the stored schedule.
                </span>
            )}
        </div>
    );
}
