# Database migrations

SQLAlchemy models live in `floorsync_common.database.models`. Import every new model module
from that package's `__init__.py` so Alembic can discover it.

Apply all migrations to the Docker Compose database:

```bash
make db-upgrade
```

After changing a model, generate a migration and review the generated operations before
applying it:

```bash
make db-revision name="describe the schema change"
make db-upgrade
```

Application code must not call `Base.metadata.create_all()`. Alembic migrations are the source
of truth for schema changes.
