/**
 * The one icon FloorSync needs that Heroicons — the set Intent UI itself draws
 * from — does not ship. Everything else comes straight from
 * `@heroicons/react/24/outline`.
 *
 * Unlike the hand-rolled icon sheets this replaced, it paints with
 * `currentColor`, so it inherits whichever surface it is dropped onto.
 */
export function CoffeeIcon({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
            <path
                d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
            />
            <path d="M17 10.5h1.5a2.5 2.5 0 0 1 0 5H17" stroke="currentColor" strokeWidth="1.5" />
            <path
                d="M8 4.5c0 1-1 1-1 2M12 4.5c0 1-1 1-1 2"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
            />
        </svg>
    );
}
