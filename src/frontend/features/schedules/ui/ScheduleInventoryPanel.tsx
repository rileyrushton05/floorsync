import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HeaderCount } from "@/components/ui/header-count";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { TextField } from "@/components/ui/text-field";
import { formatDuration } from "@/domains/scheduling/format";
import { useMemo, useState } from "react";
import { formatCreatedAt, shortScheduleId, type ScheduleRow, type ScheduleSortKey } from "../model/archive";
import { ScheduleStatusBadge } from "./ScheduleStatusBadge";

/** How many rows show before the "+N more / Click to expand" affordance. */
const COLLAPSED_COUNT = 6;

/**
 * Left column of the Schedules page: search, status/strategy filters, sort and
 * the selectable inventory of past runs. Mirrors the Machines page's inventory
 * panel — same chrome, same spacing — with no way to create or edit anything.
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
    rows: ScheduleRow[];
    selectedId: string | null;
    query: string;
    statusFilter: "all" | "confirmed" | "draft" | "discarded";
    strategyFilter: "any" | "resched" | "exact";
    sort: ScheduleSortKey;
    filterActive: boolean;
    onQueryChange: (value: string) => void;
    onStatusFilterChange: (value: "all" | "confirmed" | "draft" | "discarded") => void;
    onStrategyFilterChange: (value: "any" | "resched" | "exact") => void;
    onSortChange: (value: ScheduleSortKey) => void;
    onClearFilters: () => void;
    onSelect: (id: string) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const visible = useMemo(
        () => (expanded ? rows : rows.slice(0, COLLAPSED_COUNT)),
        [expanded, rows],
    );
    const hidden = rows.length - visible.length;

    return (
        <Card>
            <CardHeader>
                <CardTitle>
                    Schedules
                    <HeaderCount label={`${total} ${total === 1 ? "schedule" : "schedules"}`}>{total}</HeaderCount>
                </CardTitle>
            </CardHeader>
            <CardContent>
                <TextField aria-label="Search schedules" value={query} onChange={onQueryChange}>
                    <Input placeholder="Search by ID or strategy…" autoComplete="off" />
                </TextField>

                <div className="mt-3 flex items-center justify-between">
                    <Label>Filter</Label>
                    {filterActive && (
                        <Button intent="plain" size="sm" className="h-auto p-0" onPress={onClearFilters}>
                            Clear
                        </Button>
                    )}
                </div>
                <div className="mt-1 grid grid-cols-2 gap-2">
                    <Select
                        aria-label="Filter by status"
                        value={statusFilter}
                        onChange={(value) => onStatusFilterChange(value as typeof statusFilter)}
                    >
                        <SelectTrigger />
                        <SelectContent>
                            <SelectItem id="all">All statuses</SelectItem>
                            <SelectItem id="confirmed">Confirmed</SelectItem>
                            <SelectItem id="draft">Draft</SelectItem>
                            <SelectItem id="discarded">Discarded</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select
                        aria-label="Filter by strategy"
                        value={strategyFilter}
                        onChange={(value) => onStrategyFilterChange(value as typeof strategyFilter)}
                    >
                        <SelectTrigger />
                        <SelectContent>
                            <SelectItem id="any">Any strategy</SelectItem>
                            <SelectItem id="resched">ReSched</SelectItem>
                            <SelectItem id="exact">Exact</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <Separator className="my-3" />

                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <span className="text-muted-fg text-sm">Sort:</span>
                        <Select
                            aria-label="Sort schedules"
                            value={sort}
                            onChange={(value) => onSortChange(value as ScheduleSortKey)}
                        >
                            <SelectTrigger />
                            <SelectContent>
                                <SelectItem id="newest">Newest first</SelectItem>
                                <SelectItem id="oldest">Oldest first</SelectItem>
                                <SelectItem id="makespan-asc">Makespan ↑</SelectItem>
                                <SelectItem id="makespan-desc">Makespan ↓</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <span className="shrink-0 text-muted-fg text-xs">
                        Showing {rows.length} of {total}
                    </span>
                </div>

                <ul className="mt-4 space-y-2">
                    {visible.map((row) => (
                        <li key={row.id}>
                            <Button
                                intent={row.id === selectedId ? "primary" : "outline"}
                                className="h-auto w-full justify-start px-3 py-2.5 text-left"
                                onPress={() => onSelect(row.id)}
                            >
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate font-semibold">{shortScheduleId(row.id)}</span>
                                    <span className="block truncate text-xs opacity-75">
                                        {row.strategy} · {formatCreatedAt(row.createdAt)}
                                    </span>
                                    <span className="block truncate text-xs opacity-75">
                                        {row.opsCount === null ? "– ops" : `${row.opsCount} ops`}
                                        {" · "}
                                        {row.makespanMins === null ? "no makespan" : formatDuration(row.makespanMins)}
                                    </span>
                                </span>
                                <ScheduleStatusBadge status={row.status} />
                            </Button>
                        </li>
                    ))}
                </ul>
                {rows.length === 0 && (
                    <p className="py-6 text-center text-muted-fg text-sm">No schedules match these filters.</p>
                )}

                {rows.length > COLLAPSED_COUNT && (
                    <div className="mt-3 text-center">
                        {hidden > 0 && (
                            <p className="text-muted-fg text-xs">+{hidden} more</p>
                        )}
                        <Button
                            intent="plain"
                            size="sm"
                            className="mt-1"
                            onPress={() => setExpanded((value) => !value)}
                        >
                            {expanded ? "Click to collapse" : "Click to expand"}
                        </Button>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
