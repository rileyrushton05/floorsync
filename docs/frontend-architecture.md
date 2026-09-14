# Frontend architecture guide

This guide implements [decision 0012](decisions/0012-query-managed-frontend-server-state.md).
The decision explains why FloorSync uses TanStack Query; this document shows how to build features
without coupling visual UI to FastAPI, authentication, or data-fetching code.

## Outcomes

- Build and review a screen with fixtures, without an API or logged-in user.
- Contain backend changes to transport functions, hooks, and mappers—not JSX.
- Make mutations refresh every dependent screen without a browser reload.
- Keep an unsaved form draft safe during background revalidation.

## Four layers

```text
FastAPI DTOs
   │
   ▼
1. app/_lib/api.ts                 typed HTTP, Problem Details, AbortSignal
   │
   ▼
2. features/<feature>/queries.ts   TanStack Query, mutations, polling, invalidation
   │
   ▼
3. features/<feature>/Page.tsx     DTO → view model; intents → mutations
   │
   ▼
4. features/<feature>/ui/          props, callbacks, layout, local visual state
```

Only layers 1–3 may know the backend exists. A file in `ui/` must not import `api.ts`, TanStack
Query, `useAuth`, `useRouter`, API DTO types, or `ApiError`.

## Project structure

Feature code belongs in `src/frontend/features/`, not in a Next.js route directory. Route files then
remain small entry points.

```text
src/frontend/
├── app/
│   ├── _lib/api.ts
│   ├── _lib/query-keys.ts
│   └── manager/machines/page.tsx       # imports <MachinesPage /> only
├── features/
│   └── machines/
│       ├── model.ts                     # UI contracts and DTO mapper
│       ├── queries.ts                   # query and mutation hooks
│       ├── MachinesPage.tsx             # connected screen
│       ├── fixtures.ts                  # fixture data and states
│       └── ui/
│           └── MachineInventoryList.tsx # prop-driven presentation
├── features/jobs/
│   ├── JobsPage.tsx
│   ├── model.ts
│   ├── queries.ts
│   └── fixtures.ts
└── features/schedules/
    ├── SchedulerPage.tsx
    ├── SimulationPage.tsx
    ├── model.ts
    ├── queries.ts
    ├── fixtures.ts
    └── ui/ScheduleBar.tsx
└── components/ui/                       # shared Button, Card, Select, etc.
```

Keep FloorSync workflow components in their feature directory. `components/ui/` is only for
feature-neutral design-system primitives.

## 1. Transport stays transport-only

`app/_lib/api.ts` owns URLs, headers, JSON parsing, Problem Details conversion, and the existing
401 sign-out rule. It must not import React or cache keys. Every read accepts an optional signal so
TanStack Query can cancel obsolete requests.

```ts
export function fetchMachines(
  token: string,
  limit = 100,
  cursor?: string,
  signal?: AbortSignal,
): Promise<CursorPage<MachineSummary>> {
  // Pass `signal` through the shared request() wrapper to fetch().
}
```

Components never call raw `fetch`. A feature hook calls a named transport function.

## 2. Configure TanStack Query once

```bash
pnpm add @tanstack/react-query
```

Create `app/_components/QueryProvider.tsx` and wrap it around the current providers in
`app/providers.tsx`:

```tsx
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnReconnect: true } },
  }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
```

When the account or token changes, call `queryClient.clear()`. Never include a bearer token in a
query key or persist the query cache.

## 3. Define keys before hooks

All query keys live in one factory; no handwritten key arrays elsewhere.

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

## 4. Map API resources to UI models

`MachineSummary` is an API contract; `MachineRow` is a visual contract. Map between them once at
the feature boundary, rather than leaking API fields through views.

```ts
// features/machines/model.ts
import type { MachineSummary } from "@/app/_lib/api";

export interface MachineRow {
  id: string;
  name: string;
  categoryLabel: string;
  statusLabel: "Active" | "Inactive";
  isActive: boolean;
}

export function toMachineRow(machine: MachineSummary, categories: ReadonlyMap<string, string>): MachineRow {
  return {
    id: machine.id,
    name: machine.name,
    categoryLabel: machine.category_id ? categories.get(machine.category_id) ?? "Unknown" : "No category",
    statusLabel: machine.active ? "Active" : "Inactive",
    isActive: machine.active,
  };
}
```

If the API changes, adjust the mapper or hook. If design changes, adjust `MachineRow` and the view.
Neither change should cascade through the other layer.

## 5. Put backend work in hooks

```tsx
// features/machines/queries.ts
export function useMachines() {
  const { token } = useAuth();
  return useQuery({
    queryKey: queryKeys.machines.all,
    enabled: token !== null,
    queryFn: ({ signal }) => fetchAllMachinePages(token!, signal),
    refetchOnMount: "always",
  });
}

export function useSaveMachine() {
  const client = useQueryClient();
  const { token } = useAuth();
  return useMutation({
    mutationFn: ({ id, values }: { id?: string; values: MachineInput }) =>
      id ? updateMachine(id, values, token!) : createMachine(values, token!),
    onSuccess: async (machine) => {
      client.setQueryData(queryKeys.machines.detail(machine.id), machine);
      await client.invalidateQueries({ queryKey: queryKeys.machines.all });
      await client.invalidateQueries({ queryKey: queryKeys.jobDefinitions.all });
      await client.invalidateQueries({ queryKey: queryKeys.schedules.all });
    },
  });
}
```

`fetchAllMachinePages` is a named cursor-pagination helper in the data layer, never table JSX. In
production hook code, enforce token availability through the manager guard and `enabled` condition.

## 6. Keep the connected screen thin

The screen owns local draft state and converts query output to UI props. It does not contain the
dense visual layout.

```tsx
export function MachinesPage() {
  const machines = useMachines();
  const saveMachine = useSaveMachine();
  const [draft, setDraft] = useState<MachineDraft>(EMPTY_DRAFT);

  if (machines.isPending) return <MachineInventoryView state={{ kind: "loading" }} />;
  if (machines.isError) return <MachineInventoryView state={{ kind: "error", onRetry: machines.refetch }} />;

  return <MachineInventoryView
    state={{ kind: "ready", rows: machines.data.map(toMachineRow), isRefreshing: machines.isFetching }}
    draft={draft}
    saving={saveMachine.isPending}
    onDraftChange={setDraft}
    onSave={() => saveMachine.mutate({ values: toMachineInput(draft) })}
  />;
}
```

The view is controlled by props and emits only intents. Parent-owned state includes selected record,
form draft, save state, and errors; a small visual detail such as a disclosure's open state may stay
local to the view.

## 7. Build UI with fixtures first

Create believable fixture data before API integration:

```ts
export const readyMachines: MachineRow[] = [/* active and inactive examples */];
export const longNameMachine: MachineRow = { /* overflow/accessibility case */ };
export const validationError = "Machine name is required.";
```

Every feature supplies ready, empty, loading, background-refresh, permission, validation-error,
request-error, and long-content states. Designers can render those views in a development route or
component test with no backend. Introduce Storybook when several components need repeatable visual
review; its stories provide fixture props and are not included in the production bundle. Use MSW
only for connected-page stories or browser tests requiring an HTTP boundary, never as runtime data.

## Freshness and invalidation matrix

| Event | Required query action |
| --- | --- |
| Open Jobs | Revalidate machines and job definitions needed by Jobs |
| Open Machines | Revalidate machines/categories |
| Create/update/deactivate machine | Invalidate machines, job definitions, scheduler input |
| Save/delete job definition | Invalidate job definitions and scheduler input |
| Generation succeeds | Invalidate schedules; fetch returned timeline by id |
| Simulation runs | Poll authoritative simulation state only; never poll immutable timeline per frame |
| Sign out/account changes | Clear cache |

Do not create a global “refresh everything” counter. A mutation names the resources it can make
stale; a route mounts and revalidates only the resources it actually needs.

## Migration order

1. Add `QueryProvider`, query keys, and transport `AbortSignal` support.
2. Migrate Machines and Jobs together, then delete `PlanningProvider` and its pathname workaround. ✓
3. Migrate Scheduler generation to a mutation plus terminal-status query polling. ✓
4. Migrate Simulation to immutable timeline and authoritative-state hooks. ✓
5. Add Storybook/MSW after stable fixture views need regular visual review.

## Review checklist

- Does a `ui/` file import a query hook, DTO, API client, token, router, or `ApiError`? Move that
  concern to the connected screen or feature hook.
- Does an API DTO appear in a UI prop? Add a view model and mapper.
- Is an unsaved draft in server cache? Move it to local state.
- Does each mutation invalidate every dependent query family?
- Does every screen have fixture states before backend integration?
- Is polling conditional on a transient backend state and bounded by product rules?

## References

- [Decision 0012](decisions/0012-query-managed-frontend-server-state.md)
- [React: Sharing State Between Components](https://react.dev/learn/sharing-state-between-components)
- [TanStack Query: important defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults)
- [TanStack Query: query invalidation](https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation)
- [Storybook: build UI in isolation](https://storybook.js.org/docs/get-started/why-storybook)
