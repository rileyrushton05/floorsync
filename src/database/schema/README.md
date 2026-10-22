# Database schema

The schema is not kept as a separate SQL file. It is defined in two places, and
`docker compose run --rm api alembic check` reports any difference between them:

- **Current shape:** the SQLAlchemy models, one file per table, in
  [`backend/common/floorsync_common/database/models/`](../../backend/common/floorsync_common/database/models/)
- **How it got there:** the Alembic migrations in [`../migrations/`](../migrations/README.md)

The tables, relationships and the reasons behind them are described in
[docs/database-schema.md](../../../docs/database-schema.md), with the production and schedule ERDs
and the [physical schema diagram](../../../docs/diagrams/data/physical-schema.png).

To print the full schema as SQL from a running stack:

```bash
docker compose exec -T postgres pg_dump -U floorsync -d floorsync --schema-only
```
