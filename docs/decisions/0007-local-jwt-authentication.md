# Decision: Local JWT authentication with separate credentials

## Date

2026-09-04

## Status

Accepted

## Context

FloorSync needs a backend sign-in boundary for managers and machine-bound operator accounts. The
existing `users` model is a production-domain record: schedules reference it for confirmation and
operator users are constrained to one machine. Password material and credential lifecycle do not
belong in that model.

The frontend and API run as separate development services, and the API already exposes an
OpenAPI-based contract. The first implementation needs to work locally without taking a dependency
on an external identity provider, while preserving a migration path to one later.

## Decision

1. Create a one-to-one `user_credentials` table rather than adding authentication fields to `users`.
   It stores a lowercase username, an Argon2 password hash, an active flag, and the last successful
   authentication instant.
2. Expose `POST /api/v1/auth/token` using OAuth2-compatible form fields (`username` and `password`)
   and return a Bearer JWT. `GET /api/v1/auth/me` returns the safe, application-owned user profile.
3. Hash passwords with Argon2 through `pwdlib`; plain-text passwords are never persisted or returned.
4. Issue short-lived HS256 JWTs containing only standard identity/security claims: `sub`, `iss`,
   `aud`, `iat`, `exp`, and `jti`. The API verifies the signature, issuer, audience, expiry, and
   required claims on every protected request.
5. The signing secret, issuer, audience, and expiry are deployment configuration. Production startup
   rejects the committed development secret or a secret shorter than 32 characters.
6. A valid token is not sufficient on its own: every protected request reloads the user through an
   active credential. Disabling a credential therefore takes effect immediately rather than waiting
   for issued tokens to expire.

## Rationale

- `users` remains usable by scheduling and auditing code without exposing or coupling to credential
  data.
- A separate credential model supports the project’s machine-login design without assuming every
  account has an email address.
- JWTs let the Next.js client call the FastAPI API with an ordinary `Authorization: Bearer` header,
  while the OAuth2-form endpoint remains usable from the generated API documentation.
- A short token lifetime plus database-backed active-state validation provides a simple, testable
  revocation boundary without introducing a session store in the first authentication slice.
- HS256 is appropriate while FloorSync has one first-party API that both signs and validates tokens.
  A future multi-service or external-identity deployment should move to asymmetric keys and JWKS or
  provider-issued tokens.

## Alternatives considered

- **Store password hashes on `users`:** rejected because it mixes production-domain data and secret
  authentication data, contradicting the existing schema direction.
- **Server-side sessions in Redis:** viable, but adds a stateful session lifecycle and cross-service
  invalidation concerns before the product needs them.
- **Clerk, Auth0, Supabase Auth, or another hosted identity provider:** deferred. These remain valid
  production options once the hosting and account-provisioning direction is known.
- **Asymmetric JWTs from the start:** deferred because there is no separate token issuer or consumer
  today; key distribution would add complexity without a present boundary that needs it.

## Consequences

- The migration creates `user_credentials` and preserves the existing `users` table and its machine
  constraint.
- Account provisioning and password reset are separate future operations; public self-registration
  is deliberately not introduced.
- The deployment must provide a unique `JWT_SECRET_KEY` through its secret mechanism.
- Refresh tokens, device sessions, password reset, MFA, and external identity federation are out of
  scope for this first slice and require further decisions before implementation.

## Primary references

- [FastAPI: OAuth2 with password and JWT bearer tokens](https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/)
- [PyJWT usage](https://pyjwt.readthedocs.io/en/stable/usage.html)
- [OWASP: Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
