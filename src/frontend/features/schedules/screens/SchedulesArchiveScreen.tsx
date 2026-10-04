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
import { useDeleteSchedule, useScheduleSummaries, useScheduleTimeline, useUpdateScheduleStatus } from "@/features/schedules/data/queries";
import {
    isFilterActive,
    shortScheduleId,
    sortScheduleRows,
    toScheduleRow,
    type ScheduleSortKey
} from "@/features/schedules/model/archive";
import { DeleteScheduleDialog } from "@/features/schedules/ui/DeleteScheduleDialog";
import { ScheduleDetailPane } from "@/features/schedules/ui/ScheduleDetailPane";
import { ScheduleInventoryPanel } from "@/features/schedules/ui/ScheduleInventoryPanel";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";

/**
 * Schedule history and lifecycle controls.
 *
 * Schedules are produced by the Planner, so this page only reads them: it is
 * the record of past runs a manager can browse, confirm, withdraw, restore,
 * and jump into the simulation from.
 *
 * Filters and sort are client-side over `GET /api/v1/schedules`; the detail
 * pane reads the same timeline endpoint the Planner and Simulation pages use.
 */

type StatusFilter = "all" | "confirmed" | "draft" | "discarded";
type StrategyFilter = "any" | "resched" | "exact";

export default function SchedulesPage() {
    return (
        <Suspense>
            <SchedulesPageInner />
        </Suspense>
    );
}

function SchedulesPageInner() {
    const schedulesQuery = useScheduleSummaries();
    const updateScheduleStatus = useUpdateScheduleStatus();
    const deleteSchedule = useDeleteSchedule();

    // A job record can link straight to the confirmed schedule that plans it.
    // Once the manager picks a schedule here, their choice takes precedence
    // until they leave the page.
    const linkedScheduleId = useSearchParams().get("schedule");
    const [userSelectedId, setUserSelectedId] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
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
            if (statusFilter !== "all" && row.status !== statusFilter) {
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
    const selectedOverrideId = userSelectedId ?? linkedScheduleId;
    const effectiveSelectedId =
        filteredRows.some((row) => row.id === selectedOverrideId)
            ? selectedOverrideId
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

    async function changeStatus(status: "confirmed" | "discarded") {
        if (!selected || updateScheduleStatus.isPending) return;
        try {
            await updateScheduleStatus.mutateAsync({ id: selected.id, status });
            toast.success(
                status === "discarded"
                    ? `${shortScheduleId(selected.id)} withdrawn.`
                    : selected.status === "discarded"
                        ? `${shortScheduleId(selected.id)} restored.`
                        : `${shortScheduleId(selected.id)} confirmed.`,
            );
        } catch (error) {
            reportMutationError(error);
        }
    }

    async function remove() {
        if (!selected || deleteSchedule.isPending) return;
        try {
            await deleteSchedule.mutateAsync({ id: selected.id });
            setConfirmDelete(false);
            setUserSelectedId(null);
            toast.success(`${shortScheduleId(selected.id)} deleted.`);
        } catch (error) {
            // The dialog stays open so the manager can read the API detail and retry.
            reportMutationError(error);
        }
    }

    if (schedulesQuery.isPending) {
        return <ManagerPageState title="Loading schedules…">Reading schedule history from the API.</ManagerPageState>;
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
                    onSelect={setUserSelectedId}
                />
                {selected ? (
                    <ScheduleDetailPane
                        schedule={selected}
                        plan={plan}
                        updating={updateScheduleStatus.isPending}
                        deleting={deleteSchedule.isPending}
                        onConfirm={() => void changeStatus("confirmed")}
                        onWithdraw={() => void changeStatus("discarded")}
                        onRestore={() => void changeStatus("confirmed")}
                        onDelete={() => setConfirmDelete(true)}
                    />
                ) : (
                    // Inline card rather than ManagerPageState, which would nest a
                    // second ManagerShell (and so a second topbar) inside the grid.
                    <Card className="min-w-0">
                        <CardContent className="flex h-full items-center justify-center">
                            <PageMessage title="No schedule selected" tone="info">
                                <p>
                                    {rows.length === 0
                                        ? "No schedules exist yet. Generate one on the Planner page."
                                        : "No schedules match these filters. Clear them to see schedule history."}
                                </p>
                            </PageMessage>
                        </CardContent>
                    </Card>
                )}
                {confirmDelete && selected && (
                    <DeleteScheduleDialog
                        scheduleLabel={`“${shortScheduleId(selected.id)}”`}
                        closing={false}
                        onConfirm={() => void remove()}
                        onDismiss={() => setConfirmDelete(false)}
                    />
                )}
            </main>
        </ManagerShell>
    );
}
