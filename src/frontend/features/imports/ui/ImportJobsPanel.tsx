import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HeaderCount } from "@/components/ui/header-count";
import { Input, InputGroup } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { PanelControls } from "@/core/panels/PanelChrome";
import { formatDuration } from "@/domains/scheduling/format";
import { JobGraphDiagram } from "@/domains/scheduling/ui/JobGraphDiagram";
import { ChevronRightIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { cn } from "cn";
import { useMemo, useState } from "react";
import { PRIORITY_LABELS, graphOperations, plural, type ImportJob } from "../model/import-report";
import { IssueList } from "./IssueList";

const PRIORITY_INTENT = { high: "danger", med: "secondary", low: "outline" } as const;

/**
 * Every job the file would add, searchable by name. A row expands to the job's
 * problems, its precedence graph and its operations with their machine options.
 *
 * Presentational — the screen owns the search and which rows are open.
 */
export function ImportJobsPanel({
    jobs,
    total,
    query,
    expanded,
    onQueryChange,
    onToggle,
}: {
    /** Already filtered by `query`. */
    jobs: readonly ImportJob[];
    total: number;
    query: string;
    /** Indexes, in the file, of the jobs that are open. */
    expanded: ReadonlySet<number>;
    onQueryChange: (query: string) => void;
    onToggle: (index: number) => void;
}) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>
                    Jobs in file
                    <HeaderCount label={plural(total, "job")}>{total}</HeaderCount>
                </CardTitle>
                <CardDescription>Open a job to see its operations, machines and the order they run in.</CardDescription>
                <CardAction>
                    <PanelControls />
                </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
                <TextField aria-label="Search jobs by name" value={query} onChange={onQueryChange}>
                    <InputGroup>
                        <MagnifyingGlassIcon data-slot="icon" />
                        <Input placeholder="Search jobs…" autoComplete="off" />
                    </InputGroup>
                </TextField>
                {jobs.length === 0 ? (
                    <p className="text-muted-fg text-sm">No job in the file matches “{query.trim()}”.</p>
                ) : (
                    <ul className="divide-y rounded-lg border">
                        {jobs.map((job) => (
                            <JobRow
                                key={job.index}
                                job={job}
                                open={expanded.has(job.index)}
                                onToggle={() => onToggle(job.index)}
                            />
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}

function JobRow({ job, open, onToggle }: { job: ImportJob; open: boolean; onToggle: () => void }) {
    const detailId = `import-job-${job.index}`;
    return (
        <li>
            <button
                type="button"
                aria-expanded={open}
                aria-controls={open ? detailId : undefined}
                onClick={onToggle}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm outline-hidden hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
                <ChevronRightIcon
                    aria-hidden
                    className={cn("size-4 shrink-0 text-muted-fg transition-transform", open && "rotate-90")}
                />
                <span className="min-w-0 flex-1 truncate font-medium" title={job.name}>
                    {job.name}
                </span>
                {job.issues.length > 0 && <Badge intent="danger">{plural(job.issues.length, "problem")}</Badge>}
                {job.warnings.length > 0 && <Badge intent="warning">{plural(job.warnings.length, "warning")}</Badge>}
                <Badge intent={PRIORITY_INTENT[job.priority]}>{PRIORITY_LABELS[job.priority]}</Badge>
                <span className="w-16 shrink-0 text-right text-muted-fg text-xs tabular-nums">
                    {plural(job.operations.length, "op")}
                </span>
            </button>
            {open && <JobDetail id={detailId} job={job} />}
        </li>
    );
}

function JobDetail({ id, job }: { id: string; job: ImportJob }) {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const operations = useMemo(() => graphOperations(job), [job]);
    const nameOf = (operationId: string) => job.operations[Number(operationId)]?.name ?? operationId;

    return (
        <div id={id} className="flex flex-col gap-4 border-t bg-muted/30 px-3 py-4">
            <IssueList title="Problems" issues={job.issues} intent="danger" />
            <IssueList title="Warnings" issues={job.warnings} intent="warning" />
            {/* The graph fills its parent's spare height, so it is given one. */}
            <div className="flex h-72 flex-col">
                <JobGraphDiagram operations={operations} selectedId={selectedId} onSelect={setSelectedId} />
            </div>
            <div className="overflow-x-auto rounded-lg border bg-bg">
                <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-left text-muted-fg text-xs">
                        <tr>
                            <th scope="col" className="px-3 py-2 font-medium">#</th>
                            <th scope="col" className="px-3 py-2 font-medium">Operation</th>
                            <th scope="col" className="px-3 py-2 font-medium">Waits for</th>
                            <th scope="col" className="px-3 py-2 font-medium">Machine options</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y">
                        {job.operations.map((operation, position) => (
                            <tr
                                key={operation.id}
                                className={cn("align-top", operation.id === selectedId && "bg-primary/10")}
                            >
                                <td className="px-3 py-2 text-muted-fg tabular-nums">{position + 1}</td>
                                <td className="px-3 py-2 font-medium">{operation.name}</td>
                                <td className="px-3 py-2 text-muted-fg">
                                    {operation.dependsOn.length === 0
                                        ? "Nothing"
                                        : operation.dependsOn.map(nameOf).join(", ")}
                                </td>
                                <td className="px-3 py-2">
                                    <ul className="flex flex-col gap-0.5">
                                        {operation.routes.map((route) => (
                                            <li key={route.machine} className="flex flex-wrap gap-x-2">
                                                <span>{route.machine}</span>
                                                <span className="text-muted-fg tabular-nums">
                                                    {formatDuration(route.duration)}
                                                    {route.energy !== null && ` · ${route.energy} kWh`}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
