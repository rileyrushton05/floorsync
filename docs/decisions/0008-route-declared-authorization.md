# Decision: Route-declared role and machine authorization

## Date

2026-09-04

## Status

Accepted

## Context

FloorSync has two fixed roles: managers can oversee the production floor, while operators are
permanently assigned to one machine. Authorization must be visible at a route’s declaration, backed
by server-side checks, and must not depend on the frontend hiding a button or route.

The production middleware decision already establishes FastAPI dependencies—not generic middleware—as
the location for authentication and role checks. The backend feature and transaction decisions require
HTTP concerns to stay outside common services, while application services return typed outcomes.

## Decision

1. Expose `CurrentUser` as a FastAPI dependency. It validates the bearer token and loads the active
   user through `UserService` inside an explicit read transaction.
2. Expose `require_roles(...)` for endpoints that declare a manager-only or multi-role requirement.
3. Expose `require_machine_access` for resources scoped by a `machine_id`: managers retain oversight;
   operators may access only the machine stored on their user record.
4. Keep token parsing and HTTP 401/403 responses in API dependencies. Keep database queries and
   expected outcomes in `floorsync_common.users.UserService`.
5. Apply these dependencies to every future product route that reads or changes protected data. The
   frontend may use role information to choose a dashboard, but it is never the enforcement point.

## Rationale

- Dependencies make the authorization requirement visible in the route signature and OpenAPI
  contract, unlike hidden middleware or client-only checks.
- Rechecking the active credential makes token revocation effective immediately.
- Machine-scoped authorization uses the database assignment, so a browser cannot gain access merely
  by changing a `machine_id` in a URL or request body.
- Separating API exceptions from common typed outcomes preserves the project’s transport/domain
  boundary and supports future worker reuse of user operations.

## Alternatives considered

- **Role checks only in Next.js middleware:** rejected because direct API callers could bypass them.
- **Generic authorization middleware:** rejected because resource and machine context is route- and
  domain-specific.
- **Store roles only in JWT claims:** rejected because changing a role or disabling an account would
  remain ineffective until the token expired.
- **A permissions table and dynamic policy engine:** deferred. Two fixed roles and one machine scope
  are clearer and less error-prone at the current product scale.

## Consequences

- New protected endpoints must explicitly select `CurrentUser`, `require_roles(...)`, or
  `require_machine_access` as appropriate.
- Managers and operators must both receive 403 responses for actions outside their scope; the API
  must not rely on frontend route guards.
- Fine-grained permissions, delegation, and temporary cross-machine cover are future requirements
  and would require a schema and policy-design review.

## Primary references

- [FastAPI: dependency injection](https://fastapi.tiangolo.com/tutorial/dependencies/)
- [OWASP: Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
