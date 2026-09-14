import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MachineRow } from "../model";

/** Presentational inventory list; the connected screen owns filtering and selection intent. */
export function MachineInventoryList({
    rows,
    selectedId,
    onSelect,
}: {
    rows: MachineRow[];
    selectedId: string | null;
    onSelect: (id: string) => void;
}) {
    return (
        <ul className="mt-5 space-y-2">
            {rows.map((machine) => (
                <li key={machine.id}>
                    <Button
                        intent={machine.id === selectedId ? "primary" : "outline"}
                        className="h-auto w-full justify-start px-3 py-2.5 text-left"
                        onPress={() => onSelect(machine.id)}
                    >
                        <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold">{machine.name}</span>
                            <span className="block truncate text-xs opacity-75">{machine.categoryLabel} · {machine.id}</span>
                        </span>
                        <Badge intent={machine.active ? "success" : "secondary"}>{machine.statusLabel}</Badge>
                    </Button>
                </li>
            ))}
        </ul>
    );
}
