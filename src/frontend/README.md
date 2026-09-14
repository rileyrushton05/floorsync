# Frontend

Next.js 16 (App Router) + React 19 + TypeScript, built on
[Intent UI](https://intentui.com) — accessible components on React Aria
Components + Tailwind CSS v4, vendored into `components/ui/` and owned by us.
The theme in `app/styles.css` is tuned to the FloorSync visual design, so the
app looks as it always has while the behaviour underneath comes from React Aria.

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
│ Define jobs:     │     │ Press Generate;    │      │ Run the clock      │
│ operations,      │ ──► │ the backend plans  │ ──►  │ across that plan   │
│ machines,        │     │ and stores it      │      │ and watch it move  │
│ durations,       │     │                    │      │                    │
│ operation order  │     │ "What IS the plan?"│      │ "What does the shop│
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

**Generation happens on the backend.** `/manager/scheduler` posts to
`POST /api/v1/schedules`, which queues the run and answers `202 Accepted` with a
generation id — the schedule does not exist yet. The run itself happens on a
Celery worker using the ReSched policy; see [docs/scheduling.md](../../docs/scheduling.md).

```text
POST /api/v1/schedules              202 + generation id
  └─► GET  /schedules/generations/{id}     poll until terminal
        ├─ completed  ─► GET /schedules/{id}/timeline ─► timelineToPlan() ─► Gantt
        ├─ rejected   ─► the engine's validation issues, listed
        ├─ unavailable ─► the learned runtime is not installed
        └─ failed      ─► the worker raised; its logs say why
```

`app/manager/_lib/generation.ts` owns the waiting. Two things about it are worth
knowing before changing it:

- **The three-minute ceiling is what ends the loop, not a safety margin.** The
  task queue reports `pending` for a command it has never heard of, exactly as
  it does for one that is queued and waiting — so a stopped worker, a lost
  command and a slow run are indistinguishable from the browser, and none will
  ever reach a terminal state on their own. The page reports that case as
  "nothing picked up the run" rather than spinning forever.
- **Every wait is abortable**, so pressing Generate twice, or leaving the page
  mid-run, does not leave a loop writing into a screen that is gone.

Nothing in the browser computes a time. `_lib/timeline.ts` translates the
resolved timeline into the `GeneratedSchedule` the chart already draws — pure
renaming and regrouping — so the scheduler and the simulation both show the
engine's own arithmetic rather than a second opinion about it.

There used to be a greedy list scheduler in `_lib/scheduling.ts` that did this
in the browser. It is gone: a second solver could only ever disagree with the
one whose output is actually stored and simulated. What is left in that module
is `totalWorkMins` and the two shared formatters.

## Project structure

```text
components/
├── theme-provider.tsx             # next-themes wrapper; Intent UI reads useTheme
└── ui/                            # Vendored Intent UI components — we own these
    ├── button.tsx  badge.tsx  card.tsx  table.tsx  select.tsx  …
    └── (re-add more with: pnpm dlx shadcn@latest add @intentui/<name>)

lib/
└── primitive.ts                   # Intent UI's cx() render-prop class helper

app/
├── layout.tsx                     # Root layout, imports styles.css globally
├── providers.tsx                  # ThemeProvider + RouterProvider + <Toast />
├── styles.css                     # Tailwind entry + the FloorSync theme tokens
├── page.tsx                       # "/" landing page (navy surface)
│
├── _components/                   # Shared across every route
│   ├── AuthProvider.tsx           # Token + signed-in account (context)
│   ├── RequireAuth.tsx            # Redirects anonymous visitors to /login
│   ├── UserMenu.tsx               # Signed-in account + sign out, in every topbar
│   ├── Logo.tsx                   # <Logo> mark and <Wordmark> home link
│   └── icons.tsx                  # CoffeeIcon — the one icon Heroicons lacks
├── _lib/
│   ├── api.ts                     # FloorSync API client (base URL + typed calls)
│   ├── auth.ts                    # Token store (sessionStorage) + sign in / out
│   ├── load-state.ts              # LoadState<T> + errorMessage, shared by API pages
│   └── badge-intent.ts            # priority/status → Intent UI badge intents
│
├── manager/
│   ├── layout.tsx                 # Wraps every /manager route in PlanningProvider
│   │
│   ├── _lib/                      # Pure domain logic — no React
│   │   ├── types.ts               # JobDef, ScheduledOperation, GeneratedSchedule…
│   │   ├── scheduling.ts          # Job-graph helpers + T+0 formatters
│   │   ├── generation.ts          # Polls a queued generation to a terminal state
│   │   ├── timeline.ts            # API schedule timeline → GeneratedSchedule
│   │   ├── colors.ts              # Validated categorical palette for job identity
│   │   └── seed.ts                # Starting machines and backlog
│   │
│   ├── _components/
│   │   ├── PlanningProvider.tsx   # API-backed job-definition builder
│   │   ├── SubNav.tsx             # Overview / Jobs / Schedule / Simulation tabs
│   │   └── GanttChart.tsx         # The schedule grid, shared by plan + simulation
│   │
│   ├── page.tsx                   # /manager — facility KPI overview
│   ├── jobs/                      # /manager/jobs — independent-job builder
│   ├── scheduler/                 # /manager/scheduler — generate via the API
│   └── simulation/                # /manager/simulation — plan playback
│
└── operator/                      # /operator — single-machine job queue
    └── page.tsx
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
operation count and total machine time. Click to edit.

**Editor (right)** — name and priority, then:

- **Operations** — an ordered, editable list. Each row is a name, a machine and
  a duration in minutes. Rows can be reordered (↑/↓) or removed. *Order is
  precedence*: operation n+1 cannot start until operation n finishes, so moving
  a row rewrites the job's internal dependency chain.
- A live summary of operation count, total machine time and machines touched.

Validation runs on save and lists every problem at once.

---

### `/manager/scheduler` — Generate a plan (`app/manager/scheduler/page.tsx`)

**No date navigation, no playback controls.** Reads the API for everything:
`GET /jobs` and `GET /machines` for what is on the floor, then the
POST/poll/timeline sequence above when Generate is pressed. Opens on the most
recent stored schedule, so arriving here shows the current plan rather than an
empty frame.

**Released to schedule (left)** — every job in the database, each with a colour
swatch matching the chart. The checkboxes are **ticked and disabled on purpose**:
the engine plans every operation in the database and the API has no way to scope
a run to a subset, so this is what *will* be planned rather than a choice, and a
`<Note>` says so. A running total of jobs and active machines sits underneath;
zero active machines is flagged, since it is the reason a run is about to be
refused.

**Generated plan (centre)** — the `GanttChart` in `plan` mode once a plan is
drawn, and before that a state for each way a run can end: queued, planning,
reading the schedule, rejected (with the engine's own validation issues listed
by code), the learned runtime not installed, nothing picked up the run, and a
worker failure. Those distinctions are deliberate — a rejected run is a problem
with the floor's data, a missing runtime is a deployment problem and a timeout
is a stopped worker, and three different people fix those three things.

**Plan summary (right)** — makespan and job count, per-machine utilisation bars,
and a **job placement** table giving each job's start and finish offset in the
engine's lane order. Clicking a row (or a legend entry, or a block) traces that
job across the grid by dimming the rest. The table doubles as the chart's text
equivalent, so the plan is fully readable without relying on colour.

Job and machine names are whatever the database stores, so a seeded benchmark
reads `abz5/J03` and `abz5/M07`.

### `/login` — Sign in (`app/login/page.tsx`)

Username and password against `POST /api/v1/auth/token`. Redirects anyone already
signed in, and honours `?next=` — but only for same-origin paths, so a crafted
link cannot bounce someone off-site straight after they type a password.

---

### `/manager/simulation` — Schedule playback (`app/manager/simulation/page.tsx`)

**The one page that reads from the API.** Everything on it comes from two calls:
`GET /api/v1/schedules` to list what exists, then
`GET /api/v1/schedules/{id}/timeline` for the one picked. Every start and end
time was computed by the backend's simulation resolver from the schedule's
stored entries and dependencies; this page places bars and moves a clock across
them. It does not read the in-browser plan from `PlanningProvider` at all.

**Schedule picker** — a select listing every schedule newest-first, labelled by
strategy, makespan and creation time, with a status badge. A confirmed schedule
is chosen on load, since simulation refuses anything else. `_lib/timeline.ts`
translates the response into a `GeneratedSchedule` so the existing chart and
panels draw it unchanged — pure renaming and regrouping, **no re-timing**.

Lane labels are whatever the database stores, so a seeded benchmark reads
`abz5/J03` and `abz5/M07`. Operators are not shown: the timeline answers what is
scheduled, not who is standing at the machine.

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

The page has a state for each way it can have nothing to draw: loading, an API
that cannot be reached (with the API's own message and a retry), an empty
database, a draft schedule that has no timeline to resolve, and an account
without permission — `GET /schedules` is manager-only, so an operator is told
that plainly rather than shown a raw 403.

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

`PlanningProvider` (`app/manager/_components/PlanningProvider.tsx`) loads complete
job definitions and machines from the API. Saving uses the atomic definition
contract: `POST /api/v1/job-definitions` creates a job with its priority,
operations, and routes; `PUT /api/v1/jobs/{id}/definition` replaces that complete
definition. Deletes use `DELETE /api/v1/jobs/{id}` and correctly handle its empty
`204 No Content` response.

It no longer holds a generated plan. Generation moved to the backend, and both
the scheduler and the simulation read what is actually stored. The builder edits
every compatible machine route, including its duration and optional energy, and
only offers active machines for new routes.

| File | Structure | Replaced by |
| --- | --- | --- |
| `manager/_lib/seed.ts` | Legacy prototype fixtures, no longer imported | Remove when the UI fixtures are no longer useful |
| `manager/_lib/scheduling.ts` | ~~`generateSchedule`~~ | ✅ done — `POST /api/v1/schedules` |
| `manager/page.tsx` | `weeks: WeekData[]` | KPI rollup endpoint |
| `operator/page.tsx` | `initialMachine: MachineState` | Per-machine queue endpoint / WebSocket |

`/manager/simulation`, `/manager/scheduler`, and `/manager/jobs` have crossed
that seam.

Pages that read the API share `app/_lib/load-state.ts`: a four-state
`LoadState<Value>` union and the `errorMessage` helper, so `forbidden` stays
distinct from `error` on every screen rather than each page re-deciding.

### Talking to the API

`app/_lib/api.ts` is the whole client: one base URL from `NEXT_PUBLIC_API_URL`,
one fetch wrapper, and a typed function per endpoint. The API answers failures as
RFC 9457 problem details, so the wrapper throws with the `detail` field — the
message a person should actually be shown — and falls back to the status line
only when the body is not a problem document.

Only `NEXT_PUBLIC_API_URL` is needed in `src/frontend/.env.local` (gitignored):

```bash
NEXT_PUBLIC_API_URL=http://localhost:8002
```

### Signing in

`/login` posts to the API's own `POST /api/v1/auth/token` and hands the bearer
token to `app/_lib/auth.ts`.

That module is a small external store rather than React state, for two reasons:
plain functions outside the component tree read it, and `useSyncExternalStore`
lets a component read it without hydrating from an effect — reading storage
during render would disagree with the server's HTML, and doing it in an effect
means a synchronous `setState`, which React 19's lint rules reject.

The token lives in **`sessionStorage`**: it survives a reload and navigation but
dies with the tab, so a testing session is never interrupted and a shared machine
keeps nothing afterwards. It is readable by any script on the page, as any
browser-held token is; the protection that matters is the API's 30-minute expiry.

`AuthProvider` turns that token into an account with `GET /api/v1/auth/me`, which
doubles as the check that it is still valid. There is no refresh endpoint, so an
expired token cannot be renewed — the API answers 401, the provider discards it,
and `RequireAuth` sends the visitor to `/login`. A tab left open overnight lands
on the login screen rather than failing one request at a time. An *unreachable*
API is treated differently: the token may be perfectly good, so it is kept and
the outage reported instead of signing anybody out.

`RequireAuth` wraps `/manager` and `/operator` through their layouts, carrying
the attempted path in `?next=` so signing in returns you there. It is a
client-side guard over a client-side app — it decides what to render, not what
the API will serve. The real protection is that every schedule route demands a
bearer token; this only saves a person from watching each request fail.

There is no sign-up page, because the API has no registration route. Accounts are
created server-side — see [docs/accounts.md](../../docs/accounts.md).

## Styling conventions

- **Reach for an Intent UI component before writing markup.** `components/ui/`
  is vendored source we own — read it, and edit it if a variant is genuinely
  missing rather than working around it at the call site. Add more with
  `pnpm dlx shadcn@latest add @intentui/<name>`; unused ones were deleted, so
  re-adding is expected and cheap.
- **Style with theme tokens, never raw hex.** `bg-bg`, `text-fg`,
  `text-muted-fg`, `bg-overlay`, `border`, `bg-primary`, `*-subtle` and friends
  all resolve through `app/styles.css`. A literal colour in a component is a bug
  unless it is *data* (see "Job colours" — the Gantt palette is data).
- **Two surfaces, one token set.** `app/styles.css` defines the light operations
  palette on `:root` and the navy landing palette on `.theme-navy` (aliased to
  `.dark`). The landing page opts in by putting `theme-navy` on its wrapper;
  every Intent UI component then repaints itself with no per-page overrides.
  This is why there are no longer any bare element selectors to be careful
  about — the earlier `section { … }` rule that silently broke the scheduler
  grid has no equivalent in a token-driven theme.
- **Interaction state comes from React Aria, not from us.** Use `onPress`
  (not `onClick`), `isDisabled` (not `disabled`), `isSelected`/`onChange` on
  `CheckboxField`, and `selectedKeys`/`onSelectionChange` on `Table`,
  `GridList` and `ToggleGroup`. Dismissal, focus restoration, roving tabindex
  and keyboard nav are already handled — the manager overview's notification
  popover, for instance, dropped a hand-rolled document-listener effect for
  Escape and outside clicks when it became an Intent UI `<Popover>`.
- **Navigation goes through `href`.** `RouterProvider` in `app/providers.tsx`
  wires every Intent UI `href` to the Next router, so `<Link>`, `<Tab>` and
  friends do client-side pushes. Without that provider they degrade to full
  page loads.
- Icons come from `@heroicons/react/24/outline` (the set Intent UI itself uses)
  and paint with `currentColor`. The single exception is `CoffeeIcon` in
  `app/_components/icons.tsx`, which Heroicons does not ship.
- Transient confirmations use `toast()` from `sonner`; persistent, in-context
  messages use Intent UI's `<Note>`.

### The Gantt is deliberately still bespoke

Intent UI ships no timeline or Gantt component, so `GanttChart.tsx` remains
custom. It is not an exception to the system, though: it is built on the same
React Aria `Button`/`ToggleButton` primitives Intent UI wraps, and paints from
the same theme tokens. Only its *geometry* is hand-written.

### Gantt geometry

`GanttChart.tsx` sets two custom properties on its root via Tailwind arbitrary
properties — `[--gutter:168px]` (the machine-name column) and `[--hour:124px]`
(the width of one hour). Every offset in the chart is `calc()`-ed from them:

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

Most of this is now enforced by React Aria rather than by convention. What that
means in practice: **do not hand-roll behaviour a component already provides**,
and do not add ARIA that the component already emits.

Handled for us by Intent UI / React Aria:

- Roles and ARIA state on `Table`, `GridList`, `Tabs`, `Select`, `Popover`,
  `ProgressBar`, `Slider`, `Checkbox` and `ToggleGroup` — including
  `role="progressbar"` with `aria-valuenow/min/max`, and `aria-expanded` plus
  Escape/outside-click dismissal and focus restoration on overlays.
- Keyboard navigation: roving tabindex in tab lists and toggle groups, arrow
  keys and typeahead in tables and lists, full keyboard operation of the
  scrub slider.
- A consistent `focus-visible` ring from the shared `--ring` token, so there is
  no longer a per-page focus block to remember to write.

Still ours to get right:

- **Selection, not click handlers.** Selectable rows and list items use
  `selectionMode` + `selectedKeys`/`onSelectionChange` so they are reachable by
  keyboard. Do not put a bare `onClick` on a row.
- Gantt blocks carry a full `aria-label` (job, operation, machine, offset,
  duration, state), since their visible label is necessarily abbreviated.
- Icons are `aria-hidden`; icon-only buttons carry an `aria-label`.
- Every `Table`, `GridList`, `Select` and `ToggleGroup` needs an `aria-label`
  (or a visible `<Label>`) — React Aria warns in the console when one is missing.
- Blocking validation uses `<Note intent="danger" role="alert">`; transient
  confirmations use `toast()`, which announces politely on its own.
- Colour is never the only channel: the Gantt pairs every colour with a visible
  job id and a legend (see "Job colours").

## Known gaps / next steps

**A generated schedule stays a draft forever.** There is no
`POST /schedules/{id}/confirm` anywhere in the codebase, so nothing can ever move
a schedule out of `draft`. It does not bite yet, because the simulation page's
playback is entirely local and never calls `/simulations` — but the API's
`POST /simulations` refuses anything unconfirmed, so server-side playback is
blocked until that endpoint exists.

**A run cannot be scoped to chosen jobs.** `POST /api/v1/schedules` takes only a
`starts_at` and plans every operation in the database. The scheduler's checkbox
column is ticked and disabled because of it. Scoping means adding `job_ids` to
the request and filtering in `SchedulingService.load_input` — and doing it
carefully, since ReSched requires disjoint linear job chains and a selected job
must include its complete ordered operation chain.

**Polling, not push.** The scheduler asks for a generation's status once a second
for up to three minutes. Fine for one manager and a handful of runs; a push
channel is the answer if that ever becomes several people watching at once.
Worth knowing that this made `GET /schedules/generations/{id}` a hot endpoint for
the first time, and it reads the task queue synchronously inside an async route.

**Not yet connected to the planning flow.** `/manager` (the KPI overview) and
`/operator` still run on their own hardcoded fixtures. The operator view is the
obvious next integration: its queue should be the operations the generated plan
assigned to that machine.

**No manual override of a generated plan.** The previous scheduler let a manager
drag an operation to a different machine or time; that was editing hardcoded
blocks and did not carry over to generated plans. Re-adding it properly means
deciding what happens to everything downstream of the moved operation — pin it
and re-run the generator around it, most likely.

**No what-if disruptions.** The simulation is a faithful replay. Injecting a
breakdown or an overrun mid-run and re-planning from that point is the natural
next feature, and the reason the simulation is a separate route.

**Scheduling quality is now a backend question.** The browser no longer decides
where anything goes, so setup times, operator availability, shift boundaries and
bottleneck handling are all questions for the engine and its contract — see
[docs/scheduling.md](../../docs/scheduling.md), which records what that adapter
deliberately refuses.

**No tests.** `_lib/generation.ts` is the obvious first target now that the
solver is gone: it returns terminal states unchanged, stops at the ceiling rather
than polling forever, and unwinds cleanly when aborted mid-wait.
The operator queue state machine is the next target.

**Mock data consistency.** The overview's `weeks` fixture uses `#254`-style job
ids while the planning flow uses `JOB-254`, and the two disagree about the same
jobs' progress. Worth reconciling before user testing, since testers move between
the views.

**Responsive coverage.** Every page collapses to fewer columns at its own
breakpoint, but none has been designed for phone widths, and the Gantt is
horizontally scrollable by necessity. If shop-floor tablets are a target, the
operator view needs a deliberate small-screen design.

**Two lockfiles.** Both `pnpm-lock.yaml` and `package-lock.json` are committed,
so `npm install` and `pnpm install` resolve dependencies differently while Docker
and CI only ever use pnpm. The team should agree on pnpm and delete
`package-lock.json`.

**No favicon**, so every page logs a `/favicon.ico` 404 in the console.
