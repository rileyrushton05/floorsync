import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/** One operation this step could be made to wait on. */
export interface PredecessorOption {
    id: string;
    name: string;
    /** Choosing it would close a loop, so it is offered but not selectable. */
    disabled: boolean;
}

/**
 * What one step waits on, as a multi-select of the job's other steps.
 *
 * Multi-select is the whole point: two steps can both wait on the same earlier
 * one, and one step can wait on several. Shared by the operation card and the
 * graph's side panel so the two cannot drift apart.
 */
export function PredecessorPicker({
    label,
    options,
    selected,
    onChange,
}: {
    /** How this step is named in the control's accessible label. */
    label: string;
    options: PredecessorOption[];
    selected: string[];
    onChange: (predecessorIds: string[]) => void;
}) {
    if (options.length === 0) return null;

    return (
        <div className="rounded-lg border bg-muted p-3">
            <span className="font-semibold text-muted-fg text-xs uppercase tracking-[0.05em]">
                Runs after
            </span>
            <p className="mt-0.5 text-muted-fg text-xs">
                {selected.length === 0
                    ? "Nothing — this step can start immediately."
                    : "Every step selected here must finish first."}
            </p>
            <ToggleGroup
                aria-label={`Steps ${label} runs after`}
                className="mt-2 flex-wrap"
                size="xs"
                selectionMode="multiple"
                selectedKeys={new Set(selected)}
                onSelectionChange={(keys) => onChange(Array.from(keys).map(String))}
            >
                {options.map((option) => (
                    <ToggleGroupItem
                        key={option.id}
                        id={option.id}
                        // A disabled option already waits on this step, so picking
                        // it would close a loop. The reason goes in the label
                        // rather than a tooltip: a disabled control cannot be
                        // hovered reliably, and a tooltip is invisible to a
                        // screen reader.
                        aria-label={
                            option.disabled
                                ? `${option.name || "Untitled step"} — unavailable, it already runs after this step`
                                : option.name || "Untitled step"
                        }
                        isDisabled={option.disabled}
                    >
                        <span className={`max-w-40 truncate ${option.name ? "" : "italic opacity-70"}`}>
                            {option.name || "Untitled step"}
                        </span>
                    </ToggleGroupItem>
                ))}
            </ToggleGroup>
        </div>
    );
}
