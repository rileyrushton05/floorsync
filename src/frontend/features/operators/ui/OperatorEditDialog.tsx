"use client";

import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import {
    Dialog,
    DialogBody,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Description, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { Modal as AriaModal, ModalOverlay } from "react-aria-components";
import { useState } from "react";
import type { OperatorAccount, OperatorChanges } from "../model/operator";

/**
 * Edit one operator login: display name, username, password, whether it can
 * sign in, and which machine it runs.
 *
 * Only machines that already have an operator are offered, because choosing
 * one swaps the two operators. Moving onto a free machine would leave the old
 * one without a login, and nothing creates a login for an existing machine.
 *
 * Saving sends only what changed. An empty password field means "keep the
 * current one", since the current password is never shown.
 */
export function OperatorEditDialog({
    operator,
    operators,
    saving,
    onSave,
    onDismiss,
}: {
    operator: OperatorAccount;
    /** Every operator, so the machine list can say who each swap is with. */
    operators: OperatorAccount[];
    saving: boolean;
    onSave: (changes: OperatorChanges) => void;
    onDismiss: () => void;
}) {
    const [name, setName] = useState(operator.name);
    const [username, setUsername] = useState(operator.username);
    const [password, setPassword] = useState("");
    const [active, setActive] = useState(operator.active);
    const [machineId, setMachineId] = useState(operator.machine_id);

    const changes: OperatorChanges = {};
    if (name.trim() !== operator.name) changes.name = name.trim();
    if (username.trim().toLowerCase() !== operator.username) changes.username = username.trim().toLowerCase();
    if (password !== "") changes.password = password;
    if (active !== operator.active) changes.active = active;
    if (machineId !== operator.machine_id) changes.machine_id = machineId;

    const swapWith = operators.find((other) => other.machine_id === machineId && other.id !== operator.id);
    const problem = name.trim() === "" ? "Enter a display name." : username.trim() === "" ? "Enter a username." : null;
    const canSave = !saving && problem === null && Object.keys(changes).length > 0;

    return (
        <ModalOverlay
            isOpen
            isDismissable={!saving}
            onOpenChange={(open) => {
                if (!open) onDismiss();
            }}
            className="fixed inset-0 z-50 flex animate-in items-center justify-center bg-fg/40 fade-in-0 p-5 backdrop-blur-sm duration-150"
        >
            <AriaModal className="w-full max-w-md animate-in rounded-2xl border bg-overlay fade-in-0 shadow-lg duration-150 zoom-in-95">
                <Dialog>
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (canSave) onSave(changes);
                        }}
                    >
                        <DialogHeader>
                            <DialogTitle>Edit {operator.username}</DialogTitle>
                            <DialogDescription>Operator login for {operator.machine_name}.</DialogDescription>
                        </DialogHeader>
                        <DialogBody className="flex flex-col gap-4">
                            <TextField value={name} onChange={setName} autoComplete="off">
                                <Label>Display name</Label>
                                <Input />
                            </TextField>
                            <TextField value={username} onChange={setUsername} autoComplete="off">
                                <Label>Username</Label>
                                <Input autoCapitalize="none" spellCheck={false} />
                                <Description>Usernames are stored in lowercase.</Description>
                            </TextField>
                            <TextField type="password" value={password} onChange={setPassword} autoComplete="new-password">
                                <Label>New password</Label>
                                <Input placeholder="Leave blank to keep the current password" />
                            </TextField>
                            <Select value={machineId} onChange={(value) => setMachineId(String(value))}>
                                <Label>Machine</Label>
                                <SelectTrigger />
                                <SelectContent>
                                    {operators.map((other) => (
                                        <SelectItem key={other.machine_id} id={other.machine_id} textValue={other.machine_name}>
                                            {other.machine_name}
                                            {other.id !== operator.id && (
                                                <span className="ms-2 text-muted-fg text-xs">{other.username}</span>
                                            )}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                                <Description>
                                    {swapWith
                                        ? `Swaps machines: ${swapWith.username} moves to ${operator.machine_name}.`
                                        : "Picking another machine swaps it with that machine's operator."}
                                </Description>
                            </Select>
                            <CheckboxField isSelected={active} onChange={setActive}>
                                <Checkbox>Can sign in</Checkbox>
                                <Description>
                                    A disabled account is signed out on its next request.
                                </Description>
                            </CheckboxField>
                        </DialogBody>
                        <DialogFooter>
                            {problem !== null && (
                                <span className="me-auto text-muted-fg text-sm" role="status">
                                    {problem}
                                </span>
                            )}
                            <Button intent="outline" onPress={onDismiss} isDisabled={saving}>
                                Cancel
                            </Button>
                            <Button type="submit" isDisabled={!canSave} isPending={saving}>
                                {saving ? "Saving…" : "Save changes"}
                            </Button>
                        </DialogFooter>
                    </form>
                </Dialog>
            </AriaModal>
        </ModalOverlay>
    );
}
