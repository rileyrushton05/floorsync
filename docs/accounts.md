# Accounts and signing in

## Purpose

FloorSync has no sign-up page, because the API has no registration route. Every account is created
server-side against a running stack. This document is the procedure for doing that, plus the
day-to-day account management a team member needs during development and user testing.

The design behind it is recorded in
[local JWT authentication](decisions/0007-local-jwt-authentication.md) and
[route-declared authorization](decisions/0008-route-declared-authorization.md); this page is the
operational counterpart and assumes those decisions rather than re-arguing them.

## How sign-in works

An account is two rows, deliberately kept apart:

| Table | Holds | Why it is separate |
| --- | --- | --- |
| `users` | The production-domain record: display name, role, and an operator's machine. | Scheduling and auditing code references it, so it must not carry secrets. |
| `user_credentials` | Username, Argon2 password hash, active flag, last successful sign-in. | Credential lifecycle is authentication data, not production data. |

Signing in posts form-encoded `username` and `password` to `POST /api/v1/auth/token` and gets back a
30-minute HS256 bearer token. `GET /api/v1/auth/me` returns the safe profile and doubles as the
cheapest way to test a token.

A valid token is not sufficient on its own. Every protected request reloads the user through its
credential and requires that credential to still be active, so disabling an account takes effect on
the next request rather than when the token expires.

There are two roles. A **manager** has no machine and can see the whole floor. An **operator** is
bound to exactly one machine at a time and is refused anything outside it.

## Before you start

The stack must be running and migrated, because these commands execute inside the `api` container
and write to PostgreSQL:

```bash
docker compose up --build -d
```

Every command below runs through `docker compose run --rm api`, which starts a throwaway container
against the same database. The stack does not need to be idle, and nothing here restarts a service.

## Create a manager account

Edit the three constants at the top, then run it as one command:

```bash
docker compose run --rm api python -c "
import asyncio
from floorsync_common.database.models.user import User
from floorsync_common.database.models.user_credential import UserCredential
from floorsync_common.database.session import session_scope
from floorsync_common.users import UserService

NAME = 'Ada Manager'
USERNAME = 'manager'
PASSWORD = 'floorsync-dev'

async def main():
    async with session_scope() as session:
        user = User(name=NAME, role='manager')
        session.add(user)
        await session.flush()
        session.add(
            UserCredential(
                user_id=user.id,
                username=USERNAME,
                password_hash=UserService.hash_password(PASSWORD),
            )
        )
        print('created', USERNAME, user.id)

asyncio.run(main())
"
```

`USERNAME` must be lowercase and `PASSWORD` is hashed with Argon2 before it is stored — the plain
value is never written to the database.

A manager is enough to sign in and use `/manager/simulation`, which is the one route that reads from
the API today.

## Operator accounts

Operator logins are never created by hand: **every machine gets one automatically** when it is
created, whether a manager adds it on the Machines page (`POST /api/v1/machines`) or `make db-seed`
loads it. Each machine has exactly one operator login.

| Field | Starts as |
| --- | --- |
| Username | The machine name as a lowercase slug: `abz5/M0` becomes `abz5-m0`, `CNC Lathe 2` becomes `cnc-lathe-2`. If that is taken, `-2`, `-3`… is appended. |
| Display name | The machine name. |
| Password | `OPERATOR_DEFAULT_PASSWORD`, which defaults to `floorsync-dev`. The UI never shows it. |

After that, a manager manages operator logins under **Settings → Operator accounts**
(`GET /api/v1/operators`, `PATCH /api/v1/operators/{id}`). They can:

- change the display name and username,
- set a new password (no need to know the old one),
- disable or re-enable the login, and
- move the operator to another machine. That machine must already have an operator, and **the two
  operators swap machines**. Moving onto a free machine is refused, because the old machine would be
  left with no login and nothing creates one for an existing machine.

The login follows its machine:

- **Renaming a machine** re-derives the operator's username from the new name, overwriting a
  username a manager set by hand. The display name follows too, but only while it still matches
  the old machine name.
- **Removing a machine** removes its operator login in the same transaction.

Machines that existed before this behaviour was added have no operator login and do not get one
retroactively. Reseed, or recreate the machine, to get one.

## Verify an account

Sign in and read the profile back without involving the browser:

```bash
curl -s -X POST http://localhost:8002/api/v1/auth/token \
  -d "username=manager&password=floorsync-dev"
```

That returns `access_token`, `token_type` and `expires_in`. Use the token against `/auth/me`:

```bash
curl -s http://localhost:8002/api/v1/auth/me -H "Authorization: Bearer <token>"
```

A manager gets back `"role":"manager"` with a null `machine_id`; an operator gets its machine's UUID.

The same three responses are worth knowing when something looks wrong:

| Request | Response | Meaning |
| --- | --- | --- |
| Bad username or password | `401` | One message for both, deliberately, so the API does not confirm which usernames exist. |
| No or expired token on a protected route | `401` | There is no refresh endpoint; sign in again. |
| Operator calling `GET /api/v1/schedules` | `403` | Schedule listing is manager-only. |

You can also drive the whole flow from the interactive docs at <http://localhost:8002/docs> —
**Authorize** accepts the same username and password, because the token endpoint is an OAuth2
password form.

## Managing accounts

### List every account

```bash
docker compose run --rm api python -c "
import asyncio
from sqlalchemy import select
from floorsync_common.database.models.machine import Machine
from floorsync_common.database.models.user import User
from floorsync_common.database.models.user_credential import UserCredential
from floorsync_common.database.session import session_scope

async def main():
    async with session_scope() as session:
        rows = (await session.execute(
            select(UserCredential.username, User.name, User.role, UserCredential.active, Machine.name)
            .join(User, User.id == UserCredential.user_id)
            .outerjoin(Machine, Machine.id == User.machine_id)
            .order_by(UserCredential.username)
        )).all()
        for username, name, role, active, machine in rows:
            state = 'active' if active else 'disabled'
            print(f'{username:<12} {role:<9} {state:<9} {name} {machine or \"\"}')

asyncio.run(main())
"
```

### Reset a password, or disable an account

For operators, use **Settings → Operator accounts** instead. For a manager, both are edits to the
credential row. Set `active = False` to disable an account, which takes effect
on that account's next request rather than when its current token expires:

```bash
docker compose run --rm api python -c "
import asyncio
from sqlalchemy import select
from floorsync_common.database.models.user_credential import UserCredential
from floorsync_common.database.session import session_scope
from floorsync_common.users import UserService

USERNAME = 'operator'

async def main():
    async with session_scope() as session:
        credential = (
            await session.execute(
                select(UserCredential).where(UserCredential.username == USERNAME)
            )
        ).scalar_one()
        credential.password_hash = UserService.hash_password('a-new-password')
        credential.active = True
        print('updated', USERNAME)

asyncio.run(main())
"
```

A disabled account is refused at sign-in with the same `401` as a wrong password.

## Rules the database enforces

These are constraints, not conventions, so breaking one fails the insert with an `IntegrityError`
rather than creating a subtly broken account:

| Rule | Constraint | Symptom |
| --- | --- | --- |
| Usernames are lowercase | `username_is_lowercase` | `CheckViolationError` on a mixed-case username. |
| Usernames are unique | unique index on `username` | `UniqueViolationError` when the name is taken. |
| One credential per user | unique index on `user_id` | `UniqueViolationError` on a second credential. |
| Operators have a machine, managers do not | `operator_role_matches_machine` | `CheckViolationError` for an operator with no `machine_id`, or a manager with one. |

Sign-in lowercases and trims what it is given, so an account created as `manager` can be typed as
`Manager` in the login form. Creation does not normalise for you — that is what the constraint is
for.

## Seeding and operator accounts

`make db-seed` replaces the whole scenario: it deletes the jobs, machines, schedules and simulations
that were loaded before. Operator logins go with them, because an operator is defined by a machine
that no longer exists. The seed reports this as `removed N operator login(s)`. It then creates a
fresh operator login for every machine it loads, with the default password, and reports that as
`created N operator login(s)`.

**Manager logins survive seeding.** They are not scenario data and are not tied to a machine.

Any username, password or machine changes made to operators are lost on a reseed.

## What is deliberately missing

Naming these avoids someone hunting for a feature that was never built:

- **No registration route and no sign-up page.** Manager accounts are created here, by hand;
  operator accounts only ever come with a machine.
- **No password rules.** Nothing enforces length or complexity, so a development password can be
  anything. This is a prototype gate, not a hardened one.
- **No refresh tokens.** A token lasts 30 minutes
  (`JWT_ACCESS_TOKEN_EXPIRE_MINUTES`) and cannot be renewed; the holder signs in again. A tab left
  open overnight lands on the login screen.
- **No self-service password reset, MFA, or external identity provider.** All four were considered
  and deferred in [ADR 0007](decisions/0007-local-jwt-authentication.md).
- **No account-provisioning CLI.** The commands above are the interface, which is why they are
  written out in full rather than wrapped in a `make` target.

## Beyond local development

Two settings stop being defaults the moment this runs anywhere but a laptop:

- `JWT_SECRET_KEY` must be a unique value of at least 32 characters. The API refuses to start with
  the committed development secret when `ENVIRONMENT=production`, and that check is the only thing
  standing between the repository and forgeable tokens. Generate one with
  `python -c "import secrets; print(secrets.token_urlsafe(48))"` and supply it through the
  deployment's secret mechanism, never through a committed file.
- `POSTGRES_PASSWORD` is `floorsync` in `.env.example`. It is fine for a container that only listens
  on localhost and nothing else.

The token is held in the browser's `sessionStorage`, so it survives a reload but dies with the tab.
That is readable by any script on the page, as any browser-held token is; the protection that matters
is the short expiry and the active-credential recheck on every request.

## Related documents

- [Local setup and deployment](../deployment/README.md) — the full first-run procedure.
- [ADR 0007: Local JWT authentication](decisions/0007-local-jwt-authentication.md)
- [ADR 0008: Route-declared role and machine authorization](decisions/0008-route-declared-authorization.md)
- [Frontend README](../src/frontend/README.md) — how the browser holds the token.
