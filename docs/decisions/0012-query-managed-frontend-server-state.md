# Decision: Manage frontend server state with TanStack Query

## Date

2026-09-14

## Status

Accepted

## Context

FloorSync's FastAPI product API is the authority for machines, job definitions, schedules,
asynchronous generation status, and the future shared simulation state. It already offers typed,
versioned HTTP resources, cursor pagination, RFC 9457 Problem Details failures, and explicit `202`
status resources.

The frontend's typed transport client (`app/_lib/api.ts`) is sound, but remote data was held
in page effects and `PlanningProvider`. Because that provider sat above every `/manager` route,
Next.js preserves it while the user changes tabs. A machine created after the provider's first read
was visible on Machines but missing from the Jobs operation selector. Refetching on pathname change
fixes that symptom, but still fetches jobs and machines on unrelated tabs and makes one context
responsible for caching, cancellation, retries, polling, mutation consistency, and error handling.

This will become more error-prone as a machine change affects job eligibility and scheduler input, a
job-definition change affects scheduler input, generation must poll to a terminal result, and the
shared simulation needs authoritative refresh on join/reconnect/while running.

## Decision

Use **TanStack Query v5** as the sole owner of browser-side *server state*. Keep `api.ts` as a
typed HTTP transport boundary, but replace `PlanningProvider` as the data cache as features migrate.

This is deliberately client-side. The current bearer token is stored in `sessionStorage`, so a
protected API call cannot safely be preloaded in a Next.js Server Component. A future move to
HTTP-only sessions and a backend-for-frontend is a separate decision.

### State ownership

| State | Owner | Examples |
| --- | --- | --- |
| Authoritative remote data | TanStack Query | machines, job definitions, schedules, generation status, simulation state |
| Unsaved UI state | component state | job draft, filter, selected row, dialog, Gantt hover |
| Authentication | `AuthProvider` | token, current account, sign-in/out |
| Pure transformations | plain functions | timeline mapping, colour and duration formatting |

Do not copy query results into local state to render or filter them. Do not put an unsaved job draft
in the query cache: a background refetch must never overwrite work in progress.

### Architecture

```text
FastAPI API
   │ typed HTTP + Problem Details
   ▼
app/_lib/api.ts
   │ transport only; supports AbortSignal
   ▼
app/_lib/queries/
  keys.ts · machines.ts · jobs.ts · schedules.ts · simulations.ts
   │ query, mutation, invalidation and polling policies
   ▼
QueryClientProvider in app/providers.tsx
   │
   └── manager pages/components + local drafts and interaction state
```

`api.ts` must not import React or know cache keys. Query hooks must not render JSX or depend on a
route layout. Pages compose hooks and own their editing experience.

### UI integration boundary

Every feature has a deliberate seam between its connected screen and its presentational UI. The
connected screen may use query hooks, map API resources, select local state, and perform mutations.
The presentational components receive only UI-shaped props and callback intents; they do not import
`api.ts`, TanStack Query, `useAuth`, `useRouter`, or an API response type.

```text
MachineSummary API DTO ──map──► MachineRow view model ──props──► MachineInventoryView
                                                        ◄─ intent ─ onEdit(machineId)

MachinePage (connected) ──► useMachines / useSaveMachine ──► API
```

For example, a machine screen may expose `MachineRow` with the name, category label, active label,
and any visual status required by the design rather than the API's `category_id`, decimal salary
representation, timestamps, cursor shape, or error class. Mapping happens once at the feature
boundary. If the API changes, the mapper/query hook changes; a designed view remains stable.

Use this layout for new features:

```text
features/machines/
  model.ts                 # UI view models, screen props, mapper from API resource
  queries.ts               # useMachines, useMachineCategories, useSaveMachine
  MachinePage.tsx          # connected composition: hooks, local draft, intent handlers
  ui/
    MachineInventoryView.tsx
    MachineEditorView.tsx  # controlled, prop-driven, no backend imports
  fixtures.ts              # realistic states for isolated UI work
  MachineInventoryView.stories.tsx  # when Storybook is introduced
```

`MachinePage` is intentionally thin. It translates a view callback such as `onSave(draft)` into a
mutation and maps query state into a screen state. `MachineEditorView` decides layout, spacing,
responsive behaviour, and accessible controls from props. A designer can build or change the latter
with fixture data before an endpoint, query, or authentication flow exists.

Model screen state explicitly instead of making each view infer it from transport details:

```ts
type MachineScreenState =
  | { kind: "loading" }
  | { kind: "ready"; machines: MachineRow[]; isRefreshing: boolean }
  | { kind: "error"; message: string; onRetry: () => void };
```

Use controlled components for information that a parent must coordinate, such as the selected
machine, form draft, saving state, and error message. Keep tiny visual-only behaviour local, such
as whether a disclosure is open. This provides one owner for each state without turning all UI into
a global store.

Fixtures must cover the normal, empty, loading, refresh, permission, validation-error, and long-name
states. Start with local fixture modules; introduce Storybook when multiple screens/components need
regular isolated visual review. At that point, stories become the visual contract and Mock Service
Worker may mock network requests only for connected-page stories and browser tests. Mocking must
remain a development/test concern, never a runtime application mode.

### Query keys

One exported key factory is the only source of query keys. Keys identify resources and parameters;
they must never contain bearer tokens or response objects.

```ts
export const queryKeys = {
  machines: {
    all: ["machines"] as const,
    detail: (id: string) => ["machines", id] as const,
    categories: ["machines", "categories"] as const,
  },
  jobDefinitions: {
    all: ["job-definitions"] as const,
    detail: (id: string) => ["job-definitions", id] as const,
  },
  schedules: {
    all: ["schedules"] as const,
    timeline: (id: string) => ["schedules", id, "timeline"] as const,
    generation: (id: string) => ["schedule-generations", id] as const,
  },
  simulations: { detail: (id: string) => ["simulations", id] as const },
};
```

### Freshness policy

The requirement is that a newly opened tab revalidates the resources it needs—not that every tab
loads the entire manager floor.

| Resource/screen | Policy |
| --- | --- |
| Job builder machines and definitions | `refetchOnMount: "always"`; retain prior data while fetching; refetch on reconnect and when stale on focus |
| Machines screen | Revalidate machines/categories on mount; categories may use a five-minute `staleTime` if they remain rarely changed |
| Scheduler input | Read independent job/machine queries on mount; never treat a prior page as proof of current engine input |
| Schedule list | Revalidate on scheduler/simulation mount and after generation/confirmation/discard |
| Confirmed timeline | Cache as immutable for a schedule version; invalidate only if the API allows its contents to change |
| Generation status | Poll only while pending/running; stop on every terminal state; retain the product timeout ceiling |
| Simulation | Fetch immutable timeline once; use bounded authoritative-state polling only while running until authenticated subscriptions exist |

First load shows a loading state. A background refresh keeps the last good data visible with a quiet
`isFetching` indicator. A first-load error blocks with retry; a refresh error keeps the snapshot,
shows its age, and offers `refetch` rather than erasing the editor.

### Mutations and invalidation

Mutations execute in the user event handler. The backend response is authoritative; do not use
optimistic updates for job definitions, machine activation, scheduling, or simulation controls,
because validation and lifecycle rules reside in the backend.

Update a directly returned record in cache when simple, then invalidate dependent resource families:

| Successful mutation | Update/invalidate |
| --- | --- |
| Create/update/deactivate machine | machines; job-builder eligibility; scheduler input |
| Create/replace/delete job definition | job definitions; scheduler input |
| Generation completed | schedules and the returned timeline |
| Confirm/discard schedule | schedules and affected schedule detail/timeline |
| Simulation control event | that simulation state and future manager/operator summaries |

```ts
onSuccess: async (machine) => {
  queryClient.setQueryData(queryKeys.machines.detail(machine.id), machine);
  await queryClient.invalidateQueries({ queryKey: queryKeys.machines.all });
  await queryClient.invalidateQueries({ queryKey: queryKeys.jobDefinitions.all });
  await queryClient.invalidateQueries({ queryKey: queryKeys.schedules.all });
}
```

Invalidation marks data stale. Active observers revalidate in the background; inactive queries read
again when their relevant view mounts. It must not be implemented as a full page reload.

### Authentication and cancellation

1. Clear the `QueryClient` when identity changes or signs out, so one account never sees another
   account's cached manager data.
2. Pass Query's `AbortSignal` through `api.ts` to `fetch`; remove Boolean `current` guards where
   queries replace effects.
3. Keep the central `401` sign-out rule. Present `403` as authorisation, `422`/conflict as actionable
   form feedback, network failure as connectivity/retry, and other errors as retryable failures.
4. Do not persist the query cache. It contains manager-only operational data and persistence adds a
   privacy and lifecycle decision not required by the product.

## How feature code uses it

```ts
const machines = useMachines();
const definitions = useJobDefinitions();
const saveDefinition = useSaveJobDefinition();

// `draft` remains local. It changes only when the user intentionally opens a
// definition, so background data revalidation cannot overwrite it.
```

The selector filters `machines.data` to active machines. A saved machine invalidates this query;
opening Jobs independently revalidates it. Neither workflow needs a provider refresh counter or a
browser reload.

`useRequestSchedule` performs the generation POST. Once it returns an id,
`useGenerationStatus(id)` uses a `refetchInterval` function that returns an interval only for
transient statuses. Completion invalidates schedules and enables the resulting timeline query.

## Migration plan

1. Add `@tanstack/react-query`; create one `QueryClient` in a client `QueryProvider` inside
   `app/providers.tsx`. Do not persist the cache.
2. Extend API functions with optional `signal` support without changing request/response contracts.
3. Add key factory and migrate Machines + Jobs first: `useMachines`, `useMachineCategories`,
   `useJobDefinitions`, and mutation hooks. At the same time split each feature into a thin
   connected page, prop-driven views, view-model mapper, and fixtures. Keep the editor draft local.
4. Migrate Scheduler to independent input/schedule queries and query-managed generation polling.
5. Migrate Simulation to timeline and authoritative-state hooks; use polling only until the backend
   supplies authenticated, useful events.
6. Remove `PlanningProvider`, pathname refresh workarounds, and superseded page-level load helpers.
7. Test: new machine selectable without reload, dependent invalidation, cancellation, terminal
   generation polling, sign-out cache clearing, and a failed refresh preserving a local draft. Add
   visual stories for the documented fixture states before treating Storybook as a required tool.

## Rationale

- It explicitly models the data dependencies that caused the test-machine defect.
- It retains a responsive UI without trusting old data or discarding unfinished edits.
- It lets design work proceed against stable screen contracts and fixtures while backend integration
  evolves independently.
- It maps directly to FloorSync's REST, pagination, `202` generation, and authoritative simulation
  requirements.
- It centralises caching, deduplication, aborts, retries, focus/reconnect revalidation, and polling
  in a tested library rather than repeating them in every page.
- It preserves current scope: no FastAPI rewrite, proxy, or authentication redesign is needed.

## Alternatives considered

- **`PlanningProvider` plus pathname refresh:** tactical only. It over-fetches unrelated
  resources and still requires bespoke cache/mutation/error policies.
- **Independent `useEffect` per page:** rejected; it duplicates lifecycle code and cannot deduplicate
  shared reads or coordinate cross-resource invalidation.
- **SWR:** viable for simple read-heavy data, but TanStack Query better expresses FloorSync's
  dependent mutations, lifecycle polling, and invalidation.
- **Redux/Zustand as a remote cache:** rejected; appropriate for client interaction state, but would
  require rebuilding remote-cache lifecycle behaviour.
- **Server Components/BFF now:** deferred until credentials move from browser storage to an approved
  secure session design.
- **WebSocket-only freshness:** deferred; the current backend transport is not yet authenticated or
  useful for state delivery. Query polling is the correct bridge.

## Consequences

- TanStack Query becomes a frontend dependency and query-key/invalidation rules become reviewable
  interfaces, like API routes.
- Contributors must keep server state distinct from local drafts.
- This does not resolve backend simulation lifecycle or WebSocket gaps; it gives the browser a
  consistent way to consume authoritative APIs as those capabilities arrive.

## Primary references

- [React: You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
- [Next.js: client-side data fetching](https://nextjs.org/docs/pages/building-your-application/data-fetching/client-side)
- [Next.js: backend-for-frontend guidance](https://nextjs.org/docs/app/guides/backend-for-frontend)
- [TanStack Query: important defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults)
- [TanStack Query: query invalidation](https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation)
- [React: Sharing State Between Components](https://react.dev/learn/sharing-state-between-components)
- [Storybook: build UI in isolation](https://storybook.js.org/docs/get-started/why-storybook)
- [FloorSync API conventions](../api-conventions.md)
- [FloorSync scheduling and simulation backend](../scheduling-simulation-backend.md)
