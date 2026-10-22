# Risk: Manager Accounts Managed by Hand

## Description

Manager accounts are created with a command-line script, and resetting a manager's password or disabling a manager means editing the database. There is no sign-up page, admin screen or self-service password reset, so a facility would need someone technical to manage its managers. Operator accounts are not affected: a manager manages them under Settings.

## Likelihood

Medium

## Impact

Low

## Mitigation Plan

- **(Final, 22 Oct)** Raised at the final review as a residual risk of the prototype
- **(Final, 22 Oct)** In place: every manager step is written out in full in [docs/accounts.md](../accounts.md), and operator accounts are managed in the app

## Contingency Plan

- Add a manager admin screen for creating, disabling and resetting manager accounts
- Add self-service password reset, deferred in [ADR 0007](../decisions/0007-local-jwt-authentication.md)

## Owner

Riley

## Status

Open (accepted)
