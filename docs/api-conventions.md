# API conventions

These rules apply to FloorSync's HTTP product API. They are intentionally small enough to enforce
in review and may be changed through a decision record when product requirements demand it.

## Routes and versions

- Product endpoints live below `/api/v1` and are registered through
  `floorsync_api.routers.api.router`.
- Operational transports such as `GET /health` and `WS /ws` remain unversioned.
- Use plural, lower-case, kebab-case resource paths: `/api/v1/floor-plans/{floor_plan_id}`.
- Model relationships as nested paths only when the child cannot be addressed independently. Do
  not nest beyond one relationship level.
- Do not place actions in paths when an HTTP method expresses the operation. When a domain action
  is genuinely not CRUD, use a subordinate resource such as `POST /bookings/{id}/cancellations`.

## HTTP semantics

| Operation | Method and success response |
| --- | --- |
| Fetch one or many | `GET` with `200 OK` |
| Create | `POST` with `201 Created` and a `Location` header |
| Replace an entire resource | `PUT` with `200 OK` or `204 No Content` |
| Apply a partial update | `PATCH` with `200 OK` |
| Delete | `DELETE` with `204 No Content` |
| Accept asynchronous work | `202 Accepted` with a status-resource URL |

`GET`, `PUT`, and `DELETE` implementations must remain idempotent. Do not return a response body
with `204 No Content`. Use the most specific standard HTTP status rather than encoding success or
failure inside a `200` response.

## Request and response shapes

- JSON property names use `snake_case`, matching Python and the generated OpenAPI contract.
- Use separate Pydantic models for create, update, and response payloads. ORM models are never API
  schemas. Inherit input contracts from `RequestSchema` and output contracts from `ResponseSchema`;
  partial updates use `model_dump(exclude_unset=True)` so omitted and explicit null values remain
  distinct.
- Reject unknown write fields with Pydantic `extra="forbid"` unless forward-compatible metadata is
  an explicit requirement.
- Public identifiers are canonical lower-case UUID strings.
- Instants use timezone-aware RFC 3339 strings and are returned in UTC with `Z`. A local civil time
  must carry a separate IANA timezone identifier when its location matters.
- Monetary and other exact decimal values are never represented with binary floating point.
- Do not expose secrets, internal exception text, SQL details, or authorization-sensitive resource
  existence.

## Errors

All HTTP errors use RFC 9457 Problem Details with the `application/problem+json` media type. The
shared handlers in `floorsync_api.problems` cover framework HTTP errors and request validation.

```json
{
  "type": "urn:floorsync:problem:request-validation",
  "title": "Request validation failed",
  "status": 422,
  "detail": "One or more request parameters were invalid.",
  "instance": "/api/v1/floor-plans",
  "invalid_params": [
    {"name": "body.name", "reason": "Field required"}
  ]
}
```

New problem `type` identifiers are stable API contract values. Domain and persistence code must not
raise FastAPI exceptions; the transport layer maps typed application errors to problem responses.
Expected application outcomes are concrete frozen result types and must be handled exhaustively at
the web edge. See the [backend conventions](backend-conventions.md#expected-outcomes).

## Collections

- Cursor pagination is the default for collections that can grow. Use `limit` and `cursor`, with a
  default limit of 50 and maximum of 100 unless the endpoint documents another bound.
- Return `CursorPage[ResourceRead]`, producing `{"items": [...], "next_cursor": "..."}`; use `null`
  when there is no next page.
- Every cursor query has a stable, unique ordering with the primary key as the final tie-breaker.
- Filters and sortable fields are explicit allowlists. Never interpolate client-supplied field names
  or directions into SQL.

## Transaction boundary

The request dependency owns session lifetime, while the route-level application operation owns the
transaction. Autobegin is disabled, so reads and writes outside an explicit transaction fail early.

```python
@router.post("/resources", status_code=201)
async def create_resource(command: ResourceCreate, db: DbSession) -> ResourceRead:
    async with db.begin():
        result = await ResourceService.create_resource(
            db,
            name=command.name,
        )

    match result:
        case ResourceCreated(resource=resource):
            return ResourceRead.model_validate(resource)
        case ResourceNameAlreadyExists(name=name):
            return resource_name_conflict(name)
        case _:
            assert_never(result)
```

- Begin the transaction before the first query, including reads.
- One request operation normally uses one transaction; repositories and helper functions must not
  commit independently.
- Use `flush()` when a generated value is needed before commit.
- Do not keep a database transaction open while calling slow external services. For future workflows
  that must coordinate a database change with message publication, use an outbox pattern.
- Never share an `AsyncSession` across concurrent tasks.

Service structure, session ownership, expected outcomes, and repository extraction rules are defined
in the [backend conventions](backend-conventions.md).

## Documentation and testing

- Every endpoint defines request and response models, status codes, tags, and a concise summary so
  the OpenAPI document remains a useful contract.
- Test the success case, validation failure, authorization boundary when applicable, not-found case,
  transaction rollback, and pagination boundary.
- Backward-incompatible changes require a new API version or an explicitly approved migration plan.

## Primary references

- [RFC 9110: HTTP semantics](https://datatracker.ietf.org/doc/html/rfc9110)
- [RFC 9457: Problem Details for HTTP APIs](https://datatracker.ietf.org/doc/html/rfc9457)
- [RFC 3339: Internet timestamps](https://datatracker.ietf.org/doc/html/rfc3339)
- [FastAPI: bigger applications](https://fastapi.tiangolo.com/tutorial/bigger-applications/)
- [FastAPI: handling errors](https://fastapi.tiangolo.com/tutorial/handling-errors/)
- [SQLAlchemy: session basics](https://docs.sqlalchemy.org/en/20/orm/session_basics.html)
