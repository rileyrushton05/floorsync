import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    GridList,
    GridListDescription,
    GridListEmptyState,
    GridListItem,
    GridListLabel,
    GridListSpacer,
} from "@/components/ui/grid-list";
import { Input, InputGroup } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { TextField } from "@/components/ui/text-field";
import { priorityIntent } from "@/core/presentation/badge-intent";
import type { JobColor } from "@/domains/scheduling/colors";
import { formatDuration, totalWorkMins } from "@/domains/scheduling/format";
import type { JobDef, Machine } from "@/domains/scheduling/types";
import { JobDot } from "@/domains/scheduling/ui/JobDot";
import { ChevronRightIcon, MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import {
    DURATION_FILTERS,
    JOB_PRIORITIES,
    SORT_OPTIONS,
    type JobFilters,
} from "../model/editor";

/**
 * The backlog: search, filters, sort and the selectable job list.
 *
 * Presentational — it reports every change through `onFiltersChange` and
 * `onSelect`, and never decides what the current job is.
 */
export function JobBacklogPanel({
    jobs,
    visibleJobs,
    machines,
    colors,
    sequenceNumbers,
    selectedJobId,
    filters,
    onFiltersChange,
    onSelect,
}: {
    jobs: JobDef[];
    visibleJobs: JobDef[];
    machines: Machine[];
    colors: Map<string, JobColor>;
    sequenceNumbers: ReadonlyMap<string, number>;
    selectedJobId: string | null;
    filters: JobFilters;
    onFiltersChange: (update: (filters: JobFilters) => JobFilters) => void;
    onSelect: (job: JobDef) => void;
}) {
    const filtersActive =
        filters.query.trim() !== "" ||
        filters.priority !== "All" ||
        filters.machineId !== "All" ||
        filters.duration !== "All";

    function clearFilters() {
        onFiltersChange((current) => ({
            ...current,
            query: "",
            priority: "All",
            machineId: "All",
            duration: "All",
        }));
    }

    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between gap-2.5">
                <CardTitle>Job backlog</CardTitle>
                <Badge intent="outline">{jobs.length} {jobs.length === 1 ? "job" : "jobs"}</Badge>
            </CardHeader>
            <CardContent>
                <TextField
                    aria-label="Search jobs by name"
                    value={filters.query}
                    onChange={(query) => onFiltersChange((current) => ({ ...current, query }))}
                >
                    <InputGroup>
                        <MagnifyingGlassIcon data-slot="icon" />
                        <Input placeholder="Search by job name…" autoComplete="off" />
                    </InputGroup>
                </TextField>

                <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-muted-fg text-xs uppercase tracking-[0.05em]">
                        Filter
                    </span>
                    {filtersActive && (
                        <Button intent="plain" size="sm" onPress={clearFilters}>
                            <XMarkIcon /> Clear
                        </Button>
                    )}
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Select
                        aria-label="Filter by priority"
                        className="w-36"
                        value={filters.priority}
                        onChange={(value) =>
                            onFiltersChange((current) => ({
                                ...current,
                                priority: value as JobFilters["priority"],
                            }))
                        }
                    >
                        <SelectTrigger />
                        <SelectContent>
                            <SelectItem id="All" textValue="All priorities">All priorities</SelectItem>
                            {JOB_PRIORITIES.map((option) => (
                                <SelectItem key={option.id} id={option.id} textValue={option.id}>
                                    {option.id}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Select
                        aria-label="Filter by machine"
                        className="w-42"
                        value={filters.machineId}
                        onChange={(value) =>
                            onFiltersChange((current) => ({ ...current, machineId: String(value) }))
                        }
                    >
                        <SelectTrigger />
                        <SelectContent>
                            <SelectItem id="All" textValue="Any machine">Any machine</SelectItem>
                            {machines.map((machine) => (
                                <SelectItem key={machine.id} id={machine.id} textValue={machine.name}>
                                    {machine.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Select
                        aria-label="Filter by duration"
                        className="w-44"
                        value={filters.duration}
                        onChange={(value) =>
                            onFiltersChange((current) => ({
                                ...current,
                                duration: value as JobFilters["duration"],
                            }))
                        }
                    >
                        <SelectTrigger />
                        <SelectContent>
                            {DURATION_FILTERS.map((option) => (
                                <SelectItem key={option.id} id={option.id} textValue={option.label}>
                                    {option.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <Separator className="my-5" />

                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Select
                        aria-label="Sort jobs"
                        className="w-44"
                        value={filters.sort}
                        onChange={(value) =>
                            onFiltersChange((current) => ({ ...current, sort: value as JobFilters["sort"] }))
                        }
                    >
                        <SelectTrigger />
                        <SelectContent>
                            {SORT_OPTIONS.map((option) => (
                                <SelectItem key={option.id} id={option.id} textValue={option.label}>
                                    {option.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Badge intent="outline" className="ml-auto" role="status">
                        Showing {visibleJobs.length} of {jobs.length}
                    </Badge>
                </div>

                <GridList
                    aria-label="Job backlog"
                    selectionMode="single"
                    selectionBehavior="replace"
                    items={visibleJobs}
                    selectedKeys={selectedJobId ? new Set([selectedJobId]) : new Set()}
                    onSelectionChange={(keys) => {
                        if (keys === "all") return;
                        const [first] = Array.from(keys);
                        const job = visibleJobs.find((candidate) => candidate.id === first);
                        if (job) onSelect(job);
                    }}
                    renderEmptyState={() => (
                        <GridListEmptyState className="text-center text-muted-fg text-sm">
                            {filtersActive
                                ? "No jobs match your search or filters."
                                : "No jobs yet. Create one to get started."}
                        </GridListEmptyState>
                    )}
                >
                    {(job) => {
                        const sequence = sequenceNumbers.get(job.id);
                        return (
                            <GridListItem
                                id={job.id}
                                textValue={`Job ${sequence ?? ""} ${job.name}`}
                                className="items-start"
                            >
                                <JobDot colors={colors} jobId={job.id} className="mt-1" />
                                <span className="flex min-w-0 flex-col gap-0.5">
                                    <span className="flex items-center gap-2">
                                        {sequence !== undefined && (
                                            <span className="font-semibold text-muted-fg text-xs tabular-nums">
                                                #{sequence}
                                            </span>
                                        )}
                                        <GridListLabel className="truncate text-sm">{job.name}</GridListLabel>
                                        <Badge intent={priorityIntent(job.priority)}>{job.priority}</Badge>
                                    </span>
                                    <GridListDescription className="text-xs">
                                        {job.operations.length}{" "}
                                        {job.operations.length === 1 ? "operation" : "operations"} ·{" "}
                                        {formatDuration(totalWorkMins(job))} of work
                                    </GridListDescription>
                                </span>
                                <GridListSpacer />
                                <ChevronRightIcon
                                    aria-hidden
                                    className="size-4 shrink-0 text-muted-fg transition group-hover:translate-x-0.5 group-hover:text-fg"
                                />
                            </GridListItem>
                        );
                    }}
                </GridList>
            </CardContent>
        </Card>
    );
}
