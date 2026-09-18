"use client";

import { useState } from "react";
import { Input, InputGroup } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";

/**
 * Above this many options the chips stop being scannable and a filter appears.
 *
 * A benchmark job runs to fifty steps; forty-nine truncated chips is a wall,
 * not a control. Below the threshold the filter would only be a box to ignore.
 */
const SEARCHABLE_FROM = 8;

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
    foreignPredecessors = 0,
    readOnly = false,
    onChange,
}: {
    /** How this step is named in the control's accessible label. */
    label: string;
    options: PredecessorOption[];
    selected: string[];
    /** Steps in other jobs this one waits on: shown, never editable here. */
    foreignPredecessors?: number;
    /** The job is archived: the chips still say what waits on what, unclickably. */
    readOnly?: boolean;
    onChange: (predecessorIds: string[]) => void;
}) {
    const [query, setQuery] = useState("");
    const needle = query.trim().toLowerCase();
    const searchable = options.length >= SEARCHABLE_FROM;
    // Read-only shows only the steps actually waited on. An unselected chip is an
    // offer, and there is nothing on offer here — listing every other step would
    // read as a set of choices that quietly do nothing when clicked.
    const selectable = readOnly ? options.filter((option) => selected.includes(option.id)) : options;
    // A selected step always stays on screen. Filtering one out of view would
    // hide a choice that is in force, and un-picking it would mean remembering
    // what to search for to find it again.
    const shown =
        needle === ""
            ? selectable
            : selectable.filter(
                (option) =>
                    selected.includes(option.id) ||
                    (option.name || "untitled step").toLowerCase().includes(needle),
            );

    // Keyed off `options`, not `selectable`: a read-only step that waits on
    // nothing still has "can start immediately" worth saying, and the empty
    // toggle group below it renders as nothing at all.
    if (options.length === 0 && foreignPredecessors === 0) return null;

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
            {searchable && !readOnly && (
                <TextField
                    aria-label={`Search the steps ${label} could run after`}
                    className="mt-2"
                    value={query}
                    onChange={setQuery}
                >
                    <InputGroup>
                        <MagnifyingGlassIcon data-slot="icon" />
                        <Input placeholder="Search steps…" autoComplete="off" />
                    </InputGroup>
                </TextField>
            )}

            <ToggleGroup
                aria-label={`Steps ${label} runs after`}
                className="mt-2 flex-wrap"
                size="xs"
                isDisabled={readOnly}
                selectionMode="multiple"
                selectedKeys={new Set(selected)}
                onSelectionChange={(keys) => onChange(Array.from(keys).map(String))}
            >
                {shown.map((option) => (
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

            {searchable && !readOnly && shown.length === 0 && (
                <p className="mt-2 text-muted-fg text-xs">No step matches “{query.trim()}”.</p>
            )}

            {/* The database allows a predecessor in another job, and the ordering
                endpoint replaces every edge pointing into this one — so a save
                carries these through untouched. The diagram cannot draw them
                (it only knows this job's steps), but staying silent would let a
                save look like it had dropped them. */}
            {foreignPredecessors > 0 && (
                <p className="mt-2 text-muted-fg text-xs">
                    Also waits on {foreignPredecessors}{" "}
                    {foreignPredecessors === 1 ? "step" : "steps"} in another job. Not shown in the
                    graph and not changed by saving.
                </p>
            )}
        </div>
    );
}
