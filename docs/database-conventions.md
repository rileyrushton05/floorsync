# Database conventions

FloorSync uses PostgreSQL 16, SQLAlchemy 2 typed declarative mappings, and Alembic. These conventions
keep the application model, generated migrations, and production schema aligned.

## Models and names

- Concrete models inherit from `Base`; most domain entities also use `UUIDPrimaryKeyMixin` and
  `TimestampMixin` from `floorsync_common.database.models`.
- Python model names are singular `PascalCase`. Tables and columns are plural/singular `snake_case`
  nouns respectively: `floor_plans`, `building_id`, and `created_at`.
- Name relationships after the domain concept and use `Mapped[...]` plus `mapped_column()` throughout.
- Import each concrete model module from `floorsync_common.database.models.__init__`; otherwise
  Alembic cannot discover it.
- Every table has a primary key. Public domain entities use native PostgreSQL UUID v4 identifiers;
  high-volume tables may choose an identity bigint only through a documented decision.

## Columns and data types

- Declare nullability intentionally. Required domain values use `nullable=False`; absence must have a
  defined business meaning before a nullable column is introduced.
- Store instants as `DateTime(timezone=True)` / PostgreSQL `timestamptz`. Store UTC and convert for
  display. A recurring local schedule stores its IANA timezone separately.
- Standard audit columns are `created_at` and `updated_at`. The database supplies initial values;
  SQLAlchemy updates `updated_at` on application writes.
- Use `Numeric(precision, scale)` and Python `Decimal` for money or exact quantities, never `float`.
- Use `Text` unless a length limit is a real domain constraint. Do not add arbitrary `VARCHAR(255)`
  limits.
- Prefer relational columns and tables for core searchable data. Use `JSONB` only for genuinely
  flexible metadata, with validation and a query-driven index when needed.
- Prefer check constraints or lookup tables for values likely to change. Native PostgreSQL enums
  require an explicit migration plan because changing them is operationally more complex.
- Defaults that must apply to every writer belong in the database with `server_default`; Python-only
  defaults are acceptable only for application-specific behaviour.

## Constraints, relationships, and indexes

- Enforce invariants in the database with named primary key, foreign key, unique, and check
  constraints. The shared metadata naming convention gives Alembic stable names; check constraints
  still receive an explicit semantic name.
- Choose `ondelete` deliberately. Default to restricting deletion; use `CASCADE` only when the child
  has no valid independent lifecycle, and align ORM cascade/passive-delete behaviour with it.
- Index foreign-key columns used for joins or parent update/deletion paths. PostgreSQL does not
  automatically index the referencing side of a foreign key.
- Add indexes from demonstrated query patterns, including the complete filter and ordering needed by
  cursor pagination. Avoid speculative single-column indexes because every index has write cost.
- Use a unique constraint for a domain invariant; do not rely on an application pre-check that races
  under concurrency.

## Sessions and queries

- Session lifetime belongs to the transport or task boundary. Transaction lifetime belongs to one
  application operation.
- Autobegin is disabled. Every query or mutation runs inside `session.begin()` or a supplied session
  scope. Helper functions may flush but do not commit or roll back a caller-owned transaction.
- Use SQLAlchemy 2 `select()` statements. Parameterize all values; never build SQL with string
  interpolation.
- Avoid implicit relationship loading in async code. Declare the required eager-loading strategy in
  the query and watch for N+1 queries.
- Never share a session between concurrent asyncio tasks, threads, or Celery processes.

## Migrations

- Alembic migrations are the only schema-change mechanism. Application startup never calls
  `Base.metadata.create_all()` or automatically upgrades production schemas.
- Generate a revision with `make db-revision name="short description"`, then review both `upgrade()`
  and `downgrade()` manually. Autogenerate output is a candidate, not proof of correctness.
- Prefer backward-compatible expand/migrate/contract changes when deployed code versions may overlap.
- Destructive changes require a backup/restore plan, explicit review, and a recorded decision or risk.
- Test every migration from an empty database and from the previous released schema before release.

## Example model

```python
class Building(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "buildings"

    name: Mapped[str] = mapped_column(Text, nullable=False)
```

## Primary references

- [SQLAlchemy: typed declarative tables](https://docs.sqlalchemy.org/en/20/orm/declarative_tables.html)
- [SQLAlchemy: declarative mixins](https://docs.sqlalchemy.org/en/20/orm/declarative_mixins.html)
- [SQLAlchemy: asyncio](https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html)
- [Alembic: autogeneration](https://alembic.sqlalchemy.org/en/latest/autogenerate.html)
- [Alembic: constraint naming](https://alembic.sqlalchemy.org/en/latest/naming.html)
- [PostgreSQL 16: data types](https://www.postgresql.org/docs/16/datatype.html)
- [PostgreSQL 16: constraints](https://www.postgresql.org/docs/16/ddl-constraints.html)
- [PostgreSQL 16: UUID functions](https://www.postgresql.org/docs/16/functions-uuid.html)
