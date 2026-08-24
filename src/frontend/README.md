# Frontend

Next.js 16 (App Router) + React 19 + TypeScript. No UI/component library and no CSS framework — plain CSS Modules, styled by hand to match the FloorSync visual design.

## Getting started

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
├── layout.tsx              # Root layout, imports styles.css globally
├── page.tsx                # Landing page, links to the three dashboards
├── home.module.css         # Styles scoped to the landing page only
├── styles.css              # Global reset ONLY — see "Global styles" below
│
├── _components/            # Shared, dashboard-agnostic building blocks
│   ├── Logo.tsx             # <Logo> / <Wordmark> — FloorSync mark
│   ├── Badge.tsx            # Status/priority pill + tone helpers
│   ├── Badge.module.css
│   ├── DonutChart.tsx       # SVG donut (inline, no chart library)
│   ├── RadialGauge.tsx      # SVG radial % gauge
│   └── AreaChart.tsx        # SVG line/area chart (manager utilisation panel)
│
├── coordinator/             # /coordinator — schedule builder + simulation controls
│   ├── page.tsx
│   └── coordinator.module.css
├── manager/                 # /manager — facility overview + analytics
│   ├── page.tsx
│   ├── manager.module.css
│   └── icons.tsx             # Small inline SVG icon set used only here
└── operator/                 # /operator — single-machine job queue
    ├── page.tsx
    └── operator.module.css
```

## Dashboards

Three routes, one per FloorSync user role (see `docs/` for the full user
stories / functional requirements these map to). **All three are currently
frontend-only mock UIs** — the data is hardcoded in each `page.tsx`, there is
no API or WebSocket wiring yet. They exist to validate layout, visual
language and interaction patterns ahead of backend integration.

- **`/coordinator`** — job queue & schedule builder, master timeline grid
  (Gantt-style, machines × time, live "now" line), job detail / simulation
  inspector (operation sequence stepper, schedule modification form), system
  alerts and global simulation controls (play/pause/speed).
- **`/manager`** — facility-wide overview: KPI stat cards, utilisation
  chart with bottleneck highlighting, job-distribution donut, current-jobs
  table, anomalies/exceptions table.
- **`/operator`** — single machine's queue: status/queue/efficiency stat
  cards, job queue with pause/start actions, current machine status bar,
  job detail panel with operation sequence and notes.

When wiring these up to real data, the mock arrays at the top of each
`page.tsx` are the contract to replace (their shape is already close to
what the API/WebSocket payloads will need to provide).

## Styling conventions

- **One CSS Module per route**, colocated with its `page.tsx`
  (`coordinator.module.css`, `manager.module.css`, `operator.module.css`).
  Each module's outer wrapper class (`.shell`) defines its own local color
  tokens (`--bg`, `--text`, `--muted`, `--accent`, `--border`) so pages don't
  depend on global state.
- **`app/styles.css` is a minimal global reset ONLY** (`:root` base
  color/font, `box-sizing`, `body` margin). Do **not** add bare element
  selectors here (`h2 { ... }`, `span { ... }`, `section { ... }`, etc.) —
  because it's imported once in `layout.tsx`, anything added there applies
  to *every* route, including ones that use those elements for structure
  rather than styling hooks. This bit us once already: an earlier version
  had a `section { display: grid; grid-template-columns: ... }` rule meant
  only for the landing page, which silently broke the coordinator timeline
  grid (also a `<section>`). Page-specific look belongs in that page's own
  `.module.css`.
- Shared visual primitives (status/priority badges, charts, the logo)
  live in `_components/` and are imported by whichever pages need them.
- No charting library — `DonutChart`, `RadialGauge` and `AreaChart` are
  small inline-SVG components. Reach for a real library only if a chart's
  requirements outgrow what these can reasonably do.

## Known gaps / next steps

- No live data: replace the mock arrays with API calls / WebSocket
  subscriptions per the functional requirements (schedule, simulation
  state, machine/job status).
- No auth/session handling (the operator topbar's "Logged in: J. Smith" is
  static).
- No automated component/UI tests yet.
