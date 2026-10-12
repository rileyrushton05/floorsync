"use client";

import { Button, buttonStyles } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { Note } from "@/components/ui/note";
import { useAuth } from "@/core/auth/AuthProvider";
import { PageMessage } from "@/core/feedback/PageMessage";
import { reportMutationError } from "@/core/feedback/reportMutationError";
import { ApiError } from "@/core/http/client";
import { errorMessage } from "@/core/http/errors";
import { ManagerPageState } from "@/core/shell/ManagerPageState";
import { ManagerShell } from "@/core/shell/ManagerShell";
import { SidePane, SidePaneLayout, SidePaneMain } from "@/core/shell/SidePanes";
import { timelineToPlan } from "@/domains/scheduling/timeline";
import { useDeleteSchedule, useScheduleSummaries, useScheduleTimeline, useUpdateSchedule } from "@/features/schedules/data/queries";
import {
    isFilterActive,
    matchesScheduleQuery,
    scheduleDisplayName,
    sortScheduleRows,
    strategyFamily,
    toScheduleRow,
    type ScheduleSortKey
} from "@/features/schedules/model/archive";
import { DeleteScheduleDialog } from "@/features/schedules/ui/DeleteScheduleDialog";
import { RenameScheduleDialog } from "@/features/schedules/ui/RenameScheduleDialog";
import { ScheduleDetailPane } from "@/features/schedules/ui/ScheduleDetailPane";
import {
    ScheduleInventoryPanel,
    type ScheduleStatusFilter,
    type ScheduleStrategyFilter,
} from "@/features/schedules/ui/ScheduleInventoryPanel";
import { ArrowPathIcon, PlusIcon } from "@heroicons/react/24/outline";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { toast } from "sonner";

/** How long the delete dialog's zoom-out runs before it unmounts, in ms. */
const CLOSE_MS = 150;

/**
 * Every schedule, and where each one is in its life.
 *
 * Schedules are made on the Planner ("New schedule" goes there), so this page
 * browses them: rename, confirm, withdraw, restore, delete a draft, and jump
 * into the simulation or back into the Planner from here.
 *
 * Filters and sort are client-side over `GET /api/v1/schedules`; the detail
 * pane reads the same timeline endpoint the Planner and Simulation pages use.
 */
export default function SchedulesPage() {
    return (
        <Suspense>
            <SchedulesPageInner />
        </Suspense>
    );
}

function SchedulesPageInner() {
    const { user } = useAuth();
    const schedulesQuery = useScheduleSummaries();
    const updateSchedule = useUpdateSchedule();
    const deleteSchedule = useDeleteSchedule();

    // A job record, or the Planner after a save, can link straight to one
    // schedule. Once the manager picks a schedule here, their choice takes
    // precedence until they leave the page.
    const linkedScheduleId = useSearchParams().get("schedule");
    const [userSelectedId, setUserSelectedId] = useState<string | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleteClosing, setDeleteClosing] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [query, setQuery] = useState("");
    const [statusFilter, setStatusFilter] = useState<ScheduleStatusFilter>("all");
    const [strategyFilter, setStrategyFilter] = useState<ScheduleStrategyFilter>("any");
    const [sort, setSort] = useState<ScheduleSortKey>("newest");

    const schedules = useMemo(() => schedulesQuery.data ?? [], [schedulesQuery.data]);
    const rows = useMemo(() => schedules.map(toScheduleRow), [schedules]);

    const filteredRows = useMemo(() => {
        const matches = rows.filter((row) => {
            if (!matchesScheduleQuery(row, query)) return false;
            if (statusFilter !== "all" && row.status !== statusFilter) return false;
            if (strategyFilter !== "any" && strategyFamily(row.strategy) !== strategyFilter) return false;
            return true;
        });
        return sortScheduleRows(matches, sort);
    }, [query, rows, sort, statusFilter, strategyFilter]);

    // A selection survives refetching and filtering unless the schedule is no
    // longer visible; then the first visible row takes over, so the pane is
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

    // The API reports only the confirming user's id, and there is no user
    // directory to resolve it against, so name the one person we do know.
    const confirmedByLabel =
        selected?.confirmedByUserId == null
            ? "–"
            : selected.confirmedByUserId === user?.id
                ? `You (${user.name})`
                : "Another manager";

    function clearFilters() {
        setQuery("");
        setStatusFilter("all");
        setStrategyFilter("any");
    }

    async function changeStatus(status: "confirmed" | "discarded") {
        if (!selected || updateSchedule.isPending) return;
        const label = `“${scheduleDisplayName(selected)}”`;
        try {
            await updateSchedule.mutateAsync({ id: selected.id, status });
            toast.success(
                status === "discarded"
                    ? `${label} withdrawn.`
                    : selected.status === "discarded"
                        ? `${label} restored.`
                        : `${label} confirmed. It can now be run in the simulation.`,
            );
        } catch (error) {
            reportMutationError(error);
        }
    }

    async function rename(name: string) {
        if (!selected || updateSchedule.isPending) return;
        try {
            await updateSchedule.mutateAsync({ id: selected.id, name });
            setRenaming(false);
            toast.success(`Renamed to “${name}”.`);
        } catch (error) {
            reportMutationError(error);
        }
    }

    function dismissDelete() {
        if (deleteClosing) return;
        setDeleteClosing(true);
        setTimeout(() => {
            setConfirmDelete(false);
            setDeleteClosing(false);
        }, CLOSE_MS);
    }

    async function remove() {
        if (!selected || deleteSchedule.isPending) return;
        const label = `“${scheduleDisplayName(selected)}”`;
        try {
            await deleteSchedule.mutateAsync({ id: selected.id });
            setConfirmDelete(false);
            setUserSelectedId(null);
            toast.success(`${label} deleted.`);
        } catch (error) {
            // The dialog stays open so the manager can read the API detail and retry.
            reportMutationError(error);
        }
    }

    const newScheduleLink = (
        <Link href="/manager/planner" className={buttonStyles()}>
            <PlusIcon /> New schedule
        </Link>
    );

    if (schedulesQuery.error instanceof ApiError && schedulesQuery.error.isForbidden) {
        return (
            <ManagerPageState title="This needs a manager account">
                Browsing schedules is restricted to managers.
            </ManagerPageState>
        );
    }
    // A failed background refresh must not take the screen away: only a load
    // that never produced anything is a page-level error.
    if (schedulesQuery.error && !schedulesQuery.data) {
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
    if (schedulesQuery.isPending) {
        return <ManagerPageState title="Loading schedules…">Reading schedule history from the API.</ManagerPageState>;
    }

    return (
        <ManagerShell actions={newScheduleLink}>
            <SidePaneLayout>
                <SidePane id="schedules.inventory" side="left" label="Schedules" grow={0.8} minWidth={280}>
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
                </SidePane>
                <SidePaneMain grow={2}>
                    <div className="flex min-w-0 flex-col gap-3">
                        {schedulesQuery.error && (
                            <Note intent="warning" role="status">
                                Showing the last schedules that loaded. Could not refresh: {errorMessage(schedulesQuery.error)}
                            </Note>
                        )}
                        {selected ? (
                            <ScheduleDetailPane
                                schedule={selected}
                                plan={plan}
                                planLoading={timelineQuery.isPending}
                                planError={timelineQuery.error ? errorMessage(timelineQuery.error) : null}
                                confirmedByLabel={confirmedByLabel}
                                updating={updateSchedule.isPending}
                                deleting={deleteSchedule.isPending}
                                onRename={() => setRenaming(true)}
                                onConfirm={() => void changeStatus("confirmed")}
                                onWithdraw={() => void changeStatus("discarded")}
                                onRestore={() => void changeStatus("confirmed")}
                                onDelete={() => setConfirmDelete(true)}
                            />
                        ) : (
                            // Inline card rather than ManagerPageState, which would nest a
                            // second ManagerShell (and so a second topbar) inside the grid.
                            <Card className="min-h-full min-w-0">
                                <CardContent className="flex h-full flex-col items-center justify-center gap-4">
                                    <PageMessage title={rows.length === 0 ? "No schedules yet" : "No schedule selected"} tone="info">
                                        <p>
                                            {rows.length === 0
                                                ? "Create a schedule: pick the open jobs to plan, generate it, then name and save it."
                                                : "No schedules match these filters. Clear them to see every schedule."}
                                        </p>
                                    </PageMessage>
                                    {rows.length === 0 ? newScheduleLink : (
                                        <Button intent="outline" onPress={clearFilters}>Clear filters</Button>
                                    )}
                                </CardContent>
                            </Card>
                        )}
                    </div>
                </SidePaneMain>
            </SidePaneLayout>

            {confirmDelete && selected && (
                <DeleteScheduleDialog
                    scheduleLabel={`“${scheduleDisplayName(selected)}”`}
                    closing={deleteClosing}
                    deleting={deleteSchedule.isPending}
                    onConfirm={() => void remove()}
                    onDismiss={dismissDelete}
                />
            )}
            {renaming && selected && (
                <RenameScheduleDialog
                    currentName={selected.name}
                    saving={updateSchedule.isPending}
                    onSave={(name) => void rename(name)}
                    onDismiss={() => setRenaming(false)}
                />
            )}
        </ManagerShell>
    );
}
