"use client";

import { useDraggable } from "@dnd-kit/core";
import {
    ArrowsPointingInIcon,
    ArrowsPointingOutIcon,
    ArrowsRightLeftIcon,
    EllipsisHorizontalIcon,
    EyeSlashIcon,
    ViewColumnsIcon,
} from "@heroicons/react/24/outline";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSection, MenuSubmenu } from "@/components/ui/menu";
import { usePanel, type PanelState } from "./context";
import type { DropZone } from "./layout";

const SIDES: ReadonlyArray<{ zone: Exclude<DropZone, "center">; label: string }> = [
    { zone: "left", label: "To the left" },
    { zone: "right", label: "To the right" },
    { zone: "top", label: "Above" },
    { zone: "bottom", label: "Below" },
];

/**
 * The handle a panel is moved by: drag it, or focus it and press Space to
 * move with the arrow keys. It sits in the card's left gutter, level with the
 * header, so every card gets one without making room for it.
 */
export function PanelGrip({ panel }: { panel: PanelState }) {
    const movable = panel.mode === "tiled";
    const { attributes, listeners, setNodeRef } = useDraggable({
        id: panel.id,
        disabled: !movable,
        attributes: { roleDescription: "movable panel" },
    });
    if (!movable) return null;

    return (
        <button
            type="button"
            ref={setNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Move ${panel.title}`}
            title="Drag to move · Space to move with the arrow keys"
            className="absolute top-5.5 left-1 z-10 flex h-7 w-4 cursor-grab touch-none items-center justify-center rounded-sm text-muted-fg/60 outline-hidden transition-colors hover:bg-secondary hover:text-fg focus-visible:bg-secondary focus-visible:text-fg focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        >
            <GripIcon />
        </button>
    );
}

export function GripIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 8 14" aria-hidden className={cn("h-3.5 w-2", className)} fill="currentColor">
            {[1.5, 7, 12.5].flatMap((y) => [1.5, 6.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r={1.25} />))}
        </svg>
    );
}

/**
 * A panel's menu: move it (swap, or beside another panel), maximise or
 * restore it, or hide it. Place it at the end of the card's header. It draws
 * nothing outside a workspace or in the stacked layout below `xl`.
 */
export function PanelControls({ className }: { className?: string }) {
    const panel = usePanel();
    if (!panel || panel.mode === "stacked") return null;
    return (
        <div className={cn("-my-0.5 flex shrink-0 items-center", className)}>
            <PanelMenu panel={panel} />
        </div>
    );
}

function PanelMenu({ panel }: { panel: PanelState }) {
    const maximised = panel.mode === "maximised";
    const canMove = !maximised && panel.targets.length > 0;

    return (
        <Menu>
            <Button intent="plain" size="sq-xs" aria-label={`${panel.title} panel options`}>
                <EllipsisHorizontalIcon />
            </Button>
            <MenuContent placement="bottom end">
                {canMove && (
                    <MenuSection title="Move">
                        <MenuSubmenu>
                            <MenuItem textValue="Swap with">
                                <ArrowsRightLeftIcon />
                                <MenuLabel>Swap with</MenuLabel>
                            </MenuItem>
                            <MenuContent placement="end top">
                                {panel.targets.map((target) => (
                                    <MenuItem key={target.id} id={target.id} onAction={() => panel.move(target.id, "center")}>
                                        {target.title}
                                    </MenuItem>
                                ))}
                            </MenuContent>
                        </MenuSubmenu>
                        <MenuSubmenu>
                            <MenuItem textValue="Move beside">
                                <ViewColumnsIcon />
                                <MenuLabel>Move beside</MenuLabel>
                            </MenuItem>
                            <MenuContent placement="end top">
                                {panel.targets.map((target) => (
                                    <MenuSubmenu key={target.id}>
                                        <MenuItem id={target.id} textValue={target.title}>
                                            <MenuLabel>{target.title}</MenuLabel>
                                        </MenuItem>
                                        <MenuContent placement="end top">
                                            {SIDES.map((side) => (
                                                <MenuItem
                                                    key={side.zone}
                                                    id={side.zone}
                                                    isDisabled={!panel.canMoveBeside(target.id, side.zone)}
                                                    onAction={() => panel.move(target.id, side.zone)}
                                                >
                                                    {side.label}
                                                </MenuItem>
                                            ))}
                                        </MenuContent>
                                    </MenuSubmenu>
                                ))}
                            </MenuContent>
                        </MenuSubmenu>
                    </MenuSection>
                )}
                <MenuSection title="Panel">
                    <MenuItem id="maximise" onAction={panel.toggleMaximised}>
                        {maximised ? <ArrowsPointingInIcon /> : <ArrowsPointingOutIcon />}
                        <MenuLabel>{maximised ? "Restore" : "Maximise"}</MenuLabel>
                    </MenuItem>
                    <MenuItem id="hide" onAction={panel.hide}>
                        <EyeSlashIcon />
                        <MenuLabel>Hide</MenuLabel>
                    </MenuItem>
                </MenuSection>
            </MenuContent>
        </Menu>
    );
}
