import { cn } from "cn";

/**
 * A dashed, centred placeholder for an empty pane, matching the planner's
 * "No plan yet" box. An optional action (e.g. a "New Job" button) sits below
 * the description.
 */
export function EmptyState({
    title,
    children,
    action,
    className,
}: {
    title: string;
    children: React.ReactNode;
    action?: React.ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("w-full max-w-xl rounded-lg border border-dashed p-8 text-center", className)}>
            <h3 className="font-semibold text-lg">{title}</h3>
            <div className="mx-auto mt-2 max-w-prose text-muted-fg text-sm">{children}</div>
            {action && <div className="mt-4 flex justify-center">{action}</div>}
        </div>
    );
}
