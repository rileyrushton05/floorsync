import { Badge } from "@/components/ui/badge";

/**
 * Status badge shared by the inventory rows and the detail header.
 *
 * `discarded` reads "Withdrawn" because that is what a manager did to it: only
 * a confirmed schedule can be discarded, and it can be restored again.
 */
export function ScheduleStatusBadge({ status }: { status: "confirmed" | "draft" | "discarded" }) {
    switch (status) {
        case "confirmed":
            return <Badge intent="success">Confirmed</Badge>;
        case "draft":
            return <Badge intent="warning">Draft</Badge>;
        case "discarded":
            return <Badge intent="secondary">Withdrawn</Badge>;
    }
}
