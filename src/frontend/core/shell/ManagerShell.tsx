import { ManagerTopbar } from "./ManagerTopbar";

/** Consistent authenticated manager chrome; feature screens provide only their content. */
export function ManagerShell({
    actions,
    children,
}: {
    actions?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className="flex min-h-dvh flex-col bg-bg text-fg">
            <ManagerTopbar>{actions}</ManagerTopbar>
            {children}
        </div>
    );
}
