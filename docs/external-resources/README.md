# External resources and AI use

Everything FloorSync uses that the team did not write, and how AI was used.

## Code, data and models

| Resource | Source and licence | How it is used | Modified |
| --- | --- | --- | --- |
| ReSched (learned scheduling policy and trained weights) | [XiangjieXiao/ReSched](https://github.com/XiangjieXiao/ReSched), MIT | The fast scheduling strategy and the evaluation baseline, called through FloorSync's adapter (`scheduling/resched.py`). Git submodule in `src/backend/third_party/ReSched/`. | No |
| Benchmark instances and best known results | [ScheduleOpt/benchmarks](https://github.com/ScheduleOpt/benchmarks), CC BY-SA 4.0 | Seed scenarios (`make db-seed`), the import formats, and the scheduling evaluation in `evidence/benchmarks/`. Copied into `src/database/seed-data/`. | No |
| Intent UI components | [intentui.com](https://intentui.com), MIT | Buttons, fields, dialogs and other UI parts in `src/frontend/components/ui/`, added through its registry | Yes, edited after being added |
| Gurobi | [gurobi.com](https://www.gurobi.com), commercial (free academic licence) | Solves the assignment master problem in the Exact strategy. The licence is not committed; without it Exact is reported as unavailable. | No |
| OR-Tools CP-SAT | [Google OR-Tools](https://developers.google.com/optimization), Apache 2.0 | Solves the sequencing subproblems in the Exact strategy | No |

## Package dependencies

Every direct dependency, used unmodified, with the version installed on 22 Oct 2026 and its
licence as published by the package. Version ranges are in `pyproject.toml` and
`src/frontend/package.json`; the exact versions of these and of every indirect dependency are
pinned in `uv.lock` and `src/frontend/pnpm-lock.yaml`.

### Backend (Python)

| Package | Version | Licence | Used for |
| --- | --- | --- | --- |
| FastAPI | 0.141.1 | MIT | REST API and WebSocket endpoints |
| Uvicorn | 0.52.3 | BSD-3-Clause | ASGI server for the API |
| Pydantic, pydantic-settings | 2.13.4, 2.15.0 | MIT | Request and response schemas, configuration |
| python-multipart | 0.0.32 | Apache-2.0 | File upload for import |
| SQLAlchemy | 2.0.52 | MIT | ORM and queries |
| Alembic | 1.19.1 | MIT | Database migrations |
| asyncpg | 0.31.0 | Apache-2.0 | PostgreSQL driver for the API and migrations |
| psycopg | 3.3.4 | LGPL-3.0-only | PostgreSQL driver for the worker |
| Celery | 5.6.3 | BSD-3-Clause | Background schedule generation |
| redis-py | 6.4.0 | MIT | Redis client for live updates and tickets |
| PyJWT | 2.13.0 | MIT | Sign-in tokens |
| pwdlib with argon2-cffi | 0.3.1, 25.1.0 | MIT | Password hashing (Argon2) |
| PyTorch | 2.14.0 | BSD-3-Clause | Running the ReSched policy (worker only) |
| NumPy | 2.5.2 | BSD-3-Clause | ReSched input arrays (worker only) |
| gurobipy | 13.0.3 | Proprietary (free academic licence) | Exact strategy master problem (worker only) |
| OR-Tools | 9.15 | Apache-2.0 | Exact strategy subproblems (worker only) |

Development only: pytest 8.4.2 (MIT), pytest-cov (MIT), HTTPX 0.28.1 (BSD-3-Clause), mypy 1.20.2
(MIT) and Ruff 0.16.3 (MIT).

### Frontend (TypeScript)

| Package | Version | Licence | Used for |
| --- | --- | --- | --- |
| Next.js | 16.3.1 | MIT | App framework and routing |
| React, React DOM | 19.2.8 | MIT | UI rendering |
| React Aria Components | 1.21.1 | Apache-2.0 | Accessible UI primitives under Intent UI |
| @internationalized/date | 3.12.4 | Apache-2.0 | Date handling for pickers |
| TanStack Query | 5.102.8 | MIT | Server state and caching |
| Tailwind CSS, @tailwindcss/postcss | 4.3.3 | MIT | Styling |
| tailwind-variants, tailwindcss-react-aria-components, tw-animate-css, cn | 3.3.1, 2.2.0, 1.4.0, 0.2.5 | MIT, Apache-2.0, MIT, MIT | Component styling helpers used by Intent UI |
| Heroicons | 2.2.0 | MIT | Icons |
| dnd-kit | 6.3.1 | MIT | Dragging panels to rearrange a page |
| react-resizable-panels | 4.14.5 | MIT | Resizing page panels |
| next-themes | 0.4.6 | MIT | Still declared, but no longer imported: the theme provider was rewritten without it |
| Sonner | 2.0.8 | MIT | Toast notifications |

Development only: TypeScript 6.0.3 (Apache-2.0), ESLint 9.39.5 with eslint-config-next 16.3.1
(MIT) and PostCSS 8.5.28 (MIT).

### Containers and services

| Image | Version | Licence |
| --- | --- | --- |
| PostgreSQL (`postgres:16-alpine`) | 16.15 | PostgreSQL License |
| Redis (`redis:7-alpine`) | 7.4.11 | RSALv2 or SSPLv1 (source available) |
| Python (`python:3.12-slim`) | 3.12 | PSF License |
| Node.js (`node:22-alpine`) | 22 | MIT |

## External APIs

FloorSync calls no external web APIs of its own. The one outside service is Gurobi's licensing: a Web License Service licence, the kind the [deployment guide](../../deployment/README.md#exact-solver-licence) recommends, is checked against Gurobi's licence server when Exact runs.

## Papers

| Paper | How it is used |
| --- | --- |
| Naderi, B. and Roshanaei, V. (2022), critical-path-search logic-based Benders decomposition for the flexible job shop, *INFORMS Journal on Optimization* 4(1) | The algorithm behind the Exact strategy (`scheduling/FJSP_lbbd.py`). Deliberate deviations from the paper are listed at the top of that file. |
| Dauzère-Pérès et al. | The MILP formulation used for the first Exact solver (`scheduling/gurobi_exact_solver.py`, [ADR 0014](../decisions/0014-fajsp_milp_formulation.md)) |

## Design references

Freshdesk, Qual and Asana were used as visual references only ([design/README.md](../../design/README.md)). No assets from them appear in the product.

## AI use

The team allowed AI use with full disclosure. How AI tools were used is summarised under
[Credits](../../README.md#credits) in the README.
