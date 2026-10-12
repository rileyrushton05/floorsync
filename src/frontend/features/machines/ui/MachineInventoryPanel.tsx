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
import { InfoTooltip } from "@/components/ui/tooltip";
import { ChevronRightIcon, MagnifyingGlassIcon, TagIcon, XMarkIcon } from "@heroicons/react/24/outline";
import {
    ANY_CATEGORY,
    CATEGORIES_IN_USE_HINT,
    INITIAL_MACHINE_FILTERS,
    NO_CATEGORY,
    SORT_OPTIONS,
    STATUS_FILTERS,
    filtersActive,
    type MachineCategory,
    type MachineFilters,
    type MachineRow,
} from "../model/machine";

/**
 * The inventory: search, filters, sort and the selectable machine list.
 *
 * Presentational — it reports every change through `onFiltersChange` and
 * `onSelect`, and never decides which machine is open.
 */
export function MachineInventoryPanel({
    total,
    activeCount,
    rows,
    categories,
    selectedId,
    filters,
    busy,
    onFiltersChange,
    onSelect,
}: {
    total: number;
    activeCount: number;
    /** Already filtered and sorted. */
    rows: MachineRow[];
    categories: MachineCategory[];
    selectedId: string | null;
    filters: MachineFilters;
    /** A write is in flight; switching machines now would be overwritten when it lands. */
    busy: boolean;
    onFiltersChange: (update: (filters: MachineFilters) => MachineFilters) => void;
    onSelect: (id: string) => void;
}) {
    const narrowed = filtersActive(filters);

    return (
        <Card>
            <CardHeader>
                <CardTitle>
                    Machine inventory
                    <HeaderCount label={`${activeCount} active ${activeCount === 1 ? "machine" : "machines"}`}>
                        {activeCount}
                    </HeaderCount>
                </CardTitle>
            </CardHeader>
            <CardContent>
                <TextField
                    aria-label="Search machines by name or category"
                    value={filters.query}
                    onChange={(query) => onFiltersChange((current) => ({ ...current, query }))}
                >
                    <InputGroup>
                        <MagnifyingGlassIcon data-slot="icon" />
                        <Input placeholder="Search name or category…" autoComplete="off" />
                    </InputGroup>
                </TextField>

                <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold text-muted-fg text-xs uppercase tracking-[0.05em]">
                        Filter
                    </span>
                    {narrowed && (
                        <Button
                            intent="plain"
                            size="sm"
                            onPress={() => onFiltersChange((current) => ({ ...INITIAL_MACHINE_FILTERS, sort: current.sort }))}
                        >
                            <XMarkIcon /> Clear
                        </Button>
                    )}
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Select
                        aria-label="Filter by status"
                        className="w-40"
                        value={filters.status}
                        onChange={(value) =>
                            onFiltersChange((current) => ({ ...current, status: value as MachineFilters["status"] }))
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

                    <Select
                        aria-label="Filter by category"
                        className="w-44"
                        value={filters.categoryId}
                        onChange={(value) => onFiltersChange((current) => ({ ...current, categoryId: String(value) }))}
                    >
                        <SelectTrigger />
                        <SelectContent>
                            <SelectItem id={ANY_CATEGORY} textValue="Any category">Any category</SelectItem>
                            <SelectItem id={NO_CATEGORY} textValue="No category">No category</SelectItem>
                            {categories.map((category) => (
                                <SelectItem key={category.id} id={category.id} textValue={category.name}>
                                    {category.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <InfoTooltip label="Which categories are listed">{CATEGORIES_IN_USE_HINT}</InfoTooltip>
                </div>

                <Separator className="my-5" />

                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Select
                        aria-label="Sort machines"
                        className="w-44"
                        value={filters.sort}
                        onChange={(value) =>
                            onFiltersChange((current) => ({ ...current, sort: value as MachineFilters["sort"] }))
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
                        Showing {rows.length} of {total}
                    </Badge>
                </div>

                <GridList
                    aria-label="Machine inventory"
                    selectionMode="single"
                    selectionBehavior="replace"
                    items={rows}
                    // A save reopens the editor on the machine it wrote, so a
                    // switch started mid-flight would be silently undone.
                    disabledKeys={busy ? rows.map((row) => row.id) : []}
                    selectedKeys={selectedId ? new Set([selectedId]) : new Set()}
                    onSelectionChange={(keys) => {
                        if (keys === "all") return;
                        const [first] = Array.from(keys);
                        if (typeof first === "string") onSelect(first);
                    }}
                    renderEmptyState={() => (
                        <GridListEmptyState className="text-center text-muted-fg text-sm">
                            {narrowed
                                ? "No machines match your search or filters."
                                : "No machines yet. Add one to get started."}
                        </GridListEmptyState>
                    )}
                >
                    {(row) => (
                        <GridListItem
                            id={row.id}
                            textValue={`${row.name}, ${row.categoryLabel}, ${row.statusLabel}`}
                            className="items-start"
                        >
                            <span className="flex min-w-0 flex-col gap-0.5">
                                <span className="flex items-center gap-2">
                                    <GridListLabel className="truncate text-sm">{row.name}</GridListLabel>
                                    {!row.active && <Badge intent="secondary">Inactive</Badge>}
                                </span>
                                <GridListDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                                    {/* A chip, so machines can be scanned by category at a
                                        glance; an uncategorised one stays quiet text. */}
                                    {row.categoryId !== null ? (
                                        <Badge intent="info" isCircle={false}>
                                            <TagIcon data-slot="icon" />
                                            {row.categoryLabel}
                                        </Badge>
                                    ) : (
                                        <span className="italic">{row.categoryLabel}</span>
                                    )}
                                    {row.openJobCount !== null && (
                                        <span>
                                            {row.openJobCount} open {row.openJobCount === 1 ? "job" : "jobs"}
                                        </span>
                                    )}
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
