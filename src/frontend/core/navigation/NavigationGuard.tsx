"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { RouterProvider } from "react-aria-components";
import { ConfirmDialog } from "@/core/feedback/ConfirmDialog";

/** What the question looks like when a screen holds work back. */
export interface NavigationGuardPrompt {
    title: string;
    description: string;
    confirmLabel: string;
    cancelLabel: string;
}

const DEFAULT_PROMPT: NavigationGuardPrompt = {
    title: "Leave without saving?",
    description: "This page has changes that have not been saved. Leaving discards them.",
    confirmLabel: "Discard and leave",
    cancelLabel: "Stay on this page",
};

interface NavigationGuardValue {
    /** Report whether the screen currently holds unsaved work, and how to ask about it. */
    setBlocked: (blocked: boolean, prompt: NavigationGuardPrompt | null) => void;
}

const NavigationGuardContext = createContext<NavigationGuardValue>({ setBlocked: () => { } });

/**
 * Add this guard's marker to the current history entry's state.
 *
 * The App Router keeps its own bookkeeping in `history.state`, so the marker is
 * added *alongside* it rather than replacing it — an entry Next does not
 * recognise is an entry it cannot restore the route tree from.
 */
function pushDecoy(): void {
    window.history.pushState(
        { ...window.history.state, __navigationGuard: true },
        "",
        window.location.href,
    );
}

function isDecoy(state: unknown): boolean {
    return typeof state === "object" && state !== null && "__navigationGuard" in state;
}

/**
 * Hold navigation while a screen has unsaved work.
 *
 * Three routes out of a page, three mechanisms, because no one of them sees all
 * three:
 *
 * 1. **In-app links.** Every Intent UI component that takes an `href` navigates
 *    through `RouterProvider`, so wrapping the one `navigate` it is given
 *    catches tabs, buttons and list rows without hunting for click handlers.
 *    The Next App Router exposes no route-change event to cancel, so
 *    intercepting before the push is the only place this can be done at all.
 *
 * 2. **Closing the tab, reloading, typing an address.** `beforeunload`.
 *    Browsers ignore custom text there and show their own wording, so none is
 *    supplied.
 *
 * 3. **Back and forward.** Neither of the above sees these. A history entry is
 *    pushed while the screen is blocked, so the first press of Back lands on
 *    that entry — same URL, nothing visibly changed — and `popstate` fires. The
 *    entry is pushed again to stay put and the question is asked; leaving for
 *    real then goes back past both. When the screen stops being blocked, the
 *    entry is popped again so Back is not left needing two presses.
 *
 * The blocked flag lives in a ref as well as state: `navigate` is handed to
 * `RouterProvider` once, and a stale closure over a state value would let a
 * navigation through using whatever the flag was when it was created. The state
 * copy is what the `popstate` listener keys off.
 */
export function NavigationGuardProvider({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const blockedRef = useRef(false);
    const promptRef = useRef<NavigationGuardPrompt>(DEFAULT_PROMPT);
    const [blocked, setBlockedState] = useState(false);
    // The prompt travels with the held-back navigation rather than living in
    // provider state: its description names the job being edited, so keeping it
    // in state would re-render the whole app on every keystroke.
    /** A navigation this guard has approved: its own cleanup must not fight it. */
    const leavingRef = useRef(false);
    const [pending, setPending] = useState<
        | { kind: "href"; href: string; prompt: NavigationGuardPrompt }
        | { kind: "back"; prompt: NavigationGuardPrompt }
        | null
    >(null);

    const setBlocked = useCallback((next: boolean, prompt: NavigationGuardPrompt | null) => {
        blockedRef.current = next;
        if (prompt) promptRef.current = prompt;
        setBlockedState(next);
    }, []);

    const navigate = useCallback(
        (href: string) => {
            if (blockedRef.current) setPending({ kind: "href", href, prompt: promptRef.current });
            else router.push(href);
        },
        [router],
    );

    useEffect(() => {
        function warnBeforeUnload(event: BeforeUnloadEvent) {
            if (!blockedRef.current) return;
            event.preventDefault();
            // Assigning returnValue is what actually triggers the prompt in the
            // browsers that still require it; the string itself is never shown.
            event.returnValue = "";
        }

        window.addEventListener("beforeunload", warnBeforeUnload);
        return () => window.removeEventListener("beforeunload", warnBeforeUnload);
    }, []);

    useEffect(() => {
        if (!blocked) return;
        leavingRef.current = false;

        // One decoy is enough: re-blocking while ours is still the current entry
        // would stack them, and Back would then need a press per edit.
        if (!isDecoy(window.history.state)) pushDecoy();

        function onPopState() {
            if (!blockedRef.current) return;
            // Back moved off the decoy. Put it back so the page stays where it
            // is, then ask — answering "leave" is what actually goes back.
            pushDecoy();
            setPending({ kind: "back", prompt: promptRef.current });
        }

        window.addEventListener("popstate", onPopState);
        return () => {
            window.removeEventListener("popstate", onPopState);
            // The block simply went away — saved, or the edit undone — so take
            // the decoy back out, or Back would need a press to get past an
            // entry the manager never navigated to.
            //
            // Not when a navigation was approved: that is already moving the
            // history stack (a push, or the `go(-2)` below), and stepping back
            // here would race it and undo it. The screen unmounting on the way
            // out clears `blocked` too, which is exactly when this would fire.
            if (!leavingRef.current && isDecoy(window.history.state)) window.history.back();
        };
    }, [blocked]);

    return (
        <NavigationGuardContext.Provider value={{ setBlocked }}>
            <RouterProvider navigate={navigate}>
                {children}
                {pending !== null && (
                    <ConfirmDialog
                        title={pending.prompt.title}
                        description={pending.prompt.description}
                        confirmLabel={pending.prompt.confirmLabel}
                        cancelLabel={pending.prompt.cancelLabel}
                        danger
                        onCancel={() => setPending(null)}
                        onConfirm={() => {
                            // Clear the block first: the screen unmounts on the
                            // way out, and leaving it set would hold the *next*
                            // navigation hostage too.
                            leavingRef.current = true;
                            blockedRef.current = false;
                            setBlockedState(false);
                            setPending(null);
                            // A link leaves the decoy behind it — removing it
                            // here would race the push. It shares the current
                            // page's URL, so the only trace is one extra Back
                            // press to get past this page.
                            if (pending.kind === "href") router.push(pending.href);
                            // Two entries back: the decoy that was re-pushed,
                            // and the page itself.
                            else window.history.go(-2);
                        }}
                    />
                )}
            </RouterProvider>
        </NavigationGuardContext.Provider>
    );
}

/**
 * Block navigation away from this screen while `blocked` is true.
 *
 * `prompt` is how the question is worded — it belongs to the screen, which is
 * the only thing that knows what is about to be lost. The flag is cleared on
 * unmount, so a screen can never leave the guard armed behind it.
 */
export function useNavigationGuard(blocked: boolean, prompt: NavigationGuardPrompt) {
    const { setBlocked } = useContext(NavigationGuardContext);
    // Held in a ref so re-wording on every keystroke — the description names the
    // job being edited — does not re-arm the guard and churn the history entry.
    // Synced in its own effect, declared first so it has already run by the time
    // the one below reads it.
    const promptRef = useRef(prompt);
    useEffect(() => {
        promptRef.current = prompt;
    });

    useEffect(() => {
        setBlocked(blocked, promptRef.current);
        return () => setBlocked(false, null);
    }, [blocked, setBlocked]);
}
