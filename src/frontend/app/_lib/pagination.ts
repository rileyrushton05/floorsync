import type { CursorPage } from "./api";

/** Exhaust a cursor-paginated API collection while preserving query cancellation. */
export async function fetchEveryPage<Item>(
    readPage: (cursor: string | undefined, signal: AbortSignal) => Promise<CursorPage<Item>>,
    signal: AbortSignal,
): Promise<Item[]> {
    const all: Item[] = [];
    let cursor: string | undefined;
    do {
        const page = await readPage(cursor, signal);
        all.push(...page.items);
        cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return all;
}
