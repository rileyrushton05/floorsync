import { Badge } from "@/components/ui/badge";

/**
 * Status badge shared by the inventory rows and the detail header.
 */
export function ScheduleStatusBadge({ status }: { status: "confirmed" | "draft" | "discarded" }) {
    switch (status) {
        case "confirmed":
            return <Badge intent="success">Confirmed</Badge>;
        case "draft":
            return <Badge intent="warning">Draft</Badge>;
        case "discarded":
            return <Badge intent="secondary">Discarded</Badge>;
    }
}
