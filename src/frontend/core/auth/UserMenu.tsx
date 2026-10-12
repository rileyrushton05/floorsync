"use client";

import { ArrowRightStartOnRectangleIcon, Cog6ToothIcon, UserCircleIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import { Button, buttonStyles } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { useAuth } from "./AuthProvider";

/**
 * The signed-in account, and the way out.
 *
 * Shared by every dashboard topbar so sign-out is reachable from wherever
 * somebody happens to be, and so the name shown is the account actually holding
 * the token rather than a label baked into the page. The cog is how operators,
 * who have no sidebar, reach Settings.
 */
export function UserMenu() {
    const { user, signOut } = useAuth();
    const router = useRouter();

    if (user === null) return null;

    return (
        <div className="flex items-center gap-2">
            <UserCircleIcon className="size-7 shrink-0 text-muted-fg" aria-hidden />
            <span className="leading-tight whitespace-nowrap">
                <span className="block font-semibold text-sm">{user.name}</span>
                <span className="block text-muted-fg text-xs capitalize">{user.role}</span>
            </span>
            {/* A Link, not router.push, so the navigation guard can hold it for unsaved work. */}
            <Link href="/settings" aria-label="Settings" className={buttonStyles({ intent: "plain", size: "sq-sm" })}>
                <Cog6ToothIcon />
            </Link>
            <Button
                intent="plain"
                size="sq-sm"
                aria-label={`Sign out ${user.name}`}
                onPress={() => {
                    signOut();
                    router.replace("/login");
                }}
            >
                <ArrowRightStartOnRectangleIcon />
            </Button>
        </div>
    );
}
