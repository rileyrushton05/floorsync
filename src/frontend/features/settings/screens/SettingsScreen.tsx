"use client";

import { useTheme } from "@/components/theme-provider";
import { Link } from "@/components/ui/link";
import { useAuth } from "@/core/auth/AuthProvider";
import { UserMenu } from "@/core/auth/UserMenu";
import { Wordmark } from "@/core/shell/Logo";
import { ManagerShell } from "@/core/shell/ManagerShell";
import { ThemePicker } from "@/features/settings/ui/ThemePicker";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";

/**
 * Personal settings, reachable by every signed-in account.
 *
 * Managers see it inside the usual manager chrome; operators get a slim header
 * with the way back to their queue, matching their own dashboard.
 *
 * Preferences here belong to this browser, not the account: the theme is kept
 * in a cookie, so a shared shop-floor terminal keeps whatever was picked on it.
 */
export default function SettingsScreen() {
    const { user } = useAuth();

    const content = (
        <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-5 sm:py-8">
            <AppearanceSection />
        </main>
    );

    if (user?.role === "manager") return <ManagerShell>{content}</ManagerShell>;

    return (
        <div className="flex min-h-dvh flex-col bg-bg text-fg">
            <header className="flex flex-wrap items-center gap-4 border-b bg-navbar px-5 py-3">
                <div className="flex items-center gap-2.5">
                    <Wordmark />
                    <span className="border-l pl-2.5 font-bold text-muted-fg text-xs uppercase tracking-[0.06em]">
                        Settings
                    </span>
                </div>
                <Link href="/operator" className="flex items-center gap-1.5 text-muted-fg text-sm hover:text-fg">
                    <ArrowLeftIcon className="size-4" aria-hidden />
                    Back to queue
                </Link>
                <div className="flex-1" />
                <UserMenu />
            </header>
            {content}
        </div>
    );
}

function AppearanceSection() {
    const { theme, setTheme } = useTheme();

    return (
        <section aria-labelledby="appearance-heading" className="flex flex-col gap-5">
            <div>
                <h2 id="appearance-heading" className="m-0 font-bold text-lg tracking-tight">
                    Appearance
                </h2>
                <p className="mt-1 text-muted-fg text-sm">
                    Pick how FloorSync looks in this browser. Changes apply straight away.
                </p>
            </div>
            <ThemePicker value={theme} onChange={setTheme} />
        </section>
    );
}
