"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { Note } from "@/components/ui/note";
import { InfoTooltip } from "@/components/ui/tooltip";
import { reportMutationError } from "@/core/feedback/reportMutationError";
import { errorMessage } from "@/core/http/errors";
import { useState } from "react";
import { toast } from "sonner";
import { useOperators, useUpdateOperator } from "../data/queries";
import type { OperatorChanges } from "../model/operator";
import { OperatorEditDialog } from "../ui/OperatorEditDialog";

function formatLastSignIn(value: string | null): string {
    if (value === null) return "Never signed in";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "–" : `Last signed in ${date.toLocaleString()}`;
}

/**
 * The manager's view of every operator login.
 *
 * There is deliberately no "add account" here: each machine has exactly one
 * operator login, created with the machine, so the way to get a new one is to
 * add a machine. The tooltip says so for anyone looking for the button.
 */
export function OperatorAccountsSection() {
    const operatorQuery = useOperators();
    const updateOperator = useUpdateOperator();
    const [editingId, setEditingId] = useState<string | null>(null);

    const operators = operatorQuery.data ?? [];
    const editing = operators.find((operator) => operator.id === editingId) ?? null;

    async function save(changes: OperatorChanges) {
        if (!editing || updateOperator.isPending) return;
        try {
            const saved = await updateOperator.mutateAsync({ id: editing.id, changes });
            setEditingId(null);
            toast.success(`“${saved.username}” updated.`);
        } catch (error) {
            reportMutationError(error);
        }
    }

    return (
        <section aria-labelledby="operators-heading" className="flex flex-col gap-5">
            <div>
                <h2 id="operators-heading" className="m-0 flex items-center gap-1.5 font-bold text-lg tracking-tight">
                    Operator accounts
                    <InfoTooltip label="How to create an operator account">
                        To create an operator account, add a machine. Its operator login is generated
                        automatically.
                    </InfoTooltip>
                </h2>
                <p className="mt-1 text-muted-fg text-sm">
                    Each machine has one operator login, which stays with that machine. Rename a login,
                    set a new password, or stop an account from signing in.
                </p>
            </div>

            {operatorQuery.error && !operatorQuery.data ? (
                <Note intent="danger" role="alert">
                    Could not load operator accounts: {errorMessage(operatorQuery.error)}
                </Note>
            ) : operatorQuery.isPending ? (
                <p className="text-muted-fg text-sm">Loading operator accounts…</p>
            ) : operators.length === 0 ? (
                <p className="text-muted-fg text-sm">
                    No operator accounts yet.{" "}
                    <Link href="/manager/machines" className="underline">
                        Add a machine
                    </Link>{" "}
                    to create one.
                </p>
            ) : (
                <ul className="divide-y rounded-lg border">
                    {operators.map((operator) => (
                        <li key={operator.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="flex items-center gap-2">
                                    <span className="truncate font-semibold text-sm">{operator.username}</span>
                                    {!operator.active && <Badge intent="secondary">Disabled</Badge>}
                                </span>
                                <span className="truncate text-muted-fg text-xs">
                                    {operator.name} · {operator.machine_name}
                                </span>
                            </div>
                            <span className="text-muted-fg text-xs">{formatLastSignIn(operator.last_authenticated_at)}</span>
                            <Button intent="outline" size="sm" onPress={() => setEditingId(operator.id)}>
                                Edit
                            </Button>
                        </li>
                    ))}
                </ul>
            )}

            {editing && (
                <OperatorEditDialog
                    key={editing.id}
                    operator={editing}
                    saving={updateOperator.isPending}
                    onSave={(changes) => void save(changes)}
                    onDismiss={() => setEditingId(null)}
                />
            )}
        </section>
    );
}
