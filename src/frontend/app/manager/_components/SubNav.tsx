"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./SubNav.module.css";

const TABS = [
    { href: "/manager", label: "Overview" },
    { href: "/manager/jobs", label: "Jobs" },
    { href: "/manager/scheduler", label: "Schedule" },
    { href: "/manager/simulation", label: "Simulation" },
];

export function SubNav() {
    const pathname = usePathname();
    return (
        <nav className={styles.nav} aria-label="Manager sections">
            {TABS.map((tab) => {
                const active = pathname === tab.href;
                return (
                    <Link
                        key={tab.href}
                        href={tab.href}
                        className={`${styles.tab} ${active ? styles.tabActive : ""}`}
                        aria-current={active ? "page" : undefined}
                    >
                        {tab.label}
                    </Link>
                );
            })}
        </nav>
    );
}
