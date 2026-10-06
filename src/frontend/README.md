# FloorSync frontend

Next.js 16, React 19, TypeScript, Intent UI and TanStack Query power the
FloorSync frontend.

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm check:architecture
```

`pnpm lint` includes the architecture check. The canonical development rules,
folder map, query policy, fixture policy and feature checklist live in
[Frontend development standard](../../docs/frontend-architecture.md).

The planning flow is deliberately backend-led:

```text
Jobs and machines → POST /schedules (202) → poll generation → timeline → plan/simulation
```

The scheduler never calculates operation times in the browser. It asks the
backend to generate a plan, then the scheduling domain maps the persisted
timeline into the shared Gantt model. A completed generation invalidates the
schedule collection; acceptance alone does not, because no schedule exists at
that point.

The manager overview is an explicitly prototype feature until its backend
contract exists; its fixtures live only in its feature area, and API-backed
features never use them as a fallback.

The operator screen is API-backed: `GET /simulations/active` names the live
simulation, the schedule timeline is filtered to the account's machine, and the
`/ws` live-update socket (`core/live-updates`) triggers a refetch, with polling as
the fallback. Only "Mark complete" is local prototype state until the API can
record operation completion.

## Backend-authoritative mutations

The browser guides data entry but does not decide whether a persisted change is
valid. Every create, update and delete reaches the API, which is the authority
for validation, normalisation, uniqueness, current machine state and scheduling
rules. Mutation failures display the API's RFC 9457 problem `detail` in a toast;
validation responses also retain the backend's `invalid_params` reasons.

Only local interaction safeguards remain in the UI, such as preventing a
duplicate submission while a request is in progress. Failed reads use their
page's inline retry state so background refreshes do not generate noisy toasts.
The full policy is in the [Frontend development standard](../../docs/frontend-architecture.md#backend-authority-validation-and-errors).
