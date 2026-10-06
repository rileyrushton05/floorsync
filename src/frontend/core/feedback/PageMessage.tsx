import { Note } from "@/components/ui/note";

/** A focused, accessible page-level loading, empty or failure message. */
export function PageMessage({
    title,
    children,
    tone = "info",
}: {
    title: string;
    children: React.ReactNode;
    tone?: "info" | "danger";
}) {
    return (
        <Note intent={tone === "danger" ? "danger" : "default"} className="max-w-lg">
            <strong>{title}</strong>
            <div className="mt-1 text-sm">{children}</div>
        </Note>
    );
}
