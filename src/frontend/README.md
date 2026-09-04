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

## Project structure

```text
app/
├── layout.tsx                   # Root layout, imports styles.css globally
├── styles.css                   # Global reset ONLY — see "Global styles" below
├── page.tsx                     # "/" landing page
├── home.module.css              # Styles scoped to the landing page only
│
├── _components/                 # Shared, dashboard-agnostic building blocks
│   ├── Logo.tsx                 # <Logo> mark and <Wordmark> home link
│   ├── Badge.tsx                # Status/priority pill + tone helpers
│   └── Badge.module.css
│
├── manager/                     # /manager — facility overview
│   ├── page.tsx
│   ├── manager.module.css
│   ├── icons.tsx                # Inline SVG icon set for manager + scheduler
│   └── scheduler/               # /manager/scheduler — schedule builder
│       ├── page.tsx
│       └── scheduler.module.css
│
└── operator/                    # /operator — single-machine job queue
    ├── page.tsx
    ├── operator.module.css
    └── icons.tsx                # Inline SVG icon set for the operator view
```

## Routes

Four routes covering two FloorSync user roles (see `docs/` and `spec/` for the
user stories and functional requirements these map to).

**Every dashboard is currently a frontend-only mock.** The data is hardcoded at
the top of each `page.tsx`; there is no API, WebSocket or auth wiring yet. They
exist to validate layout, visual language and interaction patterns ahead of
backend integration.

---

### `/` — Landing (`app/page.tsx`)

Server component. The only page that uses the dark palette from the global
`styles.css`; every dashboard overrides it with its own light theme.

Two card grids:

1. **Foundation status** — static "Frontend shell" and "API health" cards left
   over from the project scaffold.
2. **Dashboard links** — entry points to `/manager` and `/operator`.

`/manager/scheduler` is not linked from here; it is reachable only through the
manager dashboard's "View all jobs →" link.

---

### `/manager` — Manager dashboard (`app/manager/page.tsx`)

Client component. Facility-wide weekly overview.

**Layout**

| Region | Contents |
| --- | --- |
| Topbar | Wordmark, reporting-week `<select>`, notification bell + dropdown, Export Report, user block |
| Stat row | Four KPI cards (below) |
| Body — left | Job List table |
| Body — right | Selected-job detail panel + Machines Overview |
| Footer | Hint text, "View All Machines →" |

**Stat cards**

- **Total Jobs** — count plus a completed / in-progress / pending legend with
  percentages derived from the week's totals.
- **On-Time Completion** — percentage, plus a highlighted delayed-job count.
- **Machine Utilization** — percentage with an amber progress bar.
- **Active Operators** — `active / total` plus a ten-dot meter rounded from the
  ratio.

**Job List** — columns are Job ID, Job Name, Progress (bar + percentage),
Status badge, Current Machine, and a chevron button. Clicking a row (or its
chevron button) selects that job into the detail panel. "View all jobs →" links
to `/manager/scheduler`.

**Detail panel** — job ID/name/status, overall progress bar, then two mini
cards: *Currently On* (machine, `Op n of N`, start time) and *Next Scheduled
Step* (next operation, estimated start, machine). Both fall back to an empty
state for completed or not-yet-started jobs. "View full job sequence" expands an
ordered list of every operation, marked done / current / pending by comparing
each index against `currentOp.index`.

**Machines Overview** — four tiles (Running, Idle, Down, Offline) plus a total.

**State**

| State | Effect |
| --- | --- |
| `weekId` | Swaps the whole `WeekData` record; resets job selection and the sequence toggle |
| `selectedJobId` | Drives the detail panel |
| `sequenceExpanded` | Full operation sequence visibility |
| `notifOpen` | Notification dropdown; closes on Escape or an outside click |
| `exportedAt` | Timestamp for the "report exported" toast — cosmetic, nothing is generated |

---

### `/manager/scheduler` — Scheduler (`app/manager/scheduler/page.tsx`)

Client component. The largest page: a three-column schedule builder and
simulation inspector.

**Topbar** — wordmark, day-back/day-forward date navigation, play/pause and a
1x / 10x / 100x speed selector, a "Live Simulation" indicator, Generate
Schedule, and an overflow menu.

**Left — Job List.** `All` / `Pending` / `In Progress` / `Delayed` filter
buttons, a dismissible hint, then one card per job showing its ID, priority
badge, name, `Op n of N` plus queue status, and a colour-coded status dot.
Each card is a button that opens the Edit Job modal. "+ Add New Job" is not
wired up.

**Centre — Schedule Timeline.** A Gantt-style grid of machines × time:

- The window is defined by `TIMELINE_START_HOUR` (8) and `TIMELINE_HOURS` (16),
  i.e. 08:00 → 24:00 in one-hour columns.
- Each machine row has a 160px name/operator gutter (`MACHINE_LABEL_WIDTH`)
  followed by the schedule track. Blocks are absolutely positioned from
  `startTime` and `duration` as percentages of the track.
- Block colour comes from `getOperationStatus()`, which reconciles the
  operation's own status against its job's current status. Completed work is
  checked first, so delaying a job never repaints operations it already ran.
- A vertical "now" line is drawn at `CURRENT_TIME_HOUR`, offset past the gutter
  with `calc()` so it lands on the correct hour of the grid.
- Below the grid: a status legend and a MACHINE STATUS list (Active / Idle /
  Waiting per machine).

> The three width constants must stay in step: `.timelineContent` is
> `160px + 16 × 80px`, `.timelineRowContent` and the hour-marker track are both
> `16 × 80px`, and `MACHINE_LABEL_WIDTH` in `page.tsx` matches `.machineLabel`.
> If they diverge, blocks drift out from under their hour labels.

**Right — Job details.** OPERATION FLOW (a horizontal stepper over
`job.operations`, ticked up to `currentOp.index`), CURRENT OPERATION (machine,
operation, start, estimated end, progress bar), SCHEDULE ACTIONS, and ALERTS.

**Editing.** Two modals, both dismissible by backdrop click, the ✕ button, or
Escape:

- **Edit Job** — name, priority, status, assigned machine, notes. Saving
  updates the in-memory `jobs` state, which re-colours the matching timeline
  blocks. Notes are collected but discarded.
- **Change Machine / Time** — moves the selected job's *current* operation to a
  different machine and/or start time. Saved edits live in `scheduleEdits`,
  keyed by job ID; the timeline reads them when positioning each block so the
  operation disappears from its original row and reappears on the new one.

**Delay Operation** sets the selected job's status to `Delayed`, which turns its
not-yet-run blocks red and surfaces it under the `Delayed` filter.

---

### `/operator` — Operator dashboard (`app/operator/page.tsx`)

Client component. One machine's work, from the operator's point of view. This is
the most genuinely stateful page: it models a small queue machine rather than
just re-rendering fixed data.

**Layout**

| Region | Contents |
| --- | --- |
| Topbar | Wordmark, machine tag with live dot, clock, operator + shift |
| Top row | Current Operation card, Next Operation card, side stack (shift time, next break) |
| Bottom row | Pending Operations table, Completed Operations table |
| Footer | Hint or issue banner, Report Issue |

**Current Operation** — the running step of the active job, with **Mark
Complete**. Completing a step:

1. moves that step to `completed` and prepends an entry to the completed table;
2. starts the next step of the same job if there is one;
3. otherwise promotes the head of the queue to be the active job;
4. otherwise leaves the machine idle, and both cards fall back to empty states.

**Next Operation** — either the next step of the active job or the first step of
the queue head, whichever applies.

**Pending Operations** — the queue in order, each row with a **Start** button.
Starting a queued job out of order pauses the active job and pushes it back onto
the *front* of the queue, retaining its progress; it resumes from its first
pending step.

**Report Issue** swaps the footer hint for a confirmation banner. Nothing is
sent anywhere.

## Mock data and the API seam

The mock structures at the top of each `page.tsx` are the contract to replace
when the backend lands; their shape is already close to what the API and
WebSocket payloads will need to provide.

| File | Structure | Shape |
| --- | --- | --- |
| `manager/page.tsx` | `weeks: WeekData[]` | Weekly KPI rollup + `ManagerJob[]` |
| `manager/scheduler/page.tsx` | `schedulerData` | `MachineSchedule[]` (rows of `ScheduledOperation`) + `SchedulerJob[]` |
| `operator/page.tsx` | `initialMachine: MachineState` | Active job, queue, completed log, shift counters |

Every one of these is typed, so replacing the literal with a fetch should
surface any mismatch at the type level rather than at runtime.

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
- Shared visual primitives (badges, the logo) live in `_components/` and are
  imported by whichever pages need them.
- Dynamic class names are composed as template literals against the styles
  object: ``styles[`opStatus_${status}`]``, ``styles[`sequence_${state}`]``.
  Renaming such a class means grepping for the prefix, not the full name.
- No charting library, and no icon library: icons are hand-written inline SVG
  components taking `size` and `color` props.

## Accessibility conventions

Applied consistently across the three dashboards; keep new work in line with
them:

- **Anything clickable is a real `<button>` or `<a>`.** Job cards and timeline
  blocks are buttons; the manager's clickable table rows keep their row-level
  `onClick` as a mouse affordance but carry a focusable chevron button as the
  keyboard equivalent, so the table keeps its semantics.
- **Every module ends with a `:focus-visible` block** giving one consistent
  `2px solid #2563eb` ring to every interactive element on that page.
- **Modals** carry `role="dialog"`, `aria-modal`, and `aria-labelledby`
  pointing at their title, and close on Escape as well as backdrop click.
- **Popovers** (the manager's notification bell) set `aria-expanded` and close
  on Escape or an outside click.
- **Transient banners and toasts** carry `role="status"` so they are announced.
- **Progress bars** carry `role="progressbar"` with `aria-valuenow/min/max`.
- Icons are `aria-hidden`; icon-only buttons carry an `aria-label`.

## Known gaps / next steps

**Data and integration**

- No live data. Replace the mock structures above with API calls and WebSocket
  subscriptions per the functional requirements (schedule, simulation state,
  machine/job status).
- No auth or session handling — the topbar user blocks are static strings.
- No loading, empty or error states for data that will eventually be fetched.
  The pages assume their arrays are always present and non-empty.

**Unwired controls.** These render but do nothing, and should either be wired or
removed before user testing: "View All Machines →" and Export Report
(manager); "Generate Schedule", "+ Add New Job", "View all alerts →", the
overflow menu, play/pause and the speed selector (scheduler); "View full queue",
"View all completed" (operator).

**Scheduler simulation.** `isPlaying` and `speed` are stored but nothing
consumes them; the "now" line, the current-time readout and the "Started /
Est. End" fields are fixed values. Date navigation moves the header label but
not the schedule — every day renders identical data.

**Mock data consistency.** The scheduler is dated November 2019 while the
manager weeks are labelled Nov 18–24 with no year; the same job IDs carry
different current-operation indices between the two pages. Worth reconciling
into one shared fixture before user testing, since testers move between the two
views.

**Duplicated icon sets.** `manager/icons.tsx` and `operator/icons.tsx` both
define `IconClock`, `IconInfo`, `IconCheckCircle`, `IconUser`, `IconPlay` and
`IconChevronDown`, differing only in default colour. They should be one
`_components/icons.tsx` with the colour passed at the call site.

**Responsive coverage.** Each dashboard collapses to a single column at its own
breakpoint (1200px for manager and scheduler, 1100px for operator), but none has
been designed for tablet or phone widths, and the scheduler's timeline is
horizontally scrollable by necessity. If shop-floor tablets are a target, the
operator view needs a deliberate small-screen design.

**Two lockfiles.** Both `pnpm-lock.yaml` and `package-lock.json` are committed,
so `npm install` and `pnpm install` resolve dependencies differently while
Docker and CI only ever use pnpm. The team should agree on pnpm and delete
`package-lock.json`.

**No tests.** No component, interaction or accessibility tests yet. The operator
queue state machine and the scheduler's `getOperationStatus` / block
positioning are pure functions of their inputs and are the obvious first
candidates.
