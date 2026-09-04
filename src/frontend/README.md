# Frontend

Next.js 16 (App Router) + React 19 + TypeScript. No UI/component library and no
CSS framework — plain CSS Modules, styled by hand to match the FloorSync visual
design.

## Getting started

This package is pinned to **pnpm** (`packageManager` in `package.json`); Corepack
provides the right version. Use pnpm, not npm — see *Known gaps* below.

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

Other scripts:

| Command | Purpose |
| --- | --- |
| `pnpm build` | Production build (also type-checks) |
| `pnpm start` | Serve the production build |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint (`eslint-config-next`) |

Run `pnpm typecheck` and `pnpm lint` before opening a PR — both must be clean.

## The planning model

The manager area is built around one idea: **a schedule is generated from job
definitions, not drawn on a calendar.** The flow has three stages, each with its
own route, because they answer three different questions.

```text
  /manager/jobs            /manager/scheduler          /manager/simulation
┌──────────────────┐     ┌────────────────────┐      ┌────────────────────┐
│ Define jobs:     │     │ Tick the jobs to   │      │ Run the clock      │
│ operations,      │ ──► │ release, press     │ ──►  │ across that plan   │
│ machines,        │     │ Generate           │      │ and watch it move  │
│ durations,       │     │                    │      │                    │
│ dependencies     │     │ "What IS the plan?"│      │ "What does the shop│
│                  │     │                    │      │  look like at T+N?"│
└──────────────────┘     └────────────────────┘      └────────────────────┘
```

**Time is relative.** A generated schedule has no dates and no wall clock. Every
position is *minutes elapsed from T+0*, the moment the plan is released, and the
Gantt axis is labelled `T+0h, 1h, 2h…`. Picking a calendar day is a separate
concern the backend can layer on later; nothing in the generator depends on it.

**Viewing a plan and simulating it are deliberately separate.** The scheduler has
no play button, no speed control and no moving line — it shows the plan at full
strength, coloured by job so one job can be traced across machines. The
simulation has the transport controls and re-shades that same geometry by where
the clock has reached. They share one `GanttChart` component so the geometry is
identical and only the *reading* differs.

### How generation works

`app/manager/_lib/scheduling.ts` is a pure module with no React in it.
`generateSchedule(jobs, machines, selectedIds)` returns either a schedule or a
list of human-readable problems.

1. **Validate** — the selection is non-empty, every job has operations with a
   positive duration on a machine that exists, and every dependency is *itself
   in the selection*. Scheduling a job whose prerequisite was not released is
   refused rather than silently ignored.
2. **Order** — Kahn's algorithm over the dependency graph, breaking ties by
   priority (High → Med → Low) and then by id, so the same selection always
   produces the same plan. A dependency cycle is reported, not thrown.
3. **Place** — walk the jobs in that order and give each operation the earliest
   slot on its machine that respects the previous operation in the same job, the
   machine's existing bookings, and the finish time of every job it depends on.
   Gaps are backfilled, so a short job drops into a machine's idle window instead
   of being appended after it.

It is a greedy list scheduler: it will not reorder or pre-empt to shorten the
makespan, so the result is not optimal. It is deterministic and every placement
is explainable, which matters more for a plan a person has to trust — the
scheduler's *Placement order* table shows exactly which job was placed when and
why.

The algorithm's invariants (no machine double-booked, operations sequential
within a job, durations preserved, dependencies respected, determinism, cycle
and missing-dependency detection) are worth pinning down in tests — see
*Known gaps*.

## Project structure

```text
app/
├── layout.tsx                     # Root layout, imports styles.css globally
├── styles.css                     # Global reset ONLY — see "Styling conventions"
├── page.tsx                       # "/" landing page
├── home.module.css
│
├── _components/                   # Shared across every route
│   ├── Logo.tsx                   # <Logo> mark and <Wordmark> home link
│   ├── Badge.tsx                  # Status/priority pill + tone helpers
│   └── Badge.module.css
│
├── manager/
│   ├── layout.tsx                 # Wraps every /manager route in PlanningProvider
│   ├── icons.tsx                  # Inline SVG icon set for the manager area
│   │
│   ├── _lib/                      # Pure domain logic — no React
│   │   ├── types.ts               # JobDef, ScheduledOperation, GeneratedSchedule…
│   │   ├── scheduling.ts          # generateSchedule + validation + formatting
│   │   ├── colors.ts              # Validated categorical palette for job identity
│   │   └── seed.ts                # Starting machines and backlog
│   │
│   ├── _components/
│   │   ├── PlanningProvider.tsx   # Backlog + selection + generated plan (context)
│   │   ├── SubNav.tsx             # Overview / Jobs / Schedule / Simulation tabs
│   │   ├── GanttChart.tsx         # The schedule grid, shared by plan + simulation
│   │   └── *.module.css
│   │
│   ├── page.tsx                   # /manager — facility KPI overview
│   ├── manager.module.css
│   ├── jobs/                      # /manager/jobs — job + dependency builder
│   ├── scheduler/                 # /manager/scheduler — release & generate
│   └── simulation/                # /manager/simulation — plan playback
│
└── operator/                      # /operator — single-machine job queue
    ├── page.tsx
    ├── operator.module.css
    └── icons.tsx
```

## Routes

### `/` — Landing (`app/page.tsx`)

Server component. The only page using the dark palette from the global
`styles.css`; every dashboard overrides it with its own light theme. Cards link
into each area of the app.

---

### `/manager` — Overview (`app/manager/page.tsx`)

Client component. Facility-wide weekly KPI overview: four stat cards (total jobs
with a completed/in-progress/pending legend, on-time completion, machine
utilisation, active operators), a job list table, a selected-job detail panel
with an expandable operation sequence, and a machines overview.

This page still runs on its own hardcoded `weeks` array and is **not** yet
connected to the planning flow — see *Known gaps*.

---

### `/manager/jobs` — Job builder (`app/manager/jobs/page.tsx`)

Where the backlog is written. Two columns:

**Backlog (left)** — every defined job as a card: colour swatch, id, priority,
operation count, total machine time, and its dependencies. Click to edit.

**Editor (right)** — name and priority, then:

- **Operations** — an ordered, editable list. Each row is a name, a machine and
  a duration in minutes. Rows can be reordered (↑/↓) or removed. *Order is
  precedence*: operation n+1 cannot start until operation n finishes, so moving
  a row rewrites the job's internal dependency chain.
- **Dependencies** — a checklist of the other jobs that must finish before this
  one starts. Any job that already depends on the one being edited is **disabled
  with an explanation**, so a cycle cannot be created in the first place rather
  than being caught later at generation time.
- A reverse-dependency note ("3 jobs wait on this one") and a live summary of
  operation count, total machine time and machines touched.

Validation runs on save and lists every problem at once.

---

### `/manager/scheduler` — Release & generate (`app/manager/scheduler/page.tsx`)

**No date navigation, no playback controls.** Three columns:

**Release to schedule (left)** — a checkbox per backlog job with its priority,
operation count and work time. A job whose dependency is not also ticked is
flagged inline in red *before* generation is attempted. Select-all / clear, and
a running total of selected machine time.

**Generated plan (centre)** — the `GanttChart` in `plan` mode, or an empty state
explaining what Generate will do, or a validation panel listing why the current
selection cannot be scheduled. A **stale banner** appears if job definitions were
edited after the plan was generated; plans are never silently regenerated
underneath the manager.

**Plan summary (right)** — makespan and job count, per-machine utilisation bars,
and the **placement order** table: the order the generator worked in, with each
job's start and finish offsets. Clicking a row (or a legend entry, or a block)
traces that job across the grid by dimming the rest. The table doubles as the
chart's text equivalent, so the plan is fully readable without relying on colour.

---

### `/manager/simulation` — Plan playback (`app/manager/simulation/page.tsx`)

Runs the last generated plan forward. Nothing here changes the plan.

**Transport** — play/pause, reset, and a speed selector expressed in shop-minutes
per real second (`1×` = 1 min/s, `10×`, `60×` = one hour per second). A `T+`
readout and a **scrubber** for jumping to any point; scrubbing pauses playback.

**Machines now (left)** — per machine: Running (with the job, operation, a
progress bar and its finish offset), Idle (with when the next job arrives), or
Done.

**Plan playback (centre)** — the same `GanttChart` in `simulation` mode: a "now"
line, and blocks re-shaded by state — pale with a `✓` for completed, full
strength with a `▶` and an elapsed bar for running, very pale for upcoming.
Overall counters above it.

**Job progress (right)** — operations completed per job and its live state.

If no plan has been generated, the page says so and links to the scheduler.

---

### `/operator` — Operator dashboard (`app/operator/page.tsx`)

Client component, one machine's work. Current Operation with **Mark Complete**
(which advances within the job, then promotes the queue head, then goes idle),
Next Operation, shift and break counters, and pending/completed operation
tables. Starting a queued job out of order pauses the active one back onto the
front of the queue.

Still on its own hardcoded `initialMachine` — it does not yet read from a
generated schedule.

## State and the API seam

`PlanningProvider` (`app/manager/_components/PlanningProvider.tsx`) holds the
backlog, the selection and the generated plan for every `/manager` route. It is
**in-memory only**: client-side navigation between the tabs preserves everything,
but a browser reload resets to the seed backlog and clears the plan.

That provider is the seam the API will replace. Its actions (`createJob`,
`updateJob`, `deleteJob`, `generate`, …) are already the shape of the calls the
backend will need to serve; `generateSchedule` itself will likely move server-side
once the solver is real.

| File | Structure | Replaced by |
| --- | --- | --- |
| `manager/_lib/seed.ts` | `SEED_MACHINES`, `SEED_JOBS` | Machine + job endpoints |
| `manager/_lib/scheduling.ts` | `generateSchedule` | The backend solver |
| `manager/page.tsx` | `weeks: WeekData[]` | KPI rollup endpoint |
| `operator/page.tsx` | `initialMachine: MachineState` | Per-machine queue endpoint / WebSocket |

## Styling conventions

- **One CSS Module per route**, colocated with its `page.tsx`. Each module's
  outer wrapper class (`.shell`) sets its own background, colour and font so
  pages don't depend on global state.
- **`app/styles.css` is a minimal global reset ONLY** (`:root` base
  colour/font, `box-sizing`, `body` margin). Do **not** add bare element
  selectors here (`h2 { … }`, `span { … }`, `section { … }`) — it is imported
  once in `layout.tsx`, so anything added there applies to *every* route,
  including ones that use those elements for structure rather than styling.
  This bit us once already: an earlier version had a
  `section { display: grid; grid-template-columns: … }` rule meant only for the
  landing page, which silently broke the scheduler timeline grid (also a
  `<section>`). Page-specific look belongs in that page's own `.module.css`.
- Shared visual primitives (badges, the logo) live in `app/_components/`;
  manager-only ones in `app/manager/_components/`.
- Dynamic class names are composed as template literals against the styles
  object: ``styles[`pill_${state}`]``. Renaming such a class means grepping for
  the prefix, not the full name.
- No charting library and no icon library: the Gantt is CSS-positioned divs and
  icons are hand-written inline SVG components taking `size` and `color`.

### Gantt geometry

`GanttChart.module.css` defines two custom properties on its root — `--gutter`
(the machine-name column) and `--hour` (the width of one hour). Every offset in
the chart is `calc()`-ed from them:

```
left:  calc(var(--hour) * ${startMins / 60})
width: calc(var(--hour) * ${durationMins / 60} - 2px)
```

Nothing is a percentage, so the hour ruler and the blocks beneath it are laid
out against exactly the same scale and cannot drift apart. **Change the hour
width in one place and the whole chart rescales**; do not reintroduce
percentage-based positioning here.

### Job colours

`_lib/colors.ts` holds an eight-slot categorical palette in fixed order,
validated against the chart surface for lightness band, chroma floor,
adjacent-pair colour-vision-deficiency separation and normal-vision separation.
Each fill is paired with whichever ink (near-black or white) contrasts better;
the worst pairing is 3.98:1.

Two rules matter when touching it:

- **Colour is keyed to a job's position in the backlog, not its position in the
  selection**, so filtering the schedule down to fewer jobs never repaints the
  ones that remain.
- Three slots sit under 3:1 against the surface, so **colour is never the only
  identity channel**: every block carries a visible job-id label, the chart ships
  a legend, and the scheduler's placement-order table is a full text equivalent.
  Past eight jobs, colour stops carrying identity (a neutral slate is used) and
  the label alone does.

## Accessibility conventions

Applied consistently; keep new work in line with them:

- **Anything clickable is a real `<button>` or `<a>`.** Job cards, legend
  entries and Gantt blocks are buttons; the manager overview's clickable table
  rows keep their row-level `onClick` as a mouse affordance but carry a
  focusable chevron button as the keyboard equivalent, so the table keeps its
  semantics.
- **Every module ends with a `:focus-visible` block** giving one consistent
  `2px solid #2563eb` ring to every interactive element on that page.
- **Modals** carry `role="dialog"`, `aria-modal` and `aria-labelledby`, and
  close on Escape as well as backdrop click.
- **Popovers** (the overview's notification bell) set `aria-expanded` and close
  on Escape or an outside click.
- **Transient banners and toasts** carry `role="status"`; blocking validation
  carries `role="alert"`.
- **Progress bars** carry `role="progressbar"` with `aria-valuenow/min/max`.
- Gantt blocks carry a full `aria-label` (job, operation, machine, offset,
  duration, state) since their visible label is necessarily abbreviated.
- Icons are `aria-hidden`; icon-only buttons carry an `aria-label`.

## Known gaps / next steps

**Not yet connected to the planning flow.** `/manager` (the KPI overview) and
`/operator` still run on their own hardcoded fixtures. The operator view is the
obvious next integration: its queue should be the operations the generated plan
assigned to that machine.

**The plan does not survive a reload.** `PlanningProvider` is in-memory. Fine for
a prototype, but a user-testing session where a refresh wipes the plan is worth
avoiding — `sessionStorage` hydration (read after mount, to avoid an SSR
mismatch) would be a small, contained fix.

**No manual override of a generated plan.** The previous scheduler let a manager
drag an operation to a different machine or time; that was editing hardcoded
blocks and did not carry over to generated plans. Re-adding it properly means
deciding what happens to everything downstream of the moved operation — pin it
and re-run the generator around it, most likely.

**No what-if disruptions.** The simulation is a faithful replay. Injecting a
breakdown or an overrun mid-run and re-planning from that point is the natural
next feature, and the reason the simulation is a separate route.

**Scheduling quality.** The generator is greedy and never backtracks. Bottleneck
machines, setup/changeover times, operator availability, shift boundaries and
machine capability constraints are all unmodelled. If schedule quality becomes a
real requirement, this is where a proper solver goes — and `scheduling.ts` is
already isolated enough to swap wholesale.

**No tests.** `_lib/scheduling.ts` is pure and is the obvious first target: no
machine double-booked, operations sequential within a job, durations preserved,
dependencies respected, deterministic output, and correct detection of cycles
and missing dependencies. The operator queue state machine is the second.

**Mock data consistency.** The overview's `weeks` fixture uses `#254`-style job
ids while the planning flow uses `JOB-254`, and the two disagree about the same
jobs' progress. Worth reconciling before user testing, since testers move between
the views.

**Duplicated icon sets.** `manager/icons.tsx` and `operator/icons.tsx` both
define `IconClock`, `IconInfo`, `IconCheckCircle`, `IconUser` and `IconPlay`,
differing only in default colour. They should be one shared module with the
colour passed at the call site.

**Responsive coverage.** Every page collapses to fewer columns at its own
breakpoint, but none has been designed for phone widths, and the Gantt is
horizontally scrollable by necessity. If shop-floor tablets are a target, the
operator view needs a deliberate small-screen design.

**Two lockfiles.** Both `pnpm-lock.yaml` and `package-lock.json` are committed,
so `npm install` and `pnpm install` resolve dependencies differently while Docker
and CI only ever use pnpm. The team should agree on pnpm and delete
`package-lock.json`.

**No favicon**, so every page logs a `/favicon.ico` 404 in the console.
