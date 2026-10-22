# External resources and AI use

Everything FloorSync uses that the team did not write, and how AI was used.

## Code, data and models

| Resource | Source and licence | How it is used | Modified |
| --- | --- | --- | --- |
| ReSched (learned scheduling policy and trained weights) | [XiangjieXiao/ReSched](https://github.com/XiangjieXiao/ReSched), MIT | The fast scheduling strategy and the evaluation baseline, called through FloorSync's adapter (`scheduling/resched.py`). Git submodule in `src/backend/third_party/ReSched/`. | No |
| Benchmark instances and best known results | [ScheduleOpt/benchmarks](https://github.com/ScheduleOpt/benchmarks), CC BY-SA 4.0 | Seed scenarios (`make db-seed`), the import formats, and the scheduling evaluation in `evidence/benchmarks/`. Copied into `src/database/seed-data/`. | No |
| Intent UI components | [intentui.com](https://intentui.com) | Buttons, fields, dialogs and other UI parts in `src/frontend/components/ui/`, added through its registry | Yes, edited after being added |
| Gurobi | [gurobi.com](https://www.gurobi.com), commercial (free academic licence) | Solves the assignment master problem in the Exact strategy. The licence is not committed; without it Exact is reported as unavailable. | No |
| OR-Tools CP-SAT | [Google OR-Tools](https://developers.google.com/optimization), Apache 2.0 | Solves the sequencing subproblems in the Exact strategy | No |

Other libraries are ordinary package dependencies, pinned in `pyproject.toml`, `uv.lock` and
`src/frontend/package.json`: FastAPI, SQLAlchemy, Alembic, Celery, Pydantic, PyTorch and NumPy on
the backend; Next.js, React, React Aria, TanStack Query, Tailwind CSS and Heroicons on the frontend.

## Papers

| Paper | How it is used |
| --- | --- |
| Naderi, B. and Roshanaei, V. (2022), critical-path-search logic-based Benders decomposition for the flexible job shop, *INFORMS Journal on Optimization* 4(1) | The algorithm behind the Exact strategy (`scheduling/FJSP_lbbd.py`). Deliberate deviations from the paper are listed at the top of that file. |
| Dauzère-Pérès et al. | The MILP formulation used for the first Exact solver (`scheduling/gurobi_exact_solver.py`, ADR 0014), as recorded in the [week 7 contribution review](../../evidence/weekly-contribution/week-07.pdf) |

## Design references

Screenshots of Freshdesk, Qual and Asana in [design/01_inspiration/](../../design/README.md) were
used as visual references only. No assets from them appear in the product.

## AI use

The Team Charter allowed AI use with full disclosure. Each member's declaration, covering what was
used and for what, is in [ai-declarations.md](../../ai-declarations.md).
