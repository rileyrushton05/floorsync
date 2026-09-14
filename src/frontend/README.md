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

The manager overview and operator queue are explicitly prototype features until
their backend contracts exist. Their fixtures/prototype components live only in
their feature areas; API-backed manager features never use them as a fallback.
