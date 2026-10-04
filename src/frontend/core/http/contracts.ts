/** A cursor-paginated API collection. Endpoint modules use this shared wire contract. */
export interface CursorPage<Item> {
    items: Item[];
    next_cursor: string | null;
}

/** One invalid request parameter in the API's RFC 9457 problem response. */
export interface InvalidParameter {
    name: string;
    reason: string;
}

/**
 * The API's complete, user-safe failure contract.
 *
 * Keep this wire shape intact at the transport boundary. Feature screens may
 * choose where to display it, but must not invent a competing explanation for
 * a backend rejection.
 */
export interface ProblemDetail {
    type: string;
    title: string;
    status: number;
    detail: string | null;
    instance: string | null;
    invalid_params: InvalidParameter[] | null;
    /**
     * Every other member the API sent, by its wire name.
     *
     * RFC 9457 lets a problem carry members of its own, and the API uses them
     * to say what a refusal was *about* — which schedules block a delete, which
     * status took a job out of the backlog. Kept as received: the transport
     * cannot know which problem types a screen understands, and a feature that
     * knows its own refusal reads what it needs from here.
     */
    extensions: Record<string, unknown>;
}
