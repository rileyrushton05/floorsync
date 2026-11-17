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
- **(Checkpoint 2)** Done: informal usability feedback from classmates and family during development produced twelve tracked findings (F1 to F12); most are already fixed through #290, #294 and #295
- **(Checkpoint 2)** Remaining: the formal moderated study with real DECO3801 participants and SEQ/SUS scoring has not actually run yet; the one documented walkthrough in the evaluation appendix is explicitly a simulated session, not a real participant, so #162/#187 still lack the evidence the protocol is meant to produce
- **(Final, 22 Oct)** Done: moderated testing ran (#162, #187 closed): 17 of 18 recorded tasks completed unassisted, mean SEQ 5.7 (from 2 of 4 participants), SUS not recorded. Findings were fixed (#311) or ticketed (#315, #316) (#331)

## Contingency Plan

- Add a user feedback mechanism to collect criticism and suggestions
- Prioritize the most requested usability improvements in a sprint
- Provide a "simple mode" that shows only the most critical information to avoid overwhelming new users
- Create quick reference guides and video tutorials

## Owner

Beth, Jayden

## Status

Resolved