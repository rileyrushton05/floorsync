"use client";

import { Link } from "@/components/ui/link";
import { Logo } from "@/core/shell/Logo";
import { ArrowRightIcon, ChartBarSquareIcon, WrenchScrewdriverIcon } from "@heroicons/react/24/outline";

const ROLES = [
  {
    href: "/manager",
    label: "Manager",
    blurb: "Plan jobs, generate schedules and watch the floor.",
    icon: ChartBarSquareIcon,
  },
  {
    href: "/operator",
    label: "Operator",
    blurb: "See your machine's queue and current operation.",
    icon: WrenchScrewdriverIcon,
  },
];

export default function HomePage() {
  return (
    <main className="theme-navy flex min-h-dvh flex-col items-center justify-center bg-bg px-6 py-16 text-fg">
      <div className="flex items-center gap-3">
        <Logo className="size-11 shrink-0" />
        <h1 className="m-0 font-bold text-4xl tracking-tight">FloorSync</h1>
      </div>
      <p className="mt-3 text-center text-muted-fg">
        Production scheduling for the shop floor. Choose how you&rsquo;re signing in.
      </p>

      <div className="mt-10 grid w-full max-w-xl gap-4 sm:grid-cols-2">
        {ROLES.map((role) => {
          const Icon = role.icon;
          return (
            <Link
              key={role.href}
              href={role.href}
              className="group flex flex-col gap-3 rounded-xl border bg-overlay p-6 no-underline shadow-xs transition hover:border-primary hover:no-underline hover:shadow-md"
            >
              <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="size-5.5" />
              </span>
              <span className="flex items-center gap-1.5 font-bold text-fg text-lg">
                {role.label}
                <ArrowRightIcon className="size-4 text-primary transition-transform group-hover:translate-x-0.5" />
              </span>
              <span className="text-muted-fg text-sm">{role.blurb}</span>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
