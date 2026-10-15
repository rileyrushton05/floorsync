import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HeaderCount } from "@/components/ui/header-count";
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
import { PanelControls } from "@/core/panels/PanelChrome";
import { priorityIntent } from "@/core/presentation/badge-intent";
import type { JobColor } from "@/domains/scheduling/colors";
import { formatDuration, totalWorkMins } from "@/domains/scheduling/format";
import type { JobDef } from "@/domains/scheduling/types";
import { JobDot } from "@/domains/scheduling/ui/JobDot";
import { ChevronRightIcon, MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { SORT_OPTIONS, STATUS_FILTERS, type JobFilters } from "../model/editor";

/**
 * How many rows are put in the DOM at once.
 *
 * A seeded floor can hold hundreds of jobs — the `bel00` benchmark alone is 792
 * — and every row here is a grid item with a badge, a colour dot and two lines
 * of text. Rendering all of them costs more than anyone can read, so the list
 * stops and says so; search, the filters and the sort are how you reach the
 * rest, and they all run over the whole backlog rather than over this window.
 */
const MAX_ROWS = 150;

/**
 * The backlog: search, filters, sort and the selectable job list.
 *
 * Presentational — it reports every change through `onFiltersChange` and
 * `onSelect`, and never decides what the current job is.
 */
export function JobBacklogPanel({
    jobs,
    visibleJobs,
    colors,
    sequenceNumbers,
    selectedJobId,
    filters,
    busy,
    onFiltersChange,
    onSelect,
}: {
    jobs: JobDef[];
    visibleJobs: JobDef[];
    colors: Map<string, JobColor>;
    sequenceNumbers: ReadonlyMap<string, number>;
    selectedJobId: string | null;
    filters: JobFilters;
    /** A save is in flight; switching jobs now would be overwritten when it lands. */
    busy: boolean;
    onFiltersChange: (update: (filters: JobFilters) => JobFilters) => void;
    onSelect: (job: JobDef) => void;
}) {
    const rows = visibleJobs.slice(0, MAX_ROWS);
    const hidden = visibleJobs.length - rows.length;
    const openCount = jobs.filter((job) => job.backlogStatus === "open").length;
    const filtersActive =
        filters.query.trim() !== "" ||
        filters.status !== "Active" ||
        filters.machineId !== "All";

    // Clearing returns the status filter to Active rather than to "show
    // everything": the backlog is the default view, not an applied narrowing.
    function clearFilters() {
        onFiltersChange((current) => ({
            ...current,
            query: "",
            status: "Active",
            machineId: "All",
        }));
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>
                    Job backlog
                    <HeaderCount label={`${openCount} open ${openCount === 1 ? "job" : "jobs"}`}>{openCount}</HeaderCount>
                </CardTitle>
                <CardAction>
                    <PanelControls />
                </CardAction>
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
                        aria-label="Filter by archived state"
                        className="w-40"
                        value={filters.status}
                        onChange={(value) =>
                            onFiltersChange((current) => ({
                                ...current,
                                status: value as JobFilters["status"],
                            }))
                        }
                    >
                        <SelectTrigger />
                        <SelectContent>
                            {STATUS_FILTERS.map((option) => (
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
                    items={rows}
                    // A save reopens the editor on the job it wrote, so a switch
                    // started mid-flight would be silently undone when it lands.
                    disabledKeys={busy ? rows.map((job) => job.id) : []}
                    selectedKeys={selectedJobId ? new Set([selectedJobId]) : new Set()}
                    onSelectionChange={(keys) => {
                        if (keys === "all") return;
                        const [first] = Array.from(keys);
                        const job = rows.find((candidate) => candidate.id === first);
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
                        const backlogStatus = job.backlogStatus ?? "archived";
                        const isOpen = backlogStatus === "open";
                        return (
                            <GridListItem
                                id={job.id}
                                textValue={`Job ${sequence ?? ""} ${job.name}${isOpen ? "" : ` (${backlogStatus})`}`}
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
                                        {!isOpen && (
                                            <Badge intent="secondary">
                                                {backlogStatus === "done"
                                                    ? "Done"
                                                    : backlogStatus[0]?.toUpperCase() + backlogStatus.slice(1)}
                                            </Badge>
                                        )}
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

                {hidden > 0 && (
                    <p className="mt-3 text-center text-muted-fg text-xs" role="status">
                        {hidden} more {hidden === 1 ? "job is" : "jobs are"} not shown. Search or
                        filter to narrow the backlog.
                    </p>
                )}
            </CardContent>
        </Card>
    );
}
