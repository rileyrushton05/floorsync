import { Link } from "@/components/ui/link";

export function Logo({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
            <rect width="24" height="24" rx="6" className="fill-primary" />
            <path d="M6 17V11.5" className="stroke-primary-fg" strokeWidth="2" strokeLinecap="round" />
            <path d="M10.4 17V7.5" className="stroke-primary-fg" strokeWidth="2" strokeLinecap="round" />
            <path d="M14.8 17V13.5" className="stroke-primary-fg" strokeWidth="2" strokeLinecap="round" />
            <path d="M19.2 17V9.5" className="stroke-primary-fg" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

export function Wordmark({ href = "/" }: { href?: string }) {
    return (
        <Link
            href={href}
            aria-label="FloorSync home"
            className="inline-flex items-center gap-2 no-underline hover:no-underline"
        >
            <Logo className="size-6.5 shrink-0" />
            <span className="font-bold text-fg text-xl tracking-tight">FloorSync</span>
        </Link>
    );
}
