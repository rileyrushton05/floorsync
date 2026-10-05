import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Description, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Link } from "@/components/ui/link";
import { TextField } from "@/components/ui/text-field";
import { InfoTooltip } from "@/components/ui/tooltip";
import { useSaveShortcutLabel } from "@/core/keyboard/useSaveShortcut";
import { CheckIcon, TrashIcon } from "@heroicons/react/24/outline";
import { SCHEDULE_NAME_MAX, scheduleDisplayName } from "../model/archive";

/**
 * What the Planner can do with the plan on screen.
 *
 * A run is stored as an unnamed draft the moment it finishes, so "saving" is
 * naming it and, usually, confirming it: only a confirmed schedule claims its
 * jobs and can be run in the simulation. "Save as draft" names it and leaves
 * it to be confirmed later from the Schedules page.
 */
export type SavePanelState =
    | { kind: "empty" }
    | { kind: "draft"; scheduleId: string }
    | { kind: "saved"; scheduleId: string; name: string | null; status: "confirmed" | "discarded" };

export function SavePlanPanel({
    state,
    name,
    saving,
    discarding,
    onNameChange,
    onSave,
    onSaveDraft,
    onDiscard,
}: {
    state: SavePanelState;
    name: string;
    saving: boolean;
    discarding: boolean;
    onNameChange: (name: string) => void;
    onSave: () => void;
    onSaveDraft: () => void;
    onDiscard: () => void;
}) {
    const shortcut = useSaveShortcutLabel();
    const named = name.trim() !== "";
    const busy = saving || discarding;

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2.5">
                    Save schedule
                    <InfoTooltip label="About saving">
                        Saving names the plan and confirms it as the floor&apos;s schedule: its jobs
                        are marked planned and it can be run in the simulation. Save as draft to
                        keep it without confirming; you can confirm it later from Schedules.
                    </InfoTooltip>
                    {state.kind === "draft" && (
                        <Badge intent="warning" role="status">
                            Not saved
                        </Badge>
                    )}
                </CardTitle>
            </CardHeader>
            <CardContent>
                {state.kind === "empty" && (
                    <p className="text-muted-fg text-sm">
                        Select jobs and generate a plan. Once it looks right, name it and save it here.
                    </p>
                )}

                {state.kind === "saved" && (
                    <p className="text-sm">
                        This plan is already saved as{" "}
                        <strong>“{scheduleDisplayName({ name: state.name, status: state.status })}”</strong>.{" "}
                        <Link
                            href={`/manager/schedules?schedule=${encodeURIComponent(state.scheduleId)}`}
                            className="text-primary"
                        >
                            View it in Schedules →
                        </Link>
                    </p>
                )}

                {state.kind === "draft" && (
                    <form
                        className="flex flex-col gap-4"
                        onSubmit={(event) => {
                            event.preventDefault();
                            onSave();
                        }}
                    >
                        <TextField
                            value={name}
                            onChange={onNameChange}
                            maxLength={SCHEDULE_NAME_MAX}
                            isDisabled={busy}
                            isRequired
                        >
                            <Label>Schedule name</Label>
                            <Input placeholder="e.g. Week 41 – day shift" autoComplete="off" />
                            <Description>Shown on the Schedules and Simulation pages.</Description>
                        </TextField>
                        <div className="flex flex-col gap-2">
                            <Button
                                type="submit"
                                intent="success"
                                isPending={saving}
                                isDisabled={!named || discarding}
                                aria-keyshortcuts="Control+S Meta+S"
                            >
                                <CheckIcon /> Save schedule
                                {shortcut !== null && (
                                    <kbd aria-hidden className="ms-1 font-sans text-[0.75em] opacity-70">
                                        {shortcut}
                                    </kbd>
                                )}
                            </Button>
                            <Button intent="outline" onPress={onSaveDraft} isDisabled={!named || busy}>
                                Save as draft
                            </Button>
                            <Button
                                intent="plain"
                                className="text-danger"
                                onPress={onDiscard}
                                isPending={discarding}
                                isDisabled={saving}
                            >
                                <TrashIcon /> Discard plan
                            </Button>
                        </div>
                    </form>
                )}
            </CardContent>
        </Card>
    );
}
