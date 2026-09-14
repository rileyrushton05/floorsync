/** A cursor-paginated API collection. Endpoint modules use this shared wire contract. */
export interface CursorPage<Item> {
    items: Item[];
    next_cursor: string | null;
}
