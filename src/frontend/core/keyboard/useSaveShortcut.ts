"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * Ctrl+S / ⌘S runs `onSave` while the calling screen is mounted.
 *
 * Bound on the window rather than on a form: an editor screen is usually
 * edited from more than one panel, so the cursor is rarely inside the thing
 * being saved. The default is always prevented — letting the browser's "Save
 * page as…" sheet open instead would be a worse answer to the shortcut than
 * doing nothing.
 *
 * The handler is read through a ref so the listener is attached once, yet
 * always sees the screen's current state rather than the state it had when the
 * listener was added.
 */
export function useSaveShortcut(onSave: () => void): void {
    const handlerRef = useRef(onSave);
    useEffect(() => {
        handlerRef.current = onSave;
    });

    useEffect(() => {
        function onKeyDown(event: KeyboardEvent) {
            const chord = (event.metaKey || event.ctrlKey) && !event.altKey;
            if (!chord || event.key.toLowerCase() !== "s") return;
            event.preventDefault();
            // Holding the keys down should ask once, not once per repeat.
            if (!event.repeat) handlerRef.current();
        }

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);
}

/**
 * Which save chord to print, or null while there is no platform to ask.
 *
 * The server cannot know, and guessing then correcting on hydration would flash
 * the wrong label. `useSyncExternalStore` is the shape for exactly this: a
 * server snapshot of null, a client snapshot read off the platform, and no
 * subscription because the answer never changes within a session.
 */
export function useSaveShortcutLabel(): string | null {
    return useSyncExternalStore(NEVER_CHANGES, readShortcut, noShortcutOnServer);
}

const NEVER_CHANGES = () => () => { };
const readShortcut = () =>
    /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent) ? "⌘S" : "Ctrl+S";
const noShortcutOnServer = () => null;
