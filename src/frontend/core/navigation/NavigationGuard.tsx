"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { RouterProvider } from "react-aria-components";
import { ConfirmDialog } from "@/core/feedback/ConfirmDialog";

interface NavigationGuardValue {
    /** Report whether the screen currently holds unsaved work. */
    setBlocked: (blocked: boolean) => void;
}

const NavigationGuardContext = createContext<NavigationGuardValue>({ setBlocked: () => { } });

/**
 * Hold navigation while a screen has unsaved work.
 *
 * Every Intent UI component that takes an `href` navigates through
 * `RouterProvider`, so wrapping the one `navigate` it is given catches every
 * in-app link — tabs, buttons, list rows — without hunting for click handlers.
 * The Next App Router exposes no route-change event to cancel, so intercepting
 * before the push is the only place this can be done at all.
 *
 * `beforeunload` covers what a router cannot see: closing the tab, reloading,
 * or typing a different address. Browsers ignore custom text there and show
 * their own wording, so none is supplied.
 *
 * The blocked flag lives in a ref rather than state on purpose — `navigate` is
 * handed to `RouterProvider` once, and a stale closure over a state value would
 * let a navigation through using whatever the flag was when it was created.
 */
export function NavigationGuardProvider({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const blockedRef = useRef(false);
    const [pendingHref, setPendingHref] = useState<string | null>(null);

    const setBlocked = useCallback((blocked: boolean) => {
        blockedRef.current = blocked;
    }, []);

    const navigate = useCallback(
        (href: string) => {
            if (blockedRef.current) setPendingHref(href);
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

    return (
        <NavigationGuardContext.Provider value={{ setBlocked }}>
            <RouterProvider navigate={navigate}>
                {children}
                {pendingHref !== null && (
                    <ConfirmDialog
                        title="Leave without saving?"
                        description="This job has changes that have not been saved. Leaving this page discards them."
                        confirmLabel="Discard and leave"
                        cancelLabel="Stay on this page"
                        danger
                        onCancel={() => setPendingHref(null)}
                        onConfirm={() => {
                            // Clear the block first: the screen unmounts on the
                            // push, and leaving it set would hold the *next*
                            // navigation hostage too.
                            blockedRef.current = false;
                            setPendingHref(null);
                            router.push(pendingHref);
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
 * The flag is cleared on unmount, so a screen can never leave the guard armed
 * behind it.
 */
export function useNavigationGuard(blocked: boolean) {
    const { setBlocked } = useContext(NavigationGuardContext);

    useEffect(() => {
        setBlocked(blocked);
        return () => setBlocked(false);
    }, [blocked, setBlocked]);
}
