import { PageMessage } from "@/core/feedback/PageMessage";
import { ManagerShell } from "./ManagerShell";

/** Shared non-content state for manager screens. */
export function ManagerPageState({
    title,
    children,
    error = false,
}: {
    title: string;
    children: React.ReactNode;
    error?: boolean;
}) {
    return (
        <ManagerShell>
            <main className="flex flex-1 items-center justify-center p-5">
                <PageMessage title={title} tone={error ? "danger" : "info"}>{children}</PageMessage>
            </main>
        </ManagerShell>
    );
}
