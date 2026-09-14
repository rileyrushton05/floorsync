# Frontend development standard

This is the required structure for FloorSync frontend work. It exists to keep
route files small, visual components testable, and backend integration
predictable as more floors, roles, and scheduling workflows are added.

## The dependency direction

```text
app routes  →  feature screens  →  feature data / model / UI
                   ↓                    ↓
              core + domains       core + domains + components/ui

core       → components/ui only
domains    → core + components/ui only
```

`app/` is routing and provider composition, not an application code bucket.
Every `page.tsx` is a one-line re-export of a feature screen. A feature may use
another feature's public query hook or key only when it is a real dependency;
it must never reach into another feature's screen or UI implementation.

`core/` contains application-wide, business-neutral concerns: authentication,
HTTP transport, query provider/pagination, feedback states, and shell chrome.
It cannot import a feature or domain. `domains/` holds business concepts shared
by multiple features. Scheduling types, timeline translation, colours, Gantt
geometry and time formatting live in `domains/scheduling/`, rather than under a
manager route.

## Required layout

```text
src/frontend/
├── app/                         # layouts, providers and one-line route exports
├── components/ui/               # owned, accessible design primitives
├── core/
│   ├── auth/                    # token store, session context and route guards
│   ├── http/                    # apiRequest, ApiError and wire-level helpers
│   ├── query/                   # QueryClient policy and pagination
│   ├── feedback/                # reusable state messages
│   ├── presentation/            # generic UI mappings, e.g. badge intent
│   └── shell/                   # reusable navigation and page shells
├── domains/
│   └── scheduling/              # shared scheduling business vocabulary + Gantt
└── features/
    └── <feature>/
        ├── data/                # endpoint functions, query keys and query hooks
        ├── model/               # pure mapping, validation and view-model helpers
        ├── screens/             # route-level controllers/composition
        ├── ui/                  # presentational components
        └── fixtures/            # explicit prototype-only data/components, if needed
```

Not every feature needs every folder. Do not create a generic component, hook,
or `utils` folder until it has a second genuine caller. Conversely, move a
single-purpose piece out of a screen once it is independently understandable
or makes the screen hard to scan.

## Screen, UI and business responsibilities

A screen owns URL state, local interaction state, feature query hooks,
mutation orchestration, and the composition of its visual pieces. It should
read as the story of the screen, not as an implementation dump. Extract a UI
component for a dense panel, editor, list, dialog, or table; pass it explicit
values and callbacks.

A component under `features/*/ui` is presentational:

- It may import `components/ui`, the feature's `model`, and `domains`.
- It must not call `fetch`, use TanStack Query, read auth context, read the
  router, or import a feature `data/api` module.
- It reports interaction through callbacks rather than reaching into state.

Pure transformations, validation and API-to-view mapping belong in `model/`.
No React hook or JSX belongs there. Business concepts used by two features move
to `domains/`, never to `core/`.

## Backend and TanStack Query policy

There is one browser transport: `core/http/client.ts`. It owns the API base URL,
JSON headers, problem-detail errors, authenticated 401 handling, and crucially
rethrows aborted requests. Cancellation is normal TanStack Query control flow;
it must never be turned into an `ApiError(0)` or retried.

Each feature owns its endpoint functions, types, cache keys and query hooks in
`data/`. Query functions accept and forward TanStack's `signal`. A feature uses
the following defaults unless it documents a reason not to:

- Reads use `useQuery`, are disabled without a token, and use stable feature
  keys. Do not put tokens, objects, or timestamps in a key.
- Writes use `useMutation` and invalidate the smallest affected feature keys.
  Cross-feature invalidation is allowed only for actual data dependencies
  (for example, changing machines invalidates job-definition and schedule
  views).
- Async commands do not invalidate their result collection on `202 Accepted`.
  The scheduling generation hook invalidates schedules only after its poller
  reports `completed`.
- Cache is cleared when the session token changes, so data never crosses
  accounts in a browser tab.

Endpoint functions return API contracts. Convert them at the data/model edge;
the rest of the UI should not know `snake_case` or response-only fields.

## Shell, design and feedback policy

Use `components/ui` for buttons, forms, cards, tables and accessible interaction
primitives. Use `core/shell` only for app-wide chrome such as `ManagerShell`,
not for arbitrary cards. Use `core/feedback` and `ManagerPageState` for
consistent loading, permission, empty, and failure states.

The UI must distinguish a reusable shell from a feature panel. A manager page
gets the manager navigation from `ManagerShell`; a machine editor is owned by
the machines feature. Keep Tailwind classes close to the component they style
and prefer the design tokens in `app/styles.css` over new literal colours.

## Fixtures and prototype routes

Fixtures are allowed only in `features/<name>/fixtures/`. Their module and any
screen using them must say that the data is prototype-only. A self-contained
prototype component may live there too, so its static interaction state cannot
be mistaken for an API-backed screen. Fixtures cannot be silently mixed with
API results or used as a failed-query fallback. The current overview and
operator screens are explicitly prototype features because the backend does not
yet expose their required live contracts.

When an API contract is introduced, create the feature `data` module, model
adapter, query hook and loading/error states in the same change, then delete the
fixture path instead of maintaining two ambiguous implementations.

## Adding or changing a feature

1. Write/update the API contract and endpoint functions in `data/api.ts`.
2. Add a stable key and query/mutation hook in `data/` with explicit invalidation.
3. Put pure conversions and validations in `model/`.
4. Build accessible visual panels in `ui/`; compose them from a `screens/` file.
5. Add a one-line route export and select the shared shell/guard deliberately.
6. Remove the replaced code in the same PR. Do not leave an old route helper,
   duplicate API function, or alternate fixture flow behind.
7. Run `pnpm typecheck`, `pnpm lint`, and `pnpm check:architecture`.

## Enforced boundaries

`pnpm check:architecture` fails if legacy route-local architecture returns, a
route page stops delegating to a feature screen, a feature UI layer imports
TanStack/auth/router/API data, a domain imports a feature or route, a core module
imports a feature/domain, or a second `fetch` is introduced outside the shared
transport. It is included in `pnpm lint` and is intentionally a lightweight
guardrail rather than a substitute for code review.
