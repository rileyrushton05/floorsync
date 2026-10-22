# Risk: Session Token Held in the Browser

## Description

The frontend keeps the sign-in token in `sessionStorage`, where any script running on the page can read it. If a cross-site scripting bug were ever introduced, an attacker could copy the token and act as that user until it expires. There are no refresh tokens, so a session is one token.

## Likelihood

Low

## Impact

High

## Mitigation Plan

- **(Final, 22 Oct)** Raised at the final review as a residual risk of the prototype
- **(Final, 22 Oct)** In place: the choice is deliberate and documented in `src/frontend/core/auth/token-store.ts`. The token expires after 30 minutes and is discarded when the tab closes, so a shared machine keeps nothing afterwards
- **(Final, 22 Oct)** In place: disabling an account takes effect on its next request, not when its token expires ([docs/accounts.md](../accounts.md))

## Contingency Plan

- Move the token to an `httpOnly` cookie so page scripts cannot read it, with CSRF protection
- Add short-lived access tokens with refresh tokens, as deferred in [ADR 0007](../decisions/0007-local-jwt-authentication.md)

## Owner

Jason

## Status

Open (accepted)
