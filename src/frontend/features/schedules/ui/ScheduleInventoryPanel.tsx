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
import { HeaderCount } from "@/components/ui/header-count";
import { Input, InputGroup } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { TextField } from "@/components/ui/text-field";
import { formatDuration } from "@/domains/scheduling/format";
import { ChevronRightIcon, MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import {
    formatCreatedAt,
    scheduleDisplayName,
    strategyLabel,
    type ScheduleRow,
    type ScheduleSortKey,
} from "../model/archive";
import { ScheduleStatusBadge } from "./ScheduleStatusBadge";

export type ScheduleStatusFilter = "all" | "confirmed" | "draft" | "discarded";
export type ScheduleStrategyFilter = "any" | "resched" | "exact";

const SORT_OPTIONS: { id: ScheduleSortKey; label: string }[] = [
    { id: "newest", label: "Newest first" },
    { id: "oldest", label: "Oldest first" },
    { id: "name", label: "Name (A–Z)" },
    { id: "makespan-asc", label: "Shortest makespan" },
    { id: "makespan-desc", label: "Longest makespan" },
];

/**
 * Left column of the Schedules page: search, status/strategy filters, sort and
 * the selectable list of schedules. Same chrome as the Machines inventory.
 *
 * Presentational: it reports every change through callbacks and never
 * decides which schedule is open.
 */
export function ScheduleInventoryPanel({
    total,
    rows,
    selectedId,
    query,
    statusFilter,
    strategyFilter,
    sort,
    filterActive,
    onQueryChange,
    onStatusFilterChange,
    onStrategyFilterChange,
    onSortChange,
    onClearFilters,
    onSelect,
}: {
    total: number;
    /** Already filtered and sorted. */
    rows: ScheduleRow[];
    selectedId: string | null;
    query: string;
    statusFilter: ScheduleStatusFilter;
    strategyFilter: ScheduleStrategyFilter;
    sort: ScheduleSortKey;
    filterActive: boolean;
    onQueryChange: (value: string) => void;
    onStatusFilterChange: (value: ScheduleStatusFilter) => void;
    onStrategyFilterChange: (value: ScheduleStrategyFilter) => void;
    onSortChange: (value: ScheduleSortKey) => void;
    onClearFilters: () => void;
    onSelect: (id: string) => void;
}) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>
                    Schedules
                    <HeaderCount label={`${total} ${total === 1 ? "schedule" : "schedules"}`}>{total}</HeaderCount>
                </CardTitle>
            </CardHeader>
            <CardContent>
                <TextField aria-label="Search schedules by name or strategy" value={query} onChange={onQueryChange}>
                    <InputGroup>
                        <MagnifyingGlassIcon data-slot="icon" />
                        <Input placeholder="Search name or strategy…" autoComplete="off" />
                    </InputGroup>
                </TextField>

                <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-muted-fg text-xs uppercase tracking-[0.05em]">
                        Filter
                    </span>
                    {filterActive && (
                        <Button intent="plain" size="sm" onPress={onClearFilters}>
                            <XMarkIcon /> Clear
                        </Button>
                    )}
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Select
                        aria-label="Filter by status"
                        className="w-40"
                        value={statusFilter}
                        onChange={(value) => onStatusFilterChange(value as ScheduleStatusFilter)}
                    >
                        <SelectTrigger />
                        <SelectContent>
                            <SelectItem id="all">All statuses</SelectItem>
                            <SelectItem id="confirmed">Confirmed</SelectItem>
                            <SelectItem id="draft">Draft</SelectItem>
                            <SelectItem id="discarded">Withdrawn</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select
                        aria-label="Filter by strategy"
                        className="w-40"
                        value={strategyFilter}
                        onChange={(value) => onStrategyFilterChange(value as ScheduleStrategyFilter)}
                    >
                        <SelectTrigger />
                        <SelectContent>
                            <SelectItem id="any">Any strategy</SelectItem>
                            <SelectItem id="resched">ReSched</SelectItem>
                            <SelectItem id="exact">Exact</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <Separator className="my-5" />

                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Select
                        aria-label="Sort schedules"
                        className="w-48"
                        value={sort}
                        onChange={(value) => onSortChange(value as ScheduleSortKey)}
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
                        Showing {rows.length} of {total}
                    </Badge>
                </div>

                <GridList
                    aria-label="Schedules"
                    selectionMode="single"
                    selectionBehavior="replace"
                    items={rows}
                    selectedKeys={selectedId ? new Set([selectedId]) : new Set()}
                    onSelectionChange={(keys) => {
                        if (keys === "all") return;
                        const [first] = Array.from(keys);
                        if (typeof first === "string") onSelect(first);
                    }}
                    renderEmptyState={() => (
                        <GridListEmptyState className="text-center text-muted-fg text-sm">
                            {filterActive
                                ? "No schedules match your search or filters."
                                : "No schedules yet. Create one to get started."}
                        </GridListEmptyState>
                    )}
                >
                    {(row) => (
                        <GridListItem
                            id={row.id}
                            textValue={`${scheduleDisplayName(row)}, ${row.status}, ${strategyLabel(row.strategy)}`}
                            className="items-start"
                        >
                            <span className="flex min-w-0 flex-col gap-0.5">
                                <span className="flex items-center gap-2">
                                    <GridListLabel
                                        className={`truncate text-sm ${row.name ? "" : "text-muted-fg italic"}`}
                                    >
                                        {scheduleDisplayName(row)}
                                    </GridListLabel>
                                    <ScheduleStatusBadge status={row.status} />
                                </span>
                                <GridListDescription className="text-xs">
                                    {strategyLabel(row.strategy)} · {formatCreatedAt(row.createdAt)}
                                </GridListDescription>
                                <GridListDescription className="text-xs">
                                    {row.opsCount === null ? "– ops" : `${row.opsCount} ops`}
                                    {" · "}
                                    {row.makespanMins === null ? "no makespan" : formatDuration(row.makespanMins)}
                                </GridListDescription>
                            </span>
                            <GridListSpacer />
                            <ChevronRightIcon
                                aria-hidden
                                className="size-4 shrink-0 text-muted-fg transition group-hover:translate-x-0.5 group-hover:text-fg"
                            />
                        </GridListItem>
                    )}
                </GridList>
            </CardContent>
        </Card>
    );
}
