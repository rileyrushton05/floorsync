"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { TextField } from "@/components/ui/text-field";
import { TextArea } from "@/components/ui/textarea";
import {
    ArrowDownIcon,
    ArrowDownTrayIcon,
    ArrowUpIcon,
    Bars2Icon,
    ChevronDownIcon,
    ChevronRightIcon,
    PlusIcon,
    WrenchScrewdriverIcon,
    XMarkIcon
} from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal as AriaModal, ModalOverlay } from "react-aria-components";
import { toast } from "sonner";
import { ManagerTopbar } from "../_components/ManagerTopbar";

/**
 * Machine status vocabulary. The dot colour and badge intent for each state
 * live in MACHINE_STATUS_STYLE so the sidebar and the header stay in sync.
 */
type MachineStatus = "Running" | "Idle" | "Down" | "Offline";

const MACHINE_STATUS_STYLE: Record<MachineStatus, { dot: string; badge: "success" | "warning" | "danger" | "secondary" }> = {
    Running: { dot: "bg-success", badge: "success" },
    Idle: { dot: "bg-warning", badge: "warning" },
    Down: { dot: "bg-danger", badge: "danger" },
    Offline: { dot: "bg-muted-fg", badge: "secondary" },
};

/** Wireframe job statuses on a machine. */
type AssignedStatus = "Running" | "Queued" | "Done";

const ASSIGNED_STATUS_BADGE: Record<AssignedStatus, "info" | "warning" | "success"> = {
    Running: "info",
    Queued: "warning",
    Done: "success",
};

interface AssignedJob {
    id: string;
    name: string;
    priority: "High" | "Med" | "Low";
    status: AssignedStatus;
    progress: number;
}

/** Priority colours mirror the status shades: High red, Med yellow, Low green. */
const PRIORITY_INTENT: Record<AssignedJob["priority"], "danger" | "warning" | "success"> = {
    High: "danger",
    Med: "warning",
    Low: "success",
};

interface Machine {
    id: string;
    name: string;
    type: string;
    location: string;
    capacity: string;
    installed: string;
    lastMaintenance: string;
    status: MachineStatus;
    utilization: number;
    notes?: string;
    jobs: AssignedJob[];
}

/**
 * Seeded floor inventory. Floors are ordered A → C and bays within them, which
 * is what the "Floor order" sort preserves; "Name" falls back to alphabetical.
 */
const SEED_MACHINES: Machine[] = [
    {
        id: "MCH-001", name: "Machine A", type: "Washer", location: "Floor A, Bay 1",
        capacity: "150 units/hr", installed: "12 Mar 2024", lastMaintenance: "02 Sep 2026",
        status: "Running", utilization: 78,
        jobs: [
            { id: "#255", name: "Washing Machine Issue", priority: "Med", status: "Running", progress: 40 },
            { id: "#251", name: "Seal Replacement", priority: "Low", status: "Queued", progress: 0 },
            { id: "#248", name: "Drain Flush", priority: "Med", status: "Done", progress: 100 },
        ],
    },
    {
        id: "MCH-002", name: "Machine B", type: "Dryer", location: "Floor A, Bay 2",
        capacity: "120 units/hr", installed: "12 Mar 2024", lastMaintenance: "02 Sep 2026",
        status: "Running", utilization: 87,
        jobs: [
            { id: "#254", name: "Dryer not working", priority: "High", status: "Running", progress: 60 },
            { id: "#258", name: "Tool Replacement", priority: "Med", status: "Queued", progress: 0 },
            { id: "#260", name: "Quality Check Batch 3", priority: "High", status: "Queued", progress: 0 },
            { id: "#243", name: "Tension Adjust", priority: "Med", status: "Done", progress: 100 },
            { id: "#239", name: "Routine Lube", priority: "Low", status: "Done", progress: 100 },
        ],
    },
    {
        id: "MCH-006", name: "Machine F", type: "Press", location: "Floor B, Bay 2",
        capacity: "90 units/hr", installed: "08 Jul 2024", lastMaintenance: "28 Aug 2026",
        status: "Running", utilization: 64,
        jobs: [
            { id: "#262", name: "Press Plate Swap", priority: "Med", status: "Running", progress: 25 },
            { id: "#257", name: "Conveyor Belt Check", priority: "Med", status: "Queued", progress: 0 },
        ],
    },
    {
        id: "MCH-003", name: "Machine C", type: "Cutter", location: "Floor B, Bay 1",
        capacity: "60 units/hr", installed: "08 Jul 2024", lastMaintenance: "15 Aug 2026",
        status: "Idle", utilization: 0, notes: "0 jobs assigned",
        jobs: [],
    },
    {
        id: "MCH-007", name: "Machine G", type: "Sander", location: "Floor B, Bay 3",
        capacity: "45 units/hr", installed: "19 Oct 2024", lastMaintenance: "30 Aug 2026",
        status: "Idle", utilization: 12,
        jobs: [
            { id: "#241", name: "Oven Door Hinge", priority: "Low", status: "Queued", progress: 0 },
        ],
    },
    {
        id: "MCH-004", name: "Machine D", type: "Kiln", location: "Floor B, Bay 1",
        capacity: "80 units/hr", installed: "01 May 2023", lastMaintenance: "10 Sep 2026",
        status: "Down", utilization: 0, notes: "maintenance",
        jobs: [],
    },
    {
        id: "MCH-008", name: "Machine H", type: "Boiler", location: "Floor C, Bay 1",
        capacity: "200 units/hr", installed: "02 Feb 2023", lastMaintenance: "22 Jul 2026",
        status: "Offline", utilization: 0, notes: "not connected",
        jobs: [],
    },
];

const STATUS_FILTERS = [
    { id: "All", label: "All statuses" },
    { id: "Running", label: "Running" },
    { id: "Idle", label: "Idle" },
    { id: "Down", label: "Down" },
    { id: "Offline", label: "Offline" },
] as const;

const LOAD_FILTERS = [
    { id: "Any", label: "Any load" },
    { id: "Loaded", label: "Has jobs" },
    { id: "Empty", label: "No jobs" },
] as const;

const SORT_OPTIONS = [
    { id: "Floor", label: "Floor order" },
    { id: "Name", label: "Name" },
    { id: "Utilization", label: "Utilization" },
] as const;

/** Unassigned pool the "Assign" search draws from. */
const UNASSIGNED_POOL: AssignedJob[] = [
    { id: "#261", name: "Vent Cleaning", priority: "Low", status: "Queued", progress: 0 },
    { id: "#259", name: "Quality Inspection", priority: "Med", status: "Queued", progress: 0 },
    { id: "#246", name: "Panel Rewire", priority: "High", status: "Queued", progress: 0 },
];

const TODAY = "Fri, 11 Sep";

const MACHINE_TYPES = ["Washer", "Dryer", "Press", "Cutter", "Kiln", "Sander", "Boiler", "Generic"];
const FLOORS = ["A", "B", "C"];
const CAPACITY_UNITS = ["units/hr", "units/day", "kg/hr", "L/min"];

/** Draft shape for the Edit Details dialog. */
interface MachineDraft {
    name: string;
    type: string;
    floor: string;
    bay: string;
    capacityValue: string;
    capacityUnit: string;
    lastMaintenance: string;
    notes: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "02 Sep 2026" → "2026-09-02" (empty/"—" → ""), for <input type="date">. */
function dateToISO(display: string): string {
    const match = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(display.trim());
    if (!match) return "";
    const day = match[1].padStart(2, "0");
    const month = MONTHS.findIndex((m) => m.toLowerCase() === match[2].toLowerCase());
    if (month === -1) return "";
    return `${match[3]}-${String(month + 1).padStart(2, "0")}-${day}`;
}

/** "2026-09-02" → "02 Sep 2026", for the read-only detail list. */
function isoToDate(iso: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!match) return "";
    return `${match[3]} ${MONTHS[parseInt(match[2], 10) - 1]} ${match[1]}`;
}

function draftFrom(machine: Machine): MachineDraft {
    const [floor = "A", bay = "1"] = machine.location.replace(/^Floor\s*/i, "").split(",").map((part) => part.replace(/^\s*Bay\s*/i, "").trim());
    const [capacityValue = "", capacityUnit = CAPACITY_UNITS[0]] = machine.capacity.split(/\s+/);
    return {
        name: machine.name,
        type: machine.type,
        floor,
        bay,
        capacityValue: capacityValue === "—" ? "" : capacityValue,
        capacityUnit: CAPACITY_UNITS.includes(capacityUnit) ? capacityUnit : CAPACITY_UNITS[0],
        lastMaintenance: dateToISO(machine.lastMaintenance),
        notes: machine.notes ?? "",
    };
}

/**
 * Edit Details dialog. Same shell as the Remove Machine confirmation:
 * backdrop blurs and darkens the page; the panel zooms in on open and zooms
 * back out on dismiss.
 */
function EditMachineDetailsDialog({
    machine,
    closing,
    onSave,
    onDismiss,
}: {
    machine: Machine;
    closing: boolean;
    onSave: (draft: MachineDraft) => void;
    onDismiss: () => void;
}) {
    const [draft, setDraft] = useState<MachineDraft>(() => draftFrom(machine));

    const nameInvalid = draft.name.trim() === "";
    const typeInvalid = draft.type.trim() === "";
    const locationInvalid = draft.floor.trim() === "" || draft.bay.trim() === "";
    const canSave = !nameInvalid && !typeInvalid && !locationInvalid;

    function patch(patchValues: Partial<MachineDraft>) {
        setDraft((previous) => ({ ...previous, ...patchValues }));
    }

    return (
        <ModalOverlay
            isOpen
            isDismissable={!closing}
            onOpenChange={(open) => {
                if (!open) onDismiss();
            }}
            className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5 backdrop-blur-sm ${closing ? "animate-[fade-out_150ms_ease-in_forwards]" : "animate-[fade-in_150ms_ease-out]"
                }`}
        >
            <style>{`
                @keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
                @keyframes fade-out { from { opacity: 1 } to { opacity: 0 } }
                @keyframes zoom-in { from { opacity: 0; transform: scale(0.92) } to { opacity: 1; transform: scale(1) } }
                @keyframes zoom-out { from { opacity: 1; transform: scale(1) } to { opacity: 0; transform: scale(0.92) } }
            `}</style>
            <AriaModal
                aria-label={`Edit details for ${machine.id}`}
                className={`w-full max-w-lg rounded-2xl border bg-overlay shadow-lg ${closing ? "animate-[zoom-out_150ms_ease-in_forwards]" : "animate-[zoom-in_150ms_ease-out]"
                    }`}
            >
                {/* Header */}
                <div className="border-b p-5">
                    <h2 className="font-semibold text-fg text-lg">Edit Machine Details</h2>
                    <p className="mt-0.5 text-muted-fg text-sm">{machine.id} · {machine.type}</p>
                </div>

                {/* Body */}
                <div className="space-y-4 p-5">
                    <TextField
                        aria-label="Machine name"
                        isInvalid={nameInvalid}
                        value={draft.name}
                        onChange={(name) => patch({ name })}
                    >
                        <Label>Machine name</Label>
                        <Input placeholder="e.g. Machine B" autoComplete="off" />
                    </TextField>

                    <Select
                        aria-label="Machine type"
                        isInvalid={typeInvalid}
                        value={draft.type}
                        onChange={(type) => patch({ type: String(type) })}
                    >
                        <Label>Type</Label>
                        <SelectTrigger />
                        <SelectContent>
                            {MACHINE_TYPES.map((type) => (
                                <SelectItem key={type} id={type} textValue={type}>
                                    {type}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <TextField aria-label="Floor" isInvalid={locationInvalid} value={draft.floor} onChange={(floor) => patch({ floor })}>
                        <Label>Location</Label>
                        <div className="flex items-center gap-2">
                            <span className="text-muted-fg text-sm">Floor</span>
                            <Select
                                aria-label="Floor letter"
                                className="w-20"
                                value={draft.floor}
                                onChange={(floor) => patch({ floor: String(floor) })}
                            >
                                <SelectTrigger />
                                <SelectContent>
                                    {FLOORS.map((floor) => (
                                        <SelectItem key={floor} id={floor} textValue={floor}>
                                            {floor}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <span className="text-muted-fg text-sm">Bay</span>
                            <Input
                                aria-label="Bay"
                                placeholder="e.g. 2"
                                value={draft.bay}
                                onChange={(event) => patch({ bay: event.target.value })}
                                className="flex-1"
                            />
                        </div>
                    </TextField>

                    <TextField aria-label="Capacity" value={draft.capacityValue} onChange={(capacityValue) => patch({ capacityValue })}>
                        <Label>Capacity</Label>
                        <Input placeholder="e.g. 120" inputMode="numeric" autoComplete="off" />
                        <Select
                            aria-label="Capacity unit"
                            className="mt-2"
                            value={draft.capacityUnit}
                            onChange={(unit) => patch({ capacityUnit: String(unit) })}
                        >
                            <SelectTrigger />
                            <SelectContent>
                                {CAPACITY_UNITS.map((unit) => (
                                    <SelectItem key={unit} id={unit} textValue={unit}>
                                        {unit}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </TextField>

                    <TextField aria-label="Last maintenance date" value={draft.lastMaintenance}>
                        <Label>Last Maintenance</Label>
                        <Input
                            type="date"
                            value={draft.lastMaintenance}
                            onChange={(event) => patch({ lastMaintenance: event.target.value })}
                        />
                    </TextField>

                    <TextField aria-label="Notes">
                        <Label>Notes</Label>
                        <TextArea
                            placeholder="Anything worth knowing about this machine…"
                            value={draft.notes}
                            onChange={(event) => patch({ notes: event.target.value })}
                            rows={3}
                        />
                    </TextField>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-2.5 border-t p-5">
                    <Button intent="outline" onPress={onDismiss}>
                        Cancel
                    </Button>
                    <Button
                        isDisabled={!canSave}
                        onPress={() => onSave(draft)}
                    >
                        Save
                    </Button>
                </div>
            </AriaModal>
        </ModalOverlay>
    );
}

/** How long the zoom-out runs before the dialog unmounts, in ms. */
const CLOSE_MS = 150;

/**
 * Small unassign confirmation popover. Rendered with position:fixed anchored
 * to the × button so overflow containers can't clip it — it flips above the
 * button when there's no room below (e.g. the last row).
 */
function UnassignConfirmPopover({
    jobId,
    anchor,
    onConfirm,
    onDismiss,
}: {
    jobId: string;
    anchor: HTMLElement;
    onConfirm: () => void;
    onDismiss: () => void;
}) {
    const POPOVER_HEIGHT = 110;
    const POPOVER_WIDTH = 180;
    const BOX_OFFSET = -60;

    const rect = anchor.getBoundingClientRect();
    const openUpwards = rect.bottom + POPOVER_HEIGHT > window.innerHeight;
    const top = openUpwards ? rect.top - POPOVER_HEIGHT - 8 : rect.bottom + 8;

    const anchorCenter = rect.left + rect.width / 2;
    const desiredLeft = anchorCenter - POPOVER_WIDTH / 2 + BOX_OFFSET;
    const left = Math.min(
        Math.max(12, desiredLeft),
        window.innerWidth - POPOVER_WIDTH - 12,
    );

    const tailLeft = Math.min(
        Math.max(10, anchorCenter - left - 5),
        POPOVER_WIDTH - 15,
    );

    return (
        <>
            <span
                className="fixed inset-0 z-40 cursor-default"
                onClick={onDismiss}
            />
            <style>{`
                @keyframes pop-in { from { opacity: 0; transform: scale(0.9) translateY(4px) } to { opacity: 1; transform: scale(1) translateY(0) } }
            `}</style>
            <div
                role="alertdialog"
                aria-label={`Confirm unassign ${jobId}`}
                className="fixed z-50 animate-[pop-in_150ms_ease-out]"
                style={{
                    top,
                    left,
                    width: POPOVER_WIDTH,
                    transformOrigin: openUpwards ? "bottom right" : "top right",
                }}
            >
                <span
                    style={{ left: tailLeft }}
                    className={`absolute size-2.5 rotate-45 border-e border-t bg-overlay ${openUpwards ? "-bottom-1 rotate-[225deg]" : "-top-1"}`}
                />
                <div className="rounded-lg border bg-overlay p-3 shadow-lg">
                    <p className="whitespace-nowrap text-sm">
                        Unassign <strong>{jobId}</strong>?
                    </p>
                    <div className="mt-2.5 flex items-center justify-end gap-1.5">
                        <Button intent="danger" size="sm" onPress={onConfirm}>
                            Yes
                        </Button>
                        <Button intent="plain" size="sm" onPress={onDismiss}>
                            No
                        </Button>
                    </div>
                </div>
            </div>
        </>
    );
}

/**
 * Deletion confirmation. Same shell as the Jobs page: backdrop blurs and
 * darkens the page; the panel zooms in on open and zooms back out on dismiss.
 */
function DeleteMachineConfirmDialog({
    machineId,
    machineName,
    closing,
    onConfirm,
    onDismiss,
}: {
    machineId: string;
    machineName: string;
    closing: boolean;
    onConfirm: () => void;
    onDismiss: () => void;
}) {
    return (
        <ModalOverlay
            isOpen
            isDismissable={!closing}
            onOpenChange={(open) => {
                if (!open) onDismiss();
            }}
            className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5 backdrop-blur-sm ${closing ? "animate-[fade-out_150ms_ease-in_forwards]" : "animate-[fade-in_150ms_ease-out]"
                }`}
        >
            <style>{`
                @keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
                @keyframes fade-out { from { opacity: 1 } to { opacity: 0 } }
                @keyframes zoom-in { from { opacity: 0; transform: scale(0.92) } to { opacity: 1; transform: scale(1) } }
                @keyframes zoom-out { from { opacity: 1; transform: scale(1) } to { opacity: 0; transform: scale(0.92) } }
            `}</style>
            <AriaModal
                aria-label={`Confirm remove ${machineId}`}
                className={`w-full max-w-sm rounded-2xl border bg-overlay p-5 shadow-lg ${closing ? "animate-[zoom-out_150ms_ease-in_forwards]" : "animate-[zoom-in_150ms_ease-out]"
                    }`}
            >
                <h2 className="font-semibold text-fg text-lg">Remove {machineName}?</h2>
                <p className="mt-2 text-muted-fg text-sm">
                    This removes <strong className="text-fg">{machineId}</strong> from the floor.
                    Any jobs assigned to it must be unassigned first. This cannot be undone.
                </p>
                <div className="mt-5 flex items-center justify-end gap-2.5">
                    <Button intent="outline" onPress={onDismiss}>
                        Cancel
                    </Button>
                    <Button intent="danger" onPress={onConfirm}>
                        Remove machine
                    </Button>
                </div>
            </AriaModal>
        </ModalOverlay>
    );
}

export default function MachinesPage() {
    const [machines, setMachines] = useState(SEED_MACHINES);
    const [selectedId, setSelectedId] = useState(SEED_MACHINES[0].id);
    const [query, setQuery] = useState("");
    const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]["id"]>("All");
    const [loadFilter, setLoadFilter] = useState<(typeof LOAD_FILTERS)[number]["id"]>("Any");
    const [sortBy, setSortBy] = useState<(typeof SORT_OPTIONS)[number]["id"]>("Floor");
    const [expanded, setExpanded] = useState(false);
    const [assignQuery, setAssignQuery] = useState("");
    // The id of the job picked from the search results. Non-null means the
    // results list is hidden and the Assign button will assign this exact job.
    const [pickedJobId, setPickedJobId] = useState<string | null>(null);
    // Which (machine, job) pair is currently awaiting an inline unassign
    // confirmation, plus the anchor element the popover attaches to. The
    // anchor is captured on click (not stored in a ref) so reading it during
    // render is safe and updates flush correctly.
    const [pendingUnassign, setPendingUnassign] = useState<
        { machineId: string; jobId: string; anchor: HTMLElement } | null
    >(null);
    // Remove Machine confirmation dialog (open + closing window for exit animation).
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [deleteClosing, setDeleteClosing] = useState(false);
    // Edit Details dialog (open + closing window for exit animation).
    const [editingDetails, setEditingDetails] = useState(false);
    const [editClosing, setEditClosing] = useState(false);

    // ── Drag-to-reorder for the Assigned Jobs steps, mirroring the Jobs page
    // operations list: `dragArmed` gates dragging to the handle press,
    // `dragIndex`/`dropIndex` track the carried row and its landing spot, and
    // `recentlyMoved` flashes the row that just landed.
    const [dragArmed, setDragArmed] = useState<number | null>(null);
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [dropIndex, setDropIndex] = useState<number | null>(null);
    const [recentlyMoved, setRecentlyMoved] = useState<number | null>(null);
    // Job order per machine as last saved (or as seeded). Rows whose current
    // position differs stay light yellow until "Save changes" commits them.
    const [savedOrders, setSavedOrders] = useState<Record<string, string[]>>(() =>
        Object.fromEntries(SEED_MACHINES.map((m) => [m.id, m.jobs.map((job) => job.id)])),
    );

    function resetDrag() {
        setDragArmed(null);
        setDragIndex(null);
        setDropIndex(null);
    }

    // ── Auto-scroll: ref on the currently-selected row + a flag that tells
    // the effect below to run a scroll once (and only once) after expanding.
    const selectedRowRef = useRef<HTMLLIElement | null>(null);
    const shouldScrollRef = useRef(false);

    const selected = machines.find((machine) => machine.id === selectedId) ?? machines[0];

    const SIDEBAR_LIMIT = 7;

    const filteredMachines = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const matching = machines.filter((machine) => {
            if (needle && !`${machine.id} ${machine.name}`.toLowerCase().includes(needle)) return false;
            if (statusFilter !== "All" && machine.status !== statusFilter) return false;
            if (loadFilter === "Loaded" && machine.jobs.length === 0) return false;
            if (loadFilter === "Empty" && machine.jobs.length > 0) return false;
            return true;
        });
        if (sortBy === "Name") return [...matching].sort((a, b) => a.name.localeCompare(b.name));
        if (sortBy === "Utilization") return [...matching].sort((a, b) => b.utilization - a.utilization);
        return matching; // already in floor order
    }, [machines, query, statusFilter, loadFilter, sortBy]);

    // ── Expansion helpers ─────────────────────────────────────────────────
    const canExpand = filteredMachines.length > SIDEBAR_LIMIT;
    const visibleMachines = expanded
        ? filteredMachines
        : filteredMachines.slice(0, SIDEBAR_LIMIT);
    const selectedIsHidden =
        canExpand && !visibleMachines.some((m) => m.id === selected.id);

    // ── Auto-scroll effect: runs after `expanded` becomes true (or after
    // the visible list changes while expanded). If the trigger flag is set,
    // scrolls the selected row into view and clears the flag.
    useEffect(() => {
        if (!shouldScrollRef.current) return;
        if (!expanded) return;
        const el = selectedRowRef.current;
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        shouldScrollRef.current = false;
    }, [expanded, selectedId, filteredMachines.length]);

    const filtersActive = query.trim() !== "" || statusFilter !== "All" || loadFilter !== "Any";

    function clearFilters() {
        setQuery("");
        setStatusFilter("All");
        setLoadFilter("Any");
    }

    /**
     * Called by the expand button. When expanding (not collapsing), set the
     * scroll trigger flag so the effect above scrolls the selected row into
     * view once the list re-renders.
     */
    function toggleExpanded() {
        setExpanded((prev) => {
            const next = !prev;
            if (next) shouldScrollRef.current = true;
            return next;
        });
    }

    /** Toggling offline drops a Running machine back to Idle; on again → Idle. */
    function toggleOffline(machine: Machine) {
        setMachines((previous) =>
            previous.map((m) =>
                m.id === machine.id
                    ? { ...m, status: m.status === "Offline" ? "Idle" : "Offline" }
                    : m,
            ),
        );
        toast.success(
            machine.status === "Offline"
                ? `${machine.name} reconnected and set to Idle.`
                : `${machine.name} set to Offline.`,
        );
    }

    /** Arrow-button reorder: swap with the neighbour, then flash the row. */
    function moveJob(machine: Machine, index: number, offset: number) {
        const target = index + offset;
        if (target < 0 || target >= machine.jobs.length) return;
        reorderJob(machine.id, index, target);
    }

    /** Insert the dragged row at `to`, shifting the others down. */
    function reorderJob(machineId: string, from: number, to: number) {
        setMachines((previous) =>
            previous.map((m) => {
                if (m.id !== machineId) return m;
                const jobs = [...m.jobs];
                const [moved] = jobs.splice(from, 1);
                jobs.splice(to, 0, moved);
                return { ...m, jobs };
            }),
        );
        setRecentlyMoved(to);
        setTimeout(() => setRecentlyMoved((current) => (current === to ? null : current)), 900);
    }

    function removeJob(machine: Machine, jobId: string) {
        setMachines((previous) =>
            previous.map((m) =>
                m.id === machine.id
                    ? { ...m, jobs: m.jobs.filter((job) => job.id !== jobId) }
                    : m,
            ),
        );
        setSavedOrders((previous) => ({
            ...previous,
            [machine.id]: (previous[machine.id] ?? []).filter((id) => id !== jobId),
        }));
        toast.success(`Job ${jobId} unassigned from ${machine.name}.`);
    }

    // Search pool excludes jobs already on the selected machine — the same job
    // id can never be assigned to a machine twice.
    const assignedIds = new Set(selected.jobs.map((job) => job.id));
    const candidates = UNASSIGNED_POOL.filter((job) => {
        if (assignedIds.has(job.id)) return false;
        const needle = assignQuery.trim().toLowerCase();
        return needle === "" || `${job.id} ${job.name}`.toLowerCase().includes(needle);
    });

    function assignJob(job: AssignedJob) {
        setMachines((previous) =>
            previous.map((m) =>
                m.id === selected.id ? { ...m, jobs: [...m.jobs, job] } : m,
            ),
        );
        // Keep the baseline aligned so a newly assigned job (appended at the
        // end) doesn't falsely flag as reordered.
        setSavedOrders((previous) => ({
            ...previous,
            [selected.id]: [...(previous[selected.id] ?? []), job.id],
        }));
        setAssignQuery("");
        setPickedJobId(null);
        toast.success(`Job ${job.id} assigned to ${selected.name}.`);
    }

    /** Dismiss the edit dialog with the zoom-out animation. */
    function dismissEdit() {
        if (editClosing) return;
        setEditClosing(true);
        setTimeout(() => {
            setEditingDetails(false);
            setEditClosing(false);
        }, CLOSE_MS);
    }

    /** Apply the edited details to the selected machine. */
    function saveDetails(draft: MachineDraft) {
        const location = `Floor ${draft.floor}, Bay ${draft.bay}`;
        const capacity = draft.capacityValue.trim() === "" ? "—" : `${draft.capacityValue} ${draft.capacityUnit}`;
        setMachines((previous) =>
            previous.map((m) =>
                m.id === selected.id
                    ? {
                        ...m,
                        name: draft.name.trim(),
                        type: draft.type,
                        location,
                        capacity,
                        lastMaintenance: draft.lastMaintenance === "" ? "—" : isoToDate(draft.lastMaintenance),
                        notes: draft.notes.trim() === "" ? undefined : draft.notes.trim(),
                    }
                    : m,
            ),
        );
        setEditingDetails(false);
        setEditClosing(false);
        toast.success(`Details for ${draft.name.trim()} (${selected.id}) saved.`);
    }

    /** Dismiss the delete dialog with the zoom-out animation. */
    function dismissDelete() {
        if (deleteClosing) return;
        setDeleteClosing(true);
        setTimeout(() => {
            setConfirmingDelete(false);
            setDeleteClosing(false);
        }, CLOSE_MS);
    }

    /** Confirm handler — runs the actual removal. */
    function confirmRemoveMachine() {
        if (!selected) return;
        if (selected.jobs.length > 0) {
            toast.error("Unassign all jobs first. This action cannot be undone.");
            setConfirmingDelete(false);
            setDeleteClosing(false);
            return;
        }
        const removedName = selected.name;
        const removedId = selected.id;
        setMachines((previous) => {
            const remaining = previous.filter((m) => m.id !== removedId);
            setSelectedId(remaining[0]?.id ?? "");
            return remaining;
        });
        setConfirmingDelete(false);
        setDeleteClosing(false);
        toast.success(`${removedName} removed from the floor.`);
    }

    /** Committing the current order clears the "order changed" highlight. */
    function commitOrder() {
        setSavedOrders((previous) => ({ ...previous, [selected.id]: selected.jobs.map((job) => job.id) }));
    }

    /** Opens the confirmation dialog. Guard runs on confirm, not on click. */
    function removeMachine(machine: Machine) {
        // Optional: pre-guard so the user isn't shown a dialog they can't action.
        // If you'd rather let them confirm and then see the error toast, delete
        // this block.
        if (machine.jobs.length > 0) {
            toast.error("Unassign all jobs first. This action cannot be undone.");
            return;
        }
        setConfirmingDelete(true);
    }

    function addMachine() {
        const highest = machines.reduce((max, m) => {
            const match = /^MCH-(\d+)$/.exec(m.id);
            if (!match) return max;
            const n = parseInt(match[1], 10);
            return Number.isFinite(n) && n > max ? n : max;
        }, 0);
        const next = highest + 1;
        const machine: Machine = {
            id: `MCH-${String(next).padStart(3, "0")}`,
            name: `Machine ${String.fromCharCode(65 + (next - 1) % 26)}`,
            type: "Generic",
            location: "Floor A, Bay 1",
            capacity: "—",
            installed: "11 Sep 2026",
            lastMaintenance: "—",
            status: "Idle",
            utilization: 0,
            jobs: [],
        };
        setMachines((previous) => [...previous, machine]);
        setSelectedId(machine.id);
        toast.success(`${machine.name} (${machine.id}) added to the floor.`);
    }

    const jobsCompleted = selected.jobs.filter((job) => job.status === "Done").length;

    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
            <ManagerTopbar>
                <span className="font-medium text-muted-fg text-sm">{TODAY}</span>
                <Button
                    intent="outline"
                    onPress={() =>
                        toast.success(`Machine report exported at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`)
                    }
                >
                    <ArrowDownTrayIcon /> Export Report
                </Button>
                <Button onPress={addMachine}>
                    <PlusIcon /> Add machine
                </Button>
            </ManagerTopbar>

            <main className="grid min-h-0 flex-1 gap-5 p-5 xl:grid-cols-[minmax(280px,0.8fr)_2fr]">
                {/* ── Sidebar: floor inventory — stretches to the page bottom, list scrolls inside ─────────────── */}
                <Card className="flex min-h-0 flex-col overflow-hidden">
                    <CardHeader className="shrink-0">
                        <CardTitle>Machines</CardTitle>
                        <Badge intent="secondary" className="mt-1">Total: ( {machines.length} )</Badge>
                    </CardHeader>
                    <CardContent className="min-h-0 flex-1 overflow-y-auto">
                        <TextField aria-label="Search machines" value={query} onChange={setQuery}>
                            <Input placeholder="Search by machine name or id…" autoComplete="off" />
                        </TextField>

                        <div className="mt-5">
                            <div className="flex items-center justify-between gap-2">
                                <span className="font-semibold text-muted-fg text-xs uppercase tracking-[0.05em]">
                                    Filter
                                </span>
                                {filtersActive && (
                                    <Button intent="plain" size="sm" onPress={clearFilters}>
                                        <XMarkIcon /> Clear
                                    </Button>
                                )}
                            </div>

                            <div className="mt-2 flex items-center gap-2">
                                <Select
                                    aria-label="Filter by status"
                                    className="w-40"
                                    value={statusFilter}
                                    onChange={(value) => setStatusFilter(value as typeof statusFilter)}
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
                                    aria-label="Filter by load"
                                    className="w-32"
                                    value={loadFilter}
                                    onChange={(value) => setLoadFilter(value as typeof loadFilter)}
                                >
                                    <SelectTrigger />
                                    <SelectContent>
                                        {LOAD_FILTERS.map((option) => (
                                            <SelectItem key={option.id} id={option.id} textValue={option.label}>
                                                {option.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <Separator className="my-5" />

                        <div className="mb-4 flex items-center gap-2">
                            <span className="shrink-0 font-medium text-muted-fg text-xs">Sort:</span>
                            <Select
                                aria-label="Sort machines"
                                className="w-40"
                                value={sortBy}
                                onChange={(value) => setSortBy(value as typeof sortBy)}
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
                            <span className="ml-auto text-end font-medium text-muted-fg text-xs" role="status">
                                Showing {filteredMachines.length} of {machines.length} machines
                            </span>
                        </div>

                        <ul
                            className="overflow-hidden rounded-lg border"
                            aria-label="Machine list"
                        >
                            {visibleMachines.map((machine) => {
                                const style = MACHINE_STATUS_STYLE[machine.status];
                                const isSelected = machine.id === selected.id;
                                return (
                                    <li
                                        key={machine.id}
                                        ref={isSelected ? selectedRowRef : undefined}
                                        className="border-b last:border-b-0"
                                    >
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setSelectedId(machine.id);
                                                // Clear any open unassign prompt so it doesn't carry over.
                                                setPendingUnassign(null);
                                                // Clear any half-completed assign search.
                                                setAssignQuery("");
                                                setPickedJobId(null);
                                            }}
                                            aria-current={isSelected ? "true" : undefined}
                                            className={`group flex w-full items-start gap-2.5 p-3 text-start transition hover:bg-secondary! hover:text-fg! ${isSelected
                                                ? "bg-primary/25!"
                                                : ""
                                                }`}
                                        >
                                            <span className={`mt-1 size-3 shrink-0 rounded-full ${style.dot}`} />
                                            <span className="flex min-w-0 flex-col gap-0.5">
                                                <span className="flex items-center gap-2">
                                                    <span className="font-semibold text-sm">{machine.id}</span>
                                                    <Badge intent={style.badge}>{machine.status}</Badge>
                                                </span>
                                                <span className="truncate text-sm">
                                                    {machine.name} · {machine.location}
                                                </span>
                                                <span className="text-muted-fg text-xs">
                                                    {machine.notes ?? `${machine.jobs.length} job${machine.jobs.length === 1 ? "" : "s"} assigned · ${machine.utilization}% utilized`}
                                                </span>
                                            </span>
                                            <ChevronRightIcon
                                                aria-label={`Open ${machine.id} details`}
                                                className="ml-auto size-4 shrink-0 self-start text-muted-fg transition group-hover:translate-x-0.5 group-hover:text-fg selected:text-fg"
                                            />
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>

                        {canExpand && (
                            <button
                                type="button"
                                onClick={toggleExpanded}
                                aria-expanded={expanded}
                                className={`group mt-3 flex w-full flex-col items-center gap-0.5 rounded-lg p-3 text-center transition hover:bg-secondary ${selectedIsHidden
                                    ? "bg-primary/25! hover:bg-primary/35!"
                                    : ""
                                    }`}
                            >
                                {!expanded && (
                                    <span className={`text-xs ${selectedIsHidden ? "text-fg" : "text-muted-fg"}`}>
                                        +{filteredMachines.length - SIDEBAR_LIMIT} more
                                    </span>
                                )}
                                <span className={`font-medium text-sm ${selectedIsHidden ? "text-fg" : ""}`}>
                                    {expanded ? "Click to collapse" : "Click to expand"}
                                </span>
                                <ChevronDownIcon
                                    aria-hidden
                                    className={`size-6 transition-all group-hover:translate-y-0.5 ${selectedIsHidden
                                        ? "text-primary"
                                        : "text-muted-fg group-hover:text-primary"
                                        } ${expanded ? "rotate-180" : ""}`}
                                />
                            </button>
                        )}
                    </CardContent>
                </Card>

                {/* ── Detail pane: full height, its middle section scrolls while the header/footer stay put ──────────── */}
                <div
                    className="flex min-h-0 flex-col rounded-xl border bg-bg p-5 shadow-sm"
                >
                    <div className="shrink-0">
                        <p className="text-muted-fg text-sm">
                            Machines <span className="mx-1">›</span> {selected.name}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
                            <div className="flex items-center gap-3">
                                <h1 className="font-bold text-2xl">{selected.name}</h1>
                                <Badge intent={MACHINE_STATUS_STYLE[selected.status].badge}>
                                    <span
                                        className={`me-1 size-2 rounded-full ${MACHINE_STATUS_STYLE[selected.status].dot}`}
                                    />
                                    {selected.status}
                                </Badge>
                            </div>
                            <div className="flex items-center gap-2.5">
                                <Button
                                    intent="outline"
                                    onPress={() => setEditingDetails(true)}
                                >
                                    Edit Details
                                </Button>
                                <Button
                                    intent="outline"
                                    onPress={() => toast.info(`Maintenance log for ${selected.name} (last: ${selected.lastMaintenance}).`)}
                                >
                                    <WrenchScrewdriverIcon /> Maintenance Log
                                </Button>
                                {selected.status === "Offline" ? (
                                    <Button intent="success" onPress={() => toggleOffline(selected)}>
                                        ⏻ Set Online
                                    </Button>
                                ) : (
                                    <Button intent="danger" onPress={() => toggleOffline(selected)}>
                                        ⏻ Set Offline
                                    </Button>
                                )}
                            </div>
                        </div>
                        <p className="mt-1 text-muted-fg text-sm">
                            {selected.type} · {selected.location} · ID: {selected.id}
                        </p>
                    </div>

                    <div className="mt-5 grid min-h-0 flex-1 gap-5 overflow-y-auto pr-1 sm:grid-cols-[minmax(240px,0.7fr)_2fr]">
                        <div className="space-y-5">
                            <Card>
                                <CardHeader>
                                    <CardTitle>Machine Details</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <dl className="space-y-2.5 text-sm">
                                        {[
                                            ["Type", selected.type],
                                            ["Location", selected.location],
                                            ["Capacity", selected.capacity],
                                            ["Installed", selected.installed],
                                            ["Last Maintenance", selected.lastMaintenance],
                                        ].map(([label, value]) => (
                                            <div
                                                key={label}
                                                className="flex items-center justify-between gap-3 border-b py-2.5 last:border-b-0"
                                            >
                                                <dt className="text-muted-fg">{label}</dt>
                                                <dd className="text-end font-medium">{value}</dd>
                                            </div>
                                        ))}
                                    </dl>
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Current Utilization</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-0">
                                    <div className="flex items-center justify-between border-b py-2.5 text-sm">
                                        <span className="text-muted-fg">Today</span>
                                        <span className="font-semibold tabular-nums">{selected.utilization}%</span>
                                    </div>
                                    <div className="py-3.5">
                                        <ProgressBar aria-label={`${selected.name} utilization`} value={selected.utilization}>
                                            <ProgressBarTrack className="h-2.5 min-w-0" />
                                        </ProgressBar>
                                    </div>
                                    <div className="flex items-center justify-between border-b py-2.5 text-sm">
                                        <span className="text-muted-fg">Jobs assigned</span>
                                        <span className="font-semibold tabular-nums">{selected.jobs.length}</span>
                                    </div>
                                    <div className="flex items-center justify-between py-2.5 text-sm">
                                        <span className="text-muted-fg">Jobs completed</span>
                                        <span className="font-semibold tabular-nums">{jobsCompleted}</span>
                                    </div>
                                </CardContent>
                            </Card>
                        </div>

                        <Card className="self-start">
                            <CardHeader>
                                <CardTitle>Assigned Jobs</CardTitle>
                                <span className="text-muted-fg text-sm">
                                    {selected.jobs.length} job{selected.jobs.length === 1 ? "" : "s"}
                                </span>
                            </CardHeader>
                            <CardContent>
                                {selected.jobs.length === 0 ? (
                                    <p className="py-8 text-center text-muted-fg text-sm">
                                        No jobs assigned to {selected.name}. Use the search below to assign one.
                                    </p>
                                ) : (
                                    <table className="mb-4 w-full text-sm">
                                        <thead>
                                            <tr className="border-b text-start font-medium text-muted-fg text-xs uppercase tracking-[0.05em]">
                                                <th scope="col" className="py-2 pe-2" />
                                                <th scope="col" className="py-2 pe-3 text-start">Step</th>
                                                <th scope="col" className="py-2 pe-3 text-start">Job ID</th>
                                                <th scope="col" className="py-2 pe-3 text-start">Job Name</th>
                                                <th scope="col" className="py-2 pe-3 text-start">Priority</th>
                                                <th scope="col" className="py-2 pe-3 text-start">Status</th>
                                                <th scope="col" className="py-2 pe-3 text-start">Progress</th>
                                                <th scope="col" className="py-2 text-end">Actions</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {selected.jobs.map((job, index) => {
                                                const isPending =
                                                    pendingUnassign?.jobId === job.id &&
                                                    pendingUnassign?.machineId === selected.id;
                                                // Sequence colour: first step green, last red,
                                                // the middle ones yellow — same as the Jobs page.
                                                const total = selected.jobs.length;
                                                const step =
                                                    total <= 1 ? "primary" : index === 0 ? "first" : index === total - 1 ? "last" : "middle";
                                                const STEP_STYLE: Record<string, string> = {
                                                    first: "border-success bg-success text-success-fg",
                                                    middle: "border-warning bg-warning text-warning-fg",
                                                    last: "border-danger bg-danger text-danger-fg",
                                                    primary: "border-primary bg-primary text-primary-fg",
                                                };
                                                const STEP_LABEL: Record<string, string> = {
                                                    first: "starts the job",
                                                    middle: "step",
                                                    last: "finishes the job",
                                                    primary: "only step",
                                                };
                                                const isDragging = dragIndex === index;
                                                // The dragged row would land here if released now.
                                                const dropBefore = dragIndex !== null && dropIndex === index && dropIndex !== dragIndex;
                                                const dropAfter =
                                                    dragIndex !== null && dropIndex === total && dropIndex !== dragIndex && index === total - 1;
                                                const landing = recentlyMoved === index;
                                                // Rows whose position differs from the last-saved order
                                                // stay light yellow until changes are saved.
                                                const reordered = (savedOrders[selected.id] ?? [])[index] !== job.id;
                                                return (
                                                    <tr
                                                        key={job.id}
                                                        draggable={dragArmed === index}
                                                        onDragStart={(event) => {
                                                            setDragIndex(index);
                                                            event.dataTransfer.effectAllowed = "move";
                                                            event.dataTransfer.setData("text/plain", String(index));
                                                        }}
                                                        onDragOver={(event) => {
                                                            if (dragIndex === null) return;
                                                            event.preventDefault();
                                                            event.dataTransfer.dropEffect = "move";
                                                            const bounds = event.currentTarget.getBoundingClientRect();
                                                            const after = event.clientY > bounds.top + bounds.height / 2;
                                                            setDropIndex(Math.min(index + (after ? 1 : 0), total));
                                                        }}
                                                        onDrop={(event) => {
                                                            event.preventDefault();
                                                            if (dragIndex !== null && dropIndex !== null) {
                                                                reorderJob(
                                                                    selected.id,
                                                                    dragIndex,
                                                                    dragIndex < dropIndex ? dropIndex - 1 : dropIndex,
                                                                );
                                                            }
                                                            resetDrag();
                                                        }}
                                                        onDragEnd={resetDrag}
                                                        className={`border-b transition-colors last:border-0 ${reordered ? "bg-warning-subtle/60" : ""} ${isDragging ? "opacity-40" : ""
                                                            } ${landing ? "ring-2 ring-primary" : ""} ${dropBefore
                                                                ? "border-t-primary border-t-2"
                                                                : dropAfter
                                                                    ? "border-b-primary border-b-2"
                                                                    : ""
                                                            }`}
                                                    >
                                                        <td className="py-3 pe-2">
                                                            <Button
                                                                intent="plain"
                                                                size="sq-xs"
                                                                className="cursor-grab active:cursor-grabbing"
                                                                onPointerDown={() => setDragArmed(index)}
                                                                onPointerUp={resetDrag}
                                                                aria-label={`Reorder job ${job.id}`}
                                                            >
                                                                <Bars2Icon />
                                                            </Button>
                                                        </td>
                                                        <td className="py-3 pe-3">
                                                            <span
                                                                className={`flex size-6 items-center justify-center rounded-full border font-semibold text-xs ${STEP_STYLE[step]}`}
                                                                title={`Step ${index + 1} of ${total} — ${STEP_LABEL[step]}`}
                                                            >
                                                                {index + 1}
                                                            </span>
                                                        </td>
                                                        <td className="py-3 pe-3 font-semibold">{job.id}</td>
                                                        <td className="py-3 pe-3">{job.name}</td>
                                                        <td className="py-3 pe-3">
                                                            <Badge intent={PRIORITY_INTENT[job.priority]}>{job.priority}</Badge>
                                                        </td>
                                                        <td className="py-3 pe-3">
                                                            <Badge intent={ASSIGNED_STATUS_BADGE[job.status]}>{job.status}</Badge>
                                                        </td>
                                                        <td className="py-3 pe-3">
                                                            <div className="flex items-center gap-2">
                                                                <ProgressBar
                                                                    aria-label={`Job ${job.id} progress`}
                                                                    value={job.progress}
                                                                    className="w-20"
                                                                >
                                                                    <ProgressBarTrack className="min-w-0" />
                                                                </ProgressBar>
                                                                <span className="text-muted-fg text-xs tabular-nums">{job.progress}%</span>
                                                            </div>
                                                        </td>
                                                        <td className="py-3">
                                                            <div className="flex items-center justify-end gap-1">
                                                                <Button
                                                                    intent="plain"
                                                                    size="sq-sm"
                                                                    aria-label={`Move ${job.id} up`}
                                                                    isDisabled={index === 0}
                                                                    onPress={() => moveJob(selected, index, -1)}
                                                                >
                                                                    <ArrowUpIcon />
                                                                </Button>
                                                                <Button
                                                                    intent="plain"
                                                                    size="sq-sm"
                                                                    aria-label={`Move ${job.id} down`}
                                                                    isDisabled={index === selected.jobs.length - 1}
                                                                    onPress={() => moveJob(selected, index, 1)}
                                                                >
                                                                    <ArrowDownIcon />
                                                                </Button>
                                                                <span data-unassign-anchor className="relative">
                                                                    <Button
                                                                        intent="plain"
                                                                        size="sq-sm"
                                                                        aria-label={`Unassign ${job.id}`}
                                                                        onPress={(event) => {
                                                                            if (isPending) {
                                                                                setPendingUnassign(null);
                                                                                return;
                                                                            }
                                                                            const anchor = (event.target as HTMLElement).closest<HTMLElement>("[data-unassign-anchor]");
                                                                            if (anchor) {
                                                                                setPendingUnassign({ machineId: selected.id, jobId: job.id, anchor });
                                                                            }
                                                                        }}
                                                                    >
                                                                        <XMarkIcon />
                                                                    </Button>
                                                                </span>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                )}

                                <Separator className="my-4" />

                                <div className="mb-4 flex flex-wrap items-center gap-2.5">
                                    <TextField
                                        aria-label="Search jobs to assign"
                                        value={assignQuery}
                                        onChange={(value) => {
                                            setAssignQuery(value);
                                            // Typing clears any prior pick so the results show again.
                                            setPickedJobId(null);
                                        }}
                                        className="min-w-52 flex-1"
                                    >
                                        <Input placeholder="Search jobs to assign by ID or name…" autoComplete="off" />
                                    </TextField>
                                    <Button
                                        isDisabled={pickedJobId === null}
                                        onPress={() => {
                                            const job = pickedJobId
                                                ? candidates.find((c) => c.id === pickedJobId) ??
                                                UNASSIGNED_POOL.find((c) => c.id === pickedJobId)
                                                : null;
                                            if (job) assignJob(job);
                                        }}
                                    >
                                        Assign
                                    </Button>
                                </div>

                                {/* Results list — hidden as soon as a job has been picked. */}
                                {assignQuery.trim() !== "" && pickedJobId === null && candidates.length > 0 && (
                                    <ul className="mt-2 mb-4 space-y-1">
                                        {candidates.map((job) => (
                                            <li key={job.id}>
                                                <Button
                                                    intent="plain"
                                                    size="sm"
                                                    className="w-full justify-start px-2"
                                                    onPress={() => {
                                                        setAssignQuery(`${job.id} ${job.name}`);
                                                        setPickedJobId(job.id);
                                                    }}
                                                >
                                                    <span className="font-semibold">{job.id}</span>
                                                    <span className="text-muted-fg">{job.name}</span>
                                                </Button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {assignQuery.trim() !== "" && pickedJobId === null && candidates.length === 0 && (
                                    <p className="mt-2 mb-4 text-muted-fg text-xs">No unassigned jobs match that search.</p>
                                )}
                            </CardContent>
                        </Card>
                    </div>

                    {/* ── Footer bar: summary + actions (matches the Jobs page pattern) ── */}
                    <Separator className="my-5 shrink-0" />
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="text-muted-fg text-sm">
                            {selected.jobs.length} job{selected.jobs.length === 1 ? "" : "s"} ·{" "}
                            {jobsCompleted} completed · {selected.utilization}% utilized
                        </div>
                        <div className="flex items-center gap-2.5">
                            <Button
                                intent="danger"
                                onPress={() => removeMachine(selected)}
                            >
                                Remove Machine
                            </Button>
                            <Button
                                onPress={() => {
                                    commitOrder();
                                    toast.success(`Changes to ${selected.name} (${selected.id}) saved.`);
                                }}
                            >
                                Save changes
                            </Button>
                        </div>
                    </div>
                </div>
            </main>

            <footer className="flex flex-wrap items-center gap-4 border-t bg-navbar px-7 py-3.5">
                <div className="flex flex-1 items-center gap-2 text-muted-fg text-sm">
                    <WrenchScrewdriverIcon className="size-4.5" />
                    <span>Select a machine to view its details, utilization and assigned jobs. Set a machine offline when it leaves the floor.</span>
                </div>
            </footer>

            {/* Remove Machine confirmation dialog */}
            {confirmingDelete && selected && (
                <DeleteMachineConfirmDialog
                    machineId={selected.id}
                    machineName={selected.name}
                    closing={deleteClosing}
                    onConfirm={confirmRemoveMachine}
                    onDismiss={dismissDelete}
                />
            )}

            {/* Edit Details dialog */}
            {editingDetails && selected && (
                <EditMachineDetailsDialog
                    machine={selected}
                    closing={editClosing}
                    onSave={saveDetails}
                    onDismiss={dismissEdit}
                />
            )}

            {/* Unassign confirmation popover — rendered at the page level so it
                can use position:fixed without being clipped by scrolling ancestors. */}
            {pendingUnassign && (
                <UnassignConfirmPopover
                    jobId={pendingUnassign.jobId}
                    anchor={pendingUnassign.anchor}
                    onConfirm={() => {
                        removeJob(selected, pendingUnassign.jobId);
                        setPendingUnassign(null);
                    }}
                    onDismiss={() => setPendingUnassign(null)}
                />
            )}
        </div>
    );
}