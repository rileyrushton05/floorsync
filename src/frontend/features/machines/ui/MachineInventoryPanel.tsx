import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HeaderCount } from "@/components/ui/header-count";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import type { MachineRow } from "../model/machine";
import { MachineInventoryList } from "./MachineInventoryList";

export function MachineInventoryPanel({
    total,
    rows,
    selectedId,
    query,
    statusFilter,
    onQueryChange,
    onStatusFilterChange,
    onSelect,
}: {
    total: number;
    rows: MachineRow[];
    selectedId: string | null;
    query: string;
    statusFilter: "all" | "active" | "inactive";
    onQueryChange: (value: string) => void;
    onStatusFilterChange: (value: "all" | "active" | "inactive") => void;
    onSelect: (id: string) => void;
}) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>
                    Machine inventory
                    <HeaderCount label={`${total} ${total === 1 ? "machine" : "machines"}`}>{total}</HeaderCount>
                </CardTitle>
            </CardHeader>
            <CardContent>
                <TextField aria-label="Search machines" value={query} onChange={onQueryChange}>
                    <Input placeholder="Search name or ID…" autoComplete="off" />
                </TextField>
                <Select
                    aria-label="Filter machine status"
                    className="mt-3"
                    value={statusFilter}
                    onChange={(value) => onStatusFilterChange(value as typeof statusFilter)}
                >
                    <Label>Status</Label>
                    <SelectTrigger />
                    <SelectContent>
                        <SelectItem id="all">All machines</SelectItem>
                        <SelectItem id="active">Active</SelectItem>
                        <SelectItem id="inactive">Inactive</SelectItem>
                    </SelectContent>
                </Select>
                <MachineInventoryList rows={rows} selectedId={selectedId} onSelect={onSelect} />
                {rows.length === 0 && <p className="py-6 text-center text-muted-fg text-sm">No machines match these filters.</p>}
            </CardContent>
        </Card>
    );
}
