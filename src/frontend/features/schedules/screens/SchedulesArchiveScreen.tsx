"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageMessage } from "@/core/feedback/PageMessage";
import { reportMutationError } from "@/core/feedback/reportMutationError";
import { ApiError } from "@/core/http/client";
import { errorMessage } from "@/core/http/errors";
import { ManagerPageState } from "@/core/shell/ManagerPageState";
import { ManagerShell } from "@/core/shell/ManagerShell";
import { timelineToPlan } from "@/domains/scheduling/timeline";
import { useArchiveSchedule, useScheduleSummaries, useScheduleTimeline } from "@/features/schedules/data/queries";
import {
    isFilterActive,
    shortScheduleId,
    sortScheduleRows,
    toScheduleRow,
    type ScheduleSortKey
} from "@/features/schedules/model/archive";
import { ScheduleDetailPane } from "@/features/schedules/ui/ScheduleDetailPane";
import { ScheduleInventoryPanel } from "@/features/schedules/ui/ScheduleInventoryPanel";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useMemo, useState } from "react";
import { toast } from "sonner";

/**
 * The schedule archive.
 *
 * Schedules are produced by the Planner, so this page only reads them: it is
 * the record of past runs a manager can browse, confirm context from, and jump
 * into the simulation from. The one mutation is archiving — hide a run from
 * the default list without deleting history.
 *
 * Filters and sort are client-side over `GET /api/v1/schedules`; the detail
 * pane reads the same timeline endpoint the Planner and Simulation pages use.
 */

type StatusFilter = "all" | "confirmed" | "draft" | "archived";
type StrategyFilter = "any" | "resched" | "exact";

export default function SchedulesPage() {
    const schedulesQuery = useScheduleSummaries();
    const archiveSchedule = useArchiveSchedule();

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
    const [strategyFilter, setStrategyFilter] = useState<StrategyFilter>("any");
    const [sort, setSort] = useState<ScheduleSortKey>("newest");

    const schedules = useMemo(() => schedulesQuery.data ?? [], [schedulesQuery.data]);
    const rows = useMemo(() => schedules.map(toScheduleRow), [schedules]);

    const filteredRows = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const matches = rows.filter((row) => {
            if (
                needle &&
                !row.id.toLowerCase().includes(needle) &&
                !row.strategy.toLowerCase().includes(needle)
            ) {
                return false;
            }
            // "All statuses" (the default view) hides archived runs; picking
            // Archived shows only those. The total counts everything either way.
            if (statusFilter === "all" ? row.status === "archived" : row.status !== statusFilter) {
                return false;
            }
            if (strategyFilter !== "any" && row.strategy.toLowerCase() !== strategyFilter) return false;
            return true;
        });
        return sortScheduleRows(matches, sort);
    }, [query, rows, sort, statusFilter, strategyFilter]);

    // A selection survives refetching and filtering unless the schedule is no
    // longer visible — then the first visible row takes over, so the pane is
    // never empty while the list has something to show.
    const effectiveSelectedId =
        filteredRows.some((row) => row.id === selectedId)
            ? selectedId
            : filteredRows[0]?.id ?? null;

    const selected = rows.find((row) => row.id === effectiveSelectedId) ?? null;
    const timelineQuery = useScheduleTimeline(effectiveSelectedId);
    const plan = useMemo(
        () => (timelineQuery.data ? timelineToPlan(timelineQuery.data) : null),
        [timelineQuery.data],
    );

    function clearFilters() {
        setQuery("");
        setStatusFilter("all");
        setStrategyFilter("any");
    }

    async function toggleArchive() {
        if (!selected || archiveSchedule.isPending || selected.status === "confirmed") return;
        // `isArchived` reads the schedule's current state; the mutation takes the
        // state we want it to *become*, hence the inversion below.
        const isArchived = selected.status === "archived";
        try {
            await archiveSchedule.mutateAsync({ id: selected.id, archived: !isArchived });
            toast.success(
                `${shortScheduleId(selected.id)} ${isArchived ? "restored to the list" : "archived"}.`,
            );
        } catch (error) {
            reportMutationError(error);
        }
    }

    if (schedulesQuery.isPending) {
        return <ManagerPageState title="Loading schedules…">Reading the archive from the API.</ManagerPageState>;
    }
    if (schedulesQuery.error instanceof ApiError && schedulesQuery.error.isForbidden) {
        return (
            <ManagerPageState title="This needs a manager account">
                Browsing schedules is restricted to managers.
            </ManagerPageState>
        );
    }
    if (schedulesQuery.error) {
        return (
            <ManagerPageState title="Could not load schedules" error>
                <p>{errorMessage(schedulesQuery.error)}</p>
                <Button
                    intent="outline"
                    size="sm"
                    className="mt-3"
                    onPress={() => void schedulesQuery.refetch()}
                >
                    <ArrowPathIcon /> Try again
                </Button>
            </ManagerPageState>
        );
    }

    return (
        <ManagerShell>
            <main className="grid flex-1 gap-5 p-5 xl:grid-cols-[minmax(280px,0.8fr)_2fr]">
                <ScheduleInventoryPanel
                    total={schedules.length}
                    rows={filteredRows}
                    selectedId={effectiveSelectedId}
                    query={query}
                    statusFilter={statusFilter}
                    strategyFilter={strategyFilter}
                    sort={sort}
                    filterActive={isFilterActive(statusFilter, strategyFilter, query)}
                    onQueryChange={setQuery}
                    onStatusFilterChange={setStatusFilter}
                    onStrategyFilterChange={setStrategyFilter}
                    onSortChange={setSort}
                    onClearFilters={clearFilters}
                    onSelect={setSelectedId}
                />
                {selected ? (
                    <ScheduleDetailPane
                        schedule={selected}
                        plan={plan}
                        archiving={archiveSchedule.isPending}
                        onToggleArchive={() => void toggleArchive()}
                    />
                ) : (
                    // Inline card rather than ManagerPageState, which would nest a
                    // second ManagerShell (and so a second topbar) inside the grid.
                    <Card className="min-w-0">
                        <CardContent className="flex h-full items-center justify-center">
                            <PageMessage title="No schedule selected" tone="info">
                                <p>
                                    {rows.length === 0
                                        ? "No schedules exist yet — generate one on the Planner page."
                                        : "No schedules match these filters. Clear them to see the archive."}
                                </p>
                            </PageMessage>
                        </CardContent>
                    </Card>
                )}
            </main>
        </ManagerShell>
    );
}
