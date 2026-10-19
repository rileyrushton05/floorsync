import { Badge } from "@/components/ui/badge";
import { HeaderCount } from "@/components/ui/header-count";
import type { ImportIssue } from "../model/import-report";

/** Problems or warnings, each with its code and where it is in the file. Nothing when empty. */
export function IssueList({
    title,
    issues,
    intent,
}: {
    title: string;
    issues: ImportIssue[];
    intent: "danger" | "warning";
}) {
    if (issues.length === 0) return null;
    return (
        <section>
            <h3 className="font-semibold text-sm">
                {title}
                <HeaderCount>{issues.length}</HeaderCount>
            </h3>
            <ul className="mt-2 divide-y rounded-lg border">
                {issues.map((issue, index) => (
                    <li key={`${issue.code}-${issue.location ?? ""}-${index}`} className="flex flex-col gap-1 px-3 py-2 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge intent={intent}>{issue.code}</Badge>
                            {issue.location !== null && (
                                <code className="text-muted-fg text-xs">{issue.location}</code>
                            )}
                        </div>
                        <p>{issue.message}</p>
                    </li>
                ))}
            </ul>
        </section>
    );
}
