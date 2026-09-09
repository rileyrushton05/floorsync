"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  PlusIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useMemo, useRef, useState } from "react";
import type { Key } from "react-aria-components";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/field";
import { GridList, GridListEmptyState, GridListItem } from "@/components/ui/grid-list";
import { Input } from "@/components/ui/input";
import { Note } from "@/components/ui/note";
import { NumberField, NumberInput } from "@/components/ui/number-field";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { TextField } from "@/components/ui/text-field";
import { priorityIntent } from "../../_lib/badge-intent";
import { UserMenu } from "../../_components/UserMenu";
import { Wordmark } from "../../_components/Logo";
import { usePlanning } from "../_components/PlanningProvider";
import { SubNav } from "../_components/SubNav";
import { buildJobColors, jobColor } from "../_lib/colors";
import { dependentsOf, formatDuration, totalWorkMins, wouldCreateCycle } from "../_lib/scheduling";
import type { JobDef, OperationDef, Priority } from "../_lib/types";

/** The job being written, before it is committed to the backlog. */
interface Draft {
    /** null while creating; a job id while editing an existing job. */
    id: string | null;
    name: string;
    priority: Priority;
    operations: OperationDef[];
    dependsOn: string[];
}

const EMPTY_DRAFT: Draft = { id: null, name: "", priority: "Med", operations: [], dependsOn: [] };

const PRIORITIES: { id: Priority }[] = [{ id: "High" }, { id: "Med" }, { id: "Low" }];

function draftFrom(job: JobDef): Draft {
    return {
        id: job.id,
        name: job.name,
        priority: job.priority,
        operations: job.operations.map((op) => ({ ...op })),
        dependsOn: [...job.dependsOn],
    };
}

export default function JobsPage() {
    const { machines, jobs, createJob, updateJob, deleteJob } = usePlanning();
    const [draft, setDraft] = useState<Draft>(() => (jobs.length > 0 ? draftFrom(jobs[0]) : EMPTY_DRAFT));
    const [errors, setErrors] = useState<string[]>([]);
    // Operations are only ever created by a click, so a plain counter is a safe
    // key source — no ids are generated during render.
    const opCounter = useRef(0);

    const colors = useMemo(() => buildJobColors(jobs), [jobs]);
    const machineName = (id: string) => machines.find((machine) => machine.id === id)?.name ?? "—";

    const draftWorkMins = draft.operations.reduce((total, op) => total + op.durationMins, 0);
    const blockedBy = draft.id ? dependentsOf(jobs, draft.id) : [];

    function startNewJob() {
        setDraft(EMPTY_DRAFT);
        setErrors([]);
    }

    function editJob(job: JobDef) {
        setDraft(draftFrom(job));
        setErrors([]);
    }

    function addOperation() {
        opCounter.current += 1;
        setDraft((previous) => ({
            ...previous,
            operations: [
                ...previous.operations,
                {
                    id: `new-op-${opCounter.current}`,
                    name: "",
                    machineId: machines[0]?.id ?? "",
                    durationMins: 30,
                },
            ],
        }));
    }

    function patchOperation(index: number, patch: Partial<OperationDef>) {
        setDraft((previous) => ({
            ...previous,
            operations: previous.operations.map((op, i) => (i === index ? { ...op, ...patch } : op)),
        }));
    }

    function removeOperation(index: number) {
        setDraft((previous) => ({
            ...previous,
            operations: previous.operations.filter((_, i) => i !== index),
        }));
    }

    /** Reordering matters: operations run in array order, so this edits precedence. */
    function moveOperation(index: number, offset: number) {
        const target = index + offset;
        setDraft((previous) => {
            if (target < 0 || target >= previous.operations.length) return previous;
            const operations = [...previous.operations];
            [operations[index], operations[target]] = [operations[target], operations[index]];
            return { ...previous, operations };
        });
    }

    function toggleDependency(jobId: string) {
        setDraft((previous) => ({
            ...previous,
            dependsOn: previous.dependsOn.includes(jobId)
                ? previous.dependsOn.filter((id) => id !== jobId)
                : [...previous.dependsOn, jobId],
        }));
    }

    function validateDraft(): string[] {
        const found: string[] = [];
        if (draft.name.trim() === "") found.push("Give the job a name.");
        if (draft.operations.length === 0) found.push("Add at least one operation.");
        draft.operations.forEach((op, index) => {
            if (op.name.trim() === "") found.push(`Operation ${index + 1} needs a name.`);
            if (!(op.durationMins > 0)) found.push(`Operation ${index + 1} needs a duration greater than zero.`);
        });
        return found;
    }

    function saveDraft() {
        const found = validateDraft();
        setErrors(found);
        if (found.length > 0) return;

        const payload = {
            name: draft.name.trim(),
            priority: draft.priority,
            operations: draft.operations.map((op) => ({ ...op, name: op.name.trim() })),
            dependsOn: draft.dependsOn,
        };

        if (draft.id) {
            updateJob(draft.id, payload);
            toast.success(`${draft.id} saved.`);
        } else {
            const id = createJob({ ...payload, dependsOn: payload.dependsOn });
            setDraft((previous) => ({ ...previous, id }));
            toast.success(`${id} created and added to the selection.`);
        }
    }

    function removeJob() {
        if (!draft.id) return;
        const removedId = draft.id;
        deleteJob(removedId);
        setDraft(EMPTY_DRAFT);
        setErrors([]);
        toast.success(`${removedId} deleted.`);
    }

    const dependencyCandidates = jobs.filter((candidate) => candidate.id !== draft.id);

    return (
        <div className="flex min-h-dvh flex-col bg-bg text-fg">
            <header className="flex flex-wrap items-center gap-5 border-b bg-navbar px-7 py-3.5">
                <div className="flex items-center gap-2.5">
                    <Wordmark />
                    <span className="border-l pl-2.5 font-bold text-muted-fg text-xs uppercase tracking-[0.06em]">
                        Manager
                    </span>
                </div>
                <SubNav />
                <div className="flex-1" />
                <Button onPress={startNewJob}>
                    <PlusIcon /> New job
                </Button>
                <UserMenu />
            </header>

            <main className="grid flex-1 gap-5 p-5 xl:grid-cols-[minmax(280px,0.8fr)_2fr]">
                <Card>
                    <CardHeader className="flex-row items-center gap-2.5">
                        <CardTitle>Job backlog</CardTitle>
                        <Badge intent="secondary">{jobs.length}</Badge>
                    </CardHeader>
                    <CardContent>
                        <p className="mb-3 text-muted-fg text-sm">
                            Jobs defined here are what the scheduler draws from. Nothing is scheduled until you
                            select jobs and generate a plan.
                        </p>

                        <GridList
                            aria-label="Job backlog"
                            selectionMode="single"
                            selectionBehavior="replace"
                            items={jobs}
                            selectedKeys={draft.id ? new Set([draft.id]) : new Set()}
                            onSelectionChange={(keys) => {
                                if (keys === "all") return;
                                const [first] = Array.from(keys);
                                const job = jobs.find((candidate) => candidate.id === first);
                                if (job) editJob(job);
                            }}
                            renderEmptyState={() => (
                                <GridListEmptyState>No jobs yet. Create one to get started.</GridListEmptyState>
                            )}
                        >
                            {(job) => (
                                <GridListItem id={job.id} textValue={`${job.id} ${job.name}`} className="items-start">
                                    <span
                                        className="mt-1 size-3 shrink-0 rounded-full"
                                        style={{ background: jobColor(colors, job.id).fill }}
                                    />
                                    <span className="flex min-w-0 flex-col gap-0.5">
                                        <span className="flex items-center gap-2">
                                            <span className="font-semibold text-sm">{job.id}</span>
                                            <Badge intent={priorityIntent(job.priority)}>{job.priority}</Badge>
                                        </span>
                                        <span className="truncate text-sm">{job.name}</span>
                                        <span className="text-muted-fg text-xs">
                                            {job.operations.length} ops · {formatDuration(totalWorkMins(job))} of work
                                        </span>
                                        {job.dependsOn.length > 0 && (
                                            <span className="text-muted-fg text-xs">
                                                after {job.dependsOn.join(", ")}
                                            </span>
                                        )}
                                    </span>
                                </GridListItem>
                            )}
                        </GridList>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex-row items-center justify-between gap-3">
                        <CardTitle>{draft.id ? `Edit ${draft.id}` : "New job"}</CardTitle>
                        {draft.id && (
                            <span className="text-muted-fg text-sm">{draft.operations.length} operations</span>
                        )}
                    </CardHeader>
                    <CardContent className="space-y-5">
                        {errors.length > 0 && (
                            <Note intent="danger" role="alert">
                                <strong>Fix before saving</strong>
                                <ul className="mt-1 list-disc ps-5">
                                    {errors.map((error) => (
                                        <li key={error}>{error}</li>
                                    ))}
                                </ul>
                            </Note>
                        )}

                        <div className="flex flex-col gap-4 sm:flex-row">
                            <TextField
                                className="flex-2"
                                value={draft.name}
                                onChange={(name) => setDraft((previous) => ({ ...previous, name }))}
                            >
                                <Label>Job name</Label>
                                <Input placeholder="e.g. Dryer not working" />
                            </TextField>

                            <Select
                                className="flex-1"
                                value={draft.priority}
                                onChange={(priority) =>
                                    setDraft((previous) => ({ ...previous, priority: priority as Priority }))
                                }
                            >
                                <Label>Priority</Label>
                                <SelectTrigger />
                                <SelectContent items={PRIORITIES}>
                                    {(item) => (
                                        <SelectItem id={item.id} textValue={item.id}>
                                            {item.id}
                                        </SelectItem>
                                    )}
                                </SelectContent>
                            </Select>
                        </div>

                        <div>
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <h3 className="font-semibold text-sm">Operations</h3>
                                <span className="text-muted-fg text-xs">
                                    Run top to bottom — each step waits for the one above it
                                </span>
                            </div>

                            <ol className="mt-3 space-y-2.5">
                                {draft.operations.map((op, index) => (
                                    <li
                                        key={op.id}
                                        className="grid items-end gap-2.5 rounded-lg border bg-muted p-2.5 sm:grid-cols-[auto_2fr_1.2fr_auto_auto]"
                                    >
                                        <span className="flex size-6 items-center justify-center self-center rounded-full bg-secondary font-semibold text-xs">
                                            {index + 1}
                                        </span>

                                        <TextField
                                            aria-label={`Operation ${index + 1} name`}
                                            value={op.name}
                                            onChange={(name) => patchOperation(index, { name })}
                                        >
                                            <Input placeholder="Operation name" />
                                        </TextField>

                                        <Select
                                            aria-label={`Operation ${index + 1} machine`}
                                            value={op.machineId}
                                            onChange={(machineId) =>
                                                patchOperation(index, { machineId: String(machineId) })
                                            }
                                        >
                                            <SelectTrigger />
                                            <SelectContent items={machines}>
                                                {(machine) => (
                                                    <SelectItem id={machine.id} textValue={machine.name}>
                                                        {machine.name}
                                                    </SelectItem>
                                                )}
                                            </SelectContent>
                                        </Select>

                                        <NumberField
                                            aria-label={`Operation ${index + 1} duration in minutes`}
                                            className="w-38"
                                            minValue={1}
                                            step={5}
                                            value={op.durationMins}
                                            onChange={(durationMins) => patchOperation(index, { durationMins })}
                                        >
                                            <NumberInput />
                                        </NumberField>

                                        <span className="flex items-center gap-1 self-center">
                                            <Button
                                                intent="plain"
                                                size="sq-xs"
                                                onPress={() => moveOperation(index, -1)}
                                                isDisabled={index === 0}
                                                aria-label={`Move operation ${index + 1} earlier`}
                                            >
                                                <ArrowUpIcon />
                                            </Button>
                                            <Button
                                                intent="plain"
                                                size="sq-xs"
                                                onPress={() => moveOperation(index, 1)}
                                                isDisabled={index === draft.operations.length - 1}
                                                aria-label={`Move operation ${index + 1} later`}
                                            >
                                                <ArrowDownIcon />
                                            </Button>
                                            <Button
                                                intent="plain"
                                                size="sq-xs"
                                                onPress={() => removeOperation(index)}
                                                aria-label={`Remove operation ${index + 1}`}
                                            >
                                                <XMarkIcon />
                                            </Button>
                                        </span>
                                    </li>
                                ))}
                                {draft.operations.length === 0 && (
                                    <li className="rounded-lg border border-dashed p-4 text-center text-muted-fg text-sm">
                                        No operations yet — a job needs at least one.
                                    </li>
                                )}
                            </ol>

                            <Button intent="outline" size="sm" className="mt-3" onPress={addOperation}>
                                <PlusIcon /> Add operation
                            </Button>
                        </div>

                        <div>
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <h3 className="font-semibold text-sm">Dependencies</h3>
                                <span className="text-muted-fg text-xs">
                                    This job cannot start until every job ticked here has finished
                                </span>
                            </div>

                            <ul className="mt-3 space-y-1.5">
                                {dependencyCandidates.map((candidate) => {
                                    // Ticking a job that already depends on this one would
                                    // close a loop no ordering can satisfy, so block it here
                                    // rather than failing at generation time.
                                    const cyclic = draft.id !== null && wouldCreateCycle(jobs, draft.id, candidate.id);
                                    return (
                                        <li key={candidate.id}>
                                            <CheckboxField
                                                isSelected={draft.dependsOn.includes(candidate.id)}
                                                isDisabled={cyclic}
                                                onChange={() => toggleDependency(candidate.id)}
                                            >
                                                <Checkbox>
                                                    <span className="flex flex-wrap items-center gap-2 text-sm">
                                                        <span className="font-semibold">{candidate.id}</span>
                                                        <span>{candidate.name}</span>
                                                        {cyclic && (
                                                            <span className="text-muted-fg text-xs">
                                                                already waits on this job
                                                            </span>
                                                        )}
                                                    </span>
                                                </Checkbox>
                                            </CheckboxField>
                                        </li>
                                    );
                                })}
                                {dependencyCandidates.length === 0 && (
                                    <li className="text-muted-fg text-sm">No other jobs to depend on yet.</li>
                                )}
                            </ul>

                            {blockedBy.length > 0 && (
                                <p className="mt-3 text-muted-fg text-sm">
                                    <strong className="text-fg">
                                        {blockedBy.length} job{blockedBy.length === 1 ? "" : "s"}
                                    </strong>{" "}
                                    wait on this one: {blockedBy.map((job) => job.id).join(", ")}
                                </p>
                            )}
                        </div>

                        <Separator />

                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="text-muted-fg text-sm">
                                {draft.operations.length} operations · {formatDuration(draftWorkMins)} of machine
                                time ·{" "}
                                {new Set(draft.operations.map((op) => machineName(op.machineId))).size} machines
                            </div>
                            <div className="flex items-center gap-2.5">
                                {draft.id && (
                                    <Button intent="danger" onPress={removeJob}>
                                        Delete job
                                    </Button>
                                )}
                                <Button onPress={saveDraft}>
                                    {draft.id ? "Save changes" : "Create job"}
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </main>
        </div>
    );
}
