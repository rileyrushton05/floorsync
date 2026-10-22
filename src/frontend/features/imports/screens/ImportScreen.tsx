"use client";

import { reportMutationError } from "@/core/feedback/reportMutationError";
import { ApiError } from "@/core/http/client";
import { errorMessage } from "@/core/http/errors";
import { column, row } from "@/core/panels/layout";
import { PanelWorkspace, WorkspacePanel } from "@/core/panels/PanelWorkspace";
import { defineWorkspace, usePanelWorkspace } from "@/core/panels/workspace";
import { ManagerShell } from "@/core/shell/ManagerShell";
import { useImportDryRun, useImportFile } from "@/features/imports/data/queries";
import {
    filterImportJobs,
    plural,
    rejectedIssues,
    toImportReport,
    type PreviewState,
} from "@/features/imports/model/import-report";
import { ImportJobsPanel } from "@/features/imports/ui/ImportJobsPanel";
import { ImportPreviewPanel } from "@/features/imports/ui/ImportPreviewPanel";
import { ImportUploadPanel } from "@/features/imports/ui/ImportUploadPanel";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

const IMPORT_WORKSPACE = defineWorkspace({
    id: "import",
    panels: {
        upload: { title: "Upload", minWidth: 280 },
        preview: { title: "Preview", minWidth: 360 },
        jobs: { title: "Jobs in file", minWidth: 360, minHeight: 200 },
    },
    layout: row(["upload", 28], [column(["preview", 35], ["jobs", 65]), 72]),
});

/**
 * Import machines, jobs and operations from a file. Choosing a file checks it
 * with a dry run straight away; Import is offered only once that finds nothing
 * in the way. Generating a schedule for the new jobs is left to the Planner.
 */
export default function ImportScreen() {
    const workspace = usePanelWorkspace(IMPORT_WORKSPACE);
    const dryRun = useImportDryRun();
    const importFile = useImportFile();

    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<PreviewState>({ kind: "empty" });
    const [jobQuery, setJobQuery] = useState("");
    const [expandedJobs, setExpandedJobs] = useState<ReadonlySet<number>>(new Set());
    // Bumped by every new file or clear, so a slow answer about a file that
    // has since been replaced is dropped rather than shown against the new one.
    const attempt = useRef(0);

    async function chooseFile(next: File) {
        const current = ++attempt.current;
        setFile(next);
        setPreview({ kind: "checking", fileName: next.name });
        setJobQuery("");
        setExpandedJobs(new Set());
        try {
            const report = toImportReport(await dryRun.mutateAsync(next));
            if (current === attempt.current) setPreview({ kind: "checked", fileName: next.name, report });
        } catch (error) {
            if (current !== attempt.current) return;
            setPreview({ kind: "failed", fileName: next.name, message: errorMessage(error) });
            reportMutationError(error);
        }
    }

    function clear() {
        attempt.current++;
        setFile(null);
        setPreview({ kind: "empty" });
    }

    async function runImport() {
        if (file === null || importFile.isPending) return;
        const current = ++attempt.current;
        try {
            const report = toImportReport(await importFile.mutateAsync(file));
            if (current !== attempt.current) return;
            // Ready for the next file; the Preview keeps what this one added.
            setFile(null);
            setPreview({ kind: "imported", fileName: file.name, report });
            toast.success(`Imported ${plural(report.jobIds.length, "job")} from “${file.name}”.`);
        } catch (error) {
            if (current !== attempt.current) return;
            const rejected = rejectedIssues(error instanceof ApiError ? error.problem : null);
            if (rejected !== null) {
                setPreview({ kind: "rejected", fileName: file.name, ...rejected });
                return;
            }
            setPreview({ kind: "failed", fileName: file.name, message: errorMessage(error) });
            reportMutationError(error);
        }
    }

    function toggleJob(index: number) {
        setExpandedJobs((current) => {
            const next = new Set(current);
            if (!next.delete(index)) next.add(index);
            return next;
        });
    }

    const canImport = file !== null && preview.kind === "checked" && preview.report.importable;
    // The file's jobs, while it is being previewed; the panel leaves the layout otherwise.
    const fileJobs = preview.kind === "checked" ? preview.report.jobs : null;
    const visibleJobs = useMemo(() => filterImportJobs(fileJobs ?? [], jobQuery), [fileJobs, jobQuery]);

    return (
        <ManagerShell workspace={workspace}>
            <PanelWorkspace workspace={workspace}>
                <WorkspacePanel id="upload">
                    <ImportUploadPanel
                        fileName={file?.name ?? null}
                        checking={dryRun.isPending}
                        importing={importFile.isPending}
                        canImport={canImport}
                        onFileChosen={(next) => void chooseFile(next)}
                        onClear={clear}
                        onImport={() => void runImport()}
                    />
                </WorkspacePanel>
                <WorkspacePanel id="preview">
                    <ImportPreviewPanel state={preview} />
                </WorkspacePanel>
                {fileJobs !== null && fileJobs.length > 0 && (
                    <WorkspacePanel id="jobs">
                        <ImportJobsPanel
                            jobs={visibleJobs}
                            total={fileJobs.length}
                            query={jobQuery}
                            expanded={expandedJobs}
                            onQueryChange={setJobQuery}
                            onToggle={toggleJob}
                        />
                    </WorkspacePanel>
                )}
            </PanelWorkspace>
        </ManagerShell>
    );
}
