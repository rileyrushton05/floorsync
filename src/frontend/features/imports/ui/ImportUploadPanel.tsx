import { Button, buttonStyles } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { PanelControls } from "@/core/panels/PanelChrome";
import { ArrowDownTrayIcon, ArrowUpTrayIcon, DocumentTextIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { cn } from "cn";
import { DropZone } from "react-aria-components/DropZone";
import { FileTrigger } from "react-aria-components/FileTrigger";
import { isFileDropItem } from "react-aria-components/useDrop";
import { useRef } from "react";
import { ACCEPTED_FILE_TYPES, EXAMPLE_FILE_URL } from "../model/import-report";

/**
 * Where a manager picks the file: a drop zone, a file picker, the example to
 * start from, and the Import button.
 *
 * Presentational — it reports a chosen file through `onFileChosen` and never
 * uploads anything itself.
 */
export function ImportUploadPanel({
    fileName,
    checking,
    importing,
    canImport,
    onFileChosen,
    onClear,
    onImport,
}: {
    fileName: string | null;
    /** The dry run for the chosen file is in flight. */
    checking: boolean;
    importing: boolean;
    /** The dry run found nothing in the way. */
    canImport: boolean;
    onFileChosen: (file: File) => void;
    onClear: () => void;
    onImport: () => void;
}) {
    const busy = checking || importing;
    const inputRef = useRef<HTMLInputElement>(null);

    return (
        <Card>
            <CardHeader>
                <CardTitle>Upload</CardTitle>
                <CardDescription>
                    A FloorSync JSON file, or a job-shop or flexible job-shop benchmark. Nothing is added until you press Import.
                </CardDescription>
                <CardAction>
                    <PanelControls />
                </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <DropZone
                    isDisabled={busy}
                    getDropOperation={(types) => (ACCEPTED_FILE_TYPES.some((type) => types.has(type)) ? "copy" : "cancel")}
                    onDrop={async (event) => {
                        const item = event.items.find(isFileDropItem);
                        if (item) onFileChosen(await item.getFile());
                    }}
                    className={({ isDropTarget, isFocusVisible }) =>
                        cn(
                            "flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-4 py-8 text-center outline-hidden transition-colors",
                            isDropTarget ? "border-primary bg-primary/5" : "border-border",
                            isFocusVisible && "ring-2 ring-ring",
                        )
                    }
                >
                    <ArrowUpTrayIcon aria-hidden className="size-8 text-muted-fg" />
                    <p className="text-muted-fg text-sm">Drop a JSON file here, or</p>
                    <FileTrigger
                        ref={inputRef}
                        acceptedFileTypes={ACCEPTED_FILE_TYPES}
                        onSelect={(files) => {
                            const file = files?.[0];
                            // Cleared so picking the same file again, once fixed, is still a change.
                            if (inputRef.current) inputRef.current.value = "";
                            if (file) onFileChosen(file);
                        }}
                    >
                        <Button intent="outline" size="sm" isDisabled={busy}>
                            Choose file
                        </Button>
                    </FileTrigger>
                </DropZone>

                {fileName !== null && (
                    <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                        <DocumentTextIcon aria-hidden className="size-5 shrink-0 text-muted-fg" />
                        <span className="min-w-0 flex-1 truncate font-medium" title={fileName}>
                            {fileName}
                        </span>
                        <Button intent="plain" size="sq-xs" aria-label="Clear file" isDisabled={busy} onPress={onClear}>
                            <XMarkIcon />
                        </Button>
                    </div>
                )}

                <Button isDisabled={!canImport || checking} isPending={importing} onPress={onImport}>
                    Import
                </Button>

                <Link
                    href={EXAMPLE_FILE_URL}
                    download="import-example.json"
                    className={buttonStyles({ intent: "plain", size: "sm" })}
                >
                    <ArrowDownTrayIcon className="size-4" /> Download example file
                </Link>
            </CardContent>
        </Card>
    );
}
