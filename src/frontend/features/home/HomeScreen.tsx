import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/components/ui/link";

const SECTIONS: { href: string; title: string; blurb: string; tag: string }[][] = [
  [
    {
      href: "/manager",
      title: "Manager overview",
      blurb: "Facility-wide KPIs, job progress and machine status.",
      tag: "Mock UI · frontend only",
    },
    {
      href: "/manager/jobs",
      title: "Jobs",
      blurb: "Define independent jobs and their ordered operations.",
      tag: "Feeds the scheduler",
    },
  ],
  [
    {
      href: "/manager/planner",
      title: "Planner",
      blurb: "Release jobs and generate a plan from operation order and machine load.",
      tag: "Plan · not clock-driven",
    },
    {
      href: "/manager/simulation",
      title: "Simulation",
      blurb: "Run a generated plan forward and watch the shop floor move through it.",
      tag: "Playback of a plan",
    },
    {
      href: "/operator",
      title: "Operator dashboard",
      blurb: "Machine queue, current operation and live status.",
      tag: "Mock UI · frontend only",
    },
  ],
];

export default function HomePage() {
  return (
    <div className="theme-navy min-h-dvh bg-bg text-fg">
      <main className="mx-auto max-w-[980px] px-6 py-22">
        <p className="font-bold text-primary text-sm uppercase tracking-[0.08em]">
          FloorSync · Foundation
        </p>
        <h1 className="my-4 max-w-[850px] text-[clamp(2.5rem,6vw,4.6rem)] leading-[1.05] tracking-tight">
          Application foundation.
        </h1>
        <p className="text-lg text-muted-fg">
          The frontend, API, worker and local development environment are ready for the team&rsquo;s
          next decisions.
        </p>

        {SECTIONS.map((section, index) => (
          <section
            key={index}
            className="mt-12 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4"
          >
            {section.map((item) => (
              <Card key={item.href} className="relative bg-overlay p-6">
                <CardHeader className="p-0">
                  <CardTitle>
                    <Link
                      href={item.href}
                      className="text-primary text-lg no-underline after:absolute after:inset-0 hover:underline"
                    >
                      {item.title}
                    </Link>
                  </CardTitle>
                  <CardDescription className="text-fg">{item.blurb}</CardDescription>
                </CardHeader>
                <Badge intent="primary" className="mt-4 w-fit">
                  {item.tag}
                </Badge>
              </Card>
            ))}
          </section>
        ))}
      </main>
    </div>
  );
}
