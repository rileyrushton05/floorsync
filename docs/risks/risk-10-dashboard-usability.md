# Risk: Dashboard Usability Issues

## Description

Users find the operator or manager dashboards difficult to interpret, reducing the overall effectiveness of monitoring production progress and potentially leading to user rejection of the system.

## Likelihood

Medium

## Impact

Medium

## Mitigation Plan

- Conduct user testing with mockups early in the design phase
- Follow established UI/UX best practices (e.g., clear labels, consistent color coding for machine states, informative tooltips)
- Provide a "training" walkthrough or onboarding guide for new users
- Involve potential users in design feedback sessions
- **(Checkpoint 2)** Done: the operator dashboard and sidebar navigation shipped (#294), and simulation playback and page polish shipped (#295), both with consistent status labelling
- **(Checkpoint 2)** Remaining: no usability testing has actually been run with real users yet; `evidence/user-testing/` holds only a placeholder README, and #162/#187 (the usability evaluation tasks) have not started

## Contingency Plan

- Add a user feedback mechanism to collect criticism and suggestions
- Prioritize the most requested usability improvements in a sprint
- Provide a "simple mode" that shows only the most critical information to avoid overwhelming new users
- Create quick reference guides and video tutorials

## Status

Open