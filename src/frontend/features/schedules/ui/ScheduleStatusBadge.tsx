import { Badge } from "@/components/ui/badge";

/**
 * Status badge shared by the inventory rows and the detail header. The API's
 * "discarded" state is spoken as "Archived" — this is the archive screen.
 */
export function ScheduleStatusBadge({ status }: { status: "confirmed" | "draft" | "archived" }) {
    switch (status) {
        case "confirmed":
            return <Badge intent="success">Confirmed</Badge>;
        case "draft":
            return <Badge intent="warning">Draft</Badge>;
        case "archived":
            return <Badge intent="secondary">Archived</Badge>;
    }
}
