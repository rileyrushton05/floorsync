import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PanelControls } from "@/core/panels/PanelChrome";
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
import { TextField } from "@/components/ui/text-field";
import { formatDuration } from "@/domains/scheduling/format";
import { ChevronRightIcon, MagnifyingGlassIcon, SignalIcon } from "@heroicons/react/24/outline";
import { formatCreatedAt, scheduleDisplayName, strategyLabel, type ScheduleRow } from "../model/archive";

/**
 * Left column of the Simulation page: the confirmed schedules that can be
 * played, searchable, with the one operators are following marked. Same
 * chrome as the Schedules and Machines inventories.
 *
 * Presentational: it reports the search and selection through callbacks and
 * never decides which schedule is open.
 */
export function SimulationSchedulePanel({
    total,
    rows,
    selectedId,
    operatorScheduleId,
    query,
    onQueryChange,
    onSelect,
}: {
    total: number;
    /** Already filtered, confirmed schedules only. */
    rows: ScheduleRow[];
    selectedId: string | null;
    /** The schedule whose simulation operators' screens follow, if any. */
    operatorScheduleId: string | null;
    query: string;
    onQueryChange: (value: string) => void;
    onSelect: (id: string) => void;
}) {
    return (
        <Card className="min-w-0">
            <CardHeader>
                <CardTitle>
                    Confirmed schedules
                    <HeaderCount label={`${total} confirmed ${total === 1 ? "schedule" : "schedules"}`}>{total}</HeaderCount>
                </CardTitle>
                <CardAction>
                    <PanelControls />
                </CardAction>
            </CardHeader>
            <CardContent>
                <TextField aria-label="Search confirmed schedules by name or strategy" value={query} onChange={onQueryChange}>
                    <InputGroup>
                        <MagnifyingGlassIcon data-slot="icon" />
                        <Input placeholder="Search name or strategy…" autoComplete="off" />
                    </InputGroup>
                </TextField>

                <p className="mt-3 mb-3 text-muted-fg text-xs">
                    Only confirmed schedules can be played. Operator screens follow one running or
                    paused simulation, marked <SignalIcon aria-hidden className="inline size-3.5 align-[-2px]" /> On floor.
                </p>

                {/* Capped on narrow screens, where this list sits above the
                    playback and a long history would push it off screen. */}
                <div className="scroll-rail max-h-[40dvh] overflow-y-auto xl:max-h-none xl:overflow-visible">
                    <GridList
                        aria-label="Confirmed schedules"
                        selectionMode="single"
                        selectionBehavior="replace"
                        disallowEmptySelection
                        items={rows}
                        // Rows render from more than the item, so they must
                        // re-render when the followed schedule changes.
                        dependencies={[operatorScheduleId]}
                        selectedKeys={selectedId ? new Set([selectedId]) : new Set()}
                        onSelectionChange={(keys) => {
                            if (keys === "all") return;
                            const [first] = Array.from(keys);
                            if (typeof first === "string") onSelect(first);
                        }}
                        renderEmptyState={() => (
                            <GridListEmptyState className="text-center text-muted-fg text-sm">
                                No confirmed schedules match your search.
                            </GridListEmptyState>
                        )}
                    >
                        {(row) => (
                            <GridListItem
                                id={row.id}
                                textValue={`${scheduleDisplayName(row)}, ${strategyLabel(row.strategy)}${row.id === operatorScheduleId ? ", followed by operators" : ""}`}
                                className="items-start"
                            >
                                <span className="flex min-w-0 flex-col gap-0.5">
                                    <span className="flex min-w-0 items-center gap-2">
                                        <GridListLabel className={`truncate text-sm ${row.name ? "" : "text-muted-fg italic"}`}>
                                            {scheduleDisplayName(row)}
                                        </GridListLabel>
                                        {row.id === operatorScheduleId && (
                                            <Badge intent="info" className="shrink-0">
                                                <SignalIcon data-slot="icon" aria-hidden /> On floor
                                            </Badge>
                                        )}
                                    </span>
                                    <GridListDescription className="text-xs">
                                        {strategyLabel(row.strategy)}
                                        {" · "}
                                        {row.makespanMins === null ? "no makespan" : formatDuration(row.makespanMins)}
                                        {row.opsCount === null ? "" : ` · ${row.opsCount} ops`}
                                    </GridListDescription>
                                    <GridListDescription className="text-xs">
                                        Confirmed {formatCreatedAt(row.confirmedAt ?? row.createdAt)}
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
                </div>
            </CardContent>
        </Card>
    );
}
