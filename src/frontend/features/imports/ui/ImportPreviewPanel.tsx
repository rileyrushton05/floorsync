import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HeaderCount } from "@/components/ui/header-count";
import { Link } from "@/components/ui/link";
import { Note } from "@/components/ui/note";
import { PanelControls } from "@/core/panels/PanelChrome";
import { IssueList } from "./IssueList";
import {
    FORMAT_LABELS,
    plural,
    type ImportReport,
    type ImportSummary,
    type PreviewState,
} from "../model/import-report";

/**
 * What the chosen file would add, and anything wrong with it — or, once
 * imported, what it added.
 *
 * Presentational — the screen decides which state it is in.
 */
export function ImportPreviewPanel({ state }: { state: PreviewState }) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>Preview</CardTitle>
                {state.kind !== "empty" && <CardDescription className="truncate">{state.fileName}</CardDescription>}
                <CardAction>
                    <PanelControls />
                </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
                <PreviewBody state={state} />
            </CardContent>
        </Card>
    );
}

function PreviewBody({ state }: { state: PreviewState }) {
    switch (state.kind) {
        case "empty":
            return (
                <p className="text-muted-fg text-sm">
                    Choose a file to see the machines, jobs and operations it would add. The file is checked against the
                    floor first, and every problem is listed with where it is in the file.
                </p>
            );
        case "checking":
            return <p className="text-muted-fg text-sm" role="status">Checking the file…</p>;
        case "failed":
            return (
                <Note intent="danger" role="alert">
                    {state.message}
                </Note>
            );
        case "rejected":
            return (
                <>
                    <Note intent="danger" role="alert">
                        {state.detail}
                    </Note>
                    <IssueList title="Problems" issues={state.issues} intent="danger" />
                    <IssueList title="Warnings" issues={state.warnings} intent="warning" />
                </>
            );
        case "checked":
            return <CheckedReport report={state.report} />;
        case "imported":
            return <ImportedReport report={state.report} />;
    }
}

function CheckedReport({ report }: { report: ImportReport }) {
    return (
        <>
            <div className="flex flex-wrap items-center gap-2">
                {report.format !== null && <Badge intent="secondary">{FORMAT_LABELS[report.format]}</Badge>}
            </div>
            {report.importable ? (
                <Note intent="success" role="status">
                    Ready to import. Nothing has been added yet.
                </Note>
            ) : (
                <Note intent="danger" role="alert">
                    Found {plural(report.issues.length, "problem")}, so this file cannot be imported. Fix the file and
                    choose it again.
                </Note>
            )}
            <IssueList title="Problems" issues={report.issues} intent="danger" />
            <IssueList title="Warnings" issues={report.warnings} intent="warning" />
            {report.summary !== null && <SummaryDetails summary={report.summary} verb="would add" />}
        </>
    );
}

function ImportedReport({ report }: { report: ImportReport }) {
    return (
        <>
            <Note intent="success" role="status">
                Imported {plural(report.jobIds.length, "job")} into the backlog. Generate a schedule for them from the
                Planner.
            </Note>
            <div className="flex flex-wrap gap-2">
                <Link href="/manager/jobs" className={buttonStyles({ intent: "outline", size: "sm" })}>
                    Open Jobs
                </Link>
                <Link href="/manager/planner" className={buttonStyles({ size: "sm" })}>
                    Open the Planner
                </Link>
            </div>
            <IssueList title="Warnings" issues={report.warnings} intent="warning" />
            {report.summary !== null && <SummaryDetails summary={report.summary} verb="added" />}
        </>
    );
}

function SummaryDetails({ summary, verb }: { summary: ImportSummary; verb: string }) {
    const counts = [
        { label: "Jobs", value: summary.jobs },
        { label: "Operations", value: summary.operations },
        { label: "Routes", value: summary.routes },
        { label: "Dependencies", value: summary.dependencies },
        { label: "New machines", value: summary.machinesCreated.length },
        { label: "Reused machines", value: summary.machinesReused.length },
    ];

    return (
        <section aria-label={`What the file ${verb}`} className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {counts.map((count) => (
                    <div key={count.label} className="rounded-lg border px-3 py-2">
                        <dt className="text-muted-fg text-xs">{count.label}</dt>
                        <dd className="font-semibold text-lg tabular-nums">{count.value}</dd>
                    </div>
                ))}
            </dl>
            <NameList title="New machines" names={summary.machinesCreated} />
            <NameList title="Machines already on the floor" names={summary.machinesReused} />
            <NameList title="New categories" names={summary.categoriesCreated} />
        </section>
    );
}

function NameList({ title, names }: { title: string; names: string[] }) {
    if (names.length === 0) return null;
    return (
        <section>
            <h3 className="font-semibold text-sm">
                {title}
                <HeaderCount>{names.length}</HeaderCount>
            </h3>
            <ul className="mt-2 flex flex-wrap gap-1.5">
                {names.map((name) => (
                    <li key={name}>
                        <Badge intent="outline">{name}</Badge>
                    </li>
                ))}
            </ul>
        </section>
    );
}
