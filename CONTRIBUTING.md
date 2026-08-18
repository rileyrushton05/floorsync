# Contributing to FloorSync

FloorSync is a DECO3801 capstone project.

## Working agreement

- Plan work in GitHub Projects before starting it. An issue needs one accountable owner, priority, milestone and clear acceptance criteria.
- Keep tasks small enough to complete and review in a few days. Split vague work such as “build frontend” into outcomes such as “create coordinator schedule screen wireframe”.
- Protect the core prototype from scope creep. New ideas begin as backlog issues and are only promoted when they do not threaten the current milestone.
- Raise blockers early in Teams and record any material blocker or scope change in the project records.
- Every member contributes roughly 10 hours per week, including studio, meetings, independent work and evidence maintenance.

## Before starting work

1. Read the issue, its acceptance criteria and any linked design/decision record.
2. Confirm the issue has an owner, priority and milestone; clarify it before development if it does not.
3. Move it to **In Progress** on the GitHub Project.
4. Create a branch from `main`: `feature/<issue-number>-short-name`, `fix/<issue-number>-short-name` or `docs/<issue-number>-short-name`.

## Development standards

- Keep one logical change per branch and PR.
- Use readable commit messages: `feat:`, `fix:`, `docs:`, `test:` or `chore:` followed by a short outcome.
- Do not commit secrets, personal data, local environment files, generated dependencies or unrelated formatting changes.
- Prefer synthetic factory data for development and demonstrations.
- Update the README when setup changes; update architecture, decision or risk records when a material technical choice changes.
- Add tests when a behaviour is implemented. When implementation is not ready, record the intended test/acceptance rule in the issue.

## Pull requests and review

- Never commit directly to `main`.
- Open a PR before merging. Link the issue and state what changed, how it was checked and what remains incomplete.
- Request one teammate review; for architecture, data-contract or scope changes, ask the relevant workstream owner to review.
- Reviewers should check the issue acceptance criteria, not only code style. Ask questions early and keep feedback specific and constructive.
- Merge only after the reviewer approves and required checks pass. Close the issue and link any follow-up work after merge.

## Definition of done

An issue is done when its acceptance criteria are met, the change has been reviewed, relevant checks pass, documentation is accurate, and the board/issue shows the resulting evidence. “Mostly working on my machine” is not done.

## Contribution and assessment evidence

Each person must maintain visible, attributable contribution through issues, commits, PRs, reviews, design artefacts, tests, meeting notes or weekly contribution evidence. Record significant decisions, risks, SoW changes and AI-assisted work as they occur; reconstructing them at the end is not acceptable.
