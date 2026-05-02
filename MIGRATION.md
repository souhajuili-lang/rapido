# Rapido — PostgreSQL Migration Guide

## What changed

| Before | After |
|--------|-------|
| `lowdb` (JSON file) | `pg` (PostgreSQL connection pool) |
| `db.json` flat file | Relational tables with indexes |
| Plain-text PINs in JSON | bcrypt-hashed PINs via `pgcrypto` |
| Race conditions on file writes | ACID transactions |

Removed packages: `lowdb`, `nedb-promises`  
Added packages: `pg`

---

## Quick start (local)

### 1. Create the database

```bash
createdb rapido
```

### 2. Apply schema + seed data

```bash
psql rapido -f schema.sql
```

### 3. Configure environment

```bash
cp .env.example .env
# edit .env — at minimum set DATABASE_URL or PGPASSWORD
```

### 4. Install dependencies

```bash
npm install
```

### 5. Start

```bash
npm start
# or for auto-reload during development:
npm run dev
```

---

## Cloud deployment

### Heroku / Render / Railway

These platforms provision Postgres and set `DATABASE_URL` automatically.

```bash
# Heroku example
heroku addons:create heroku-postgresql:mini
heroku run psql $DATABASE_URL -f schema.sql
```

### Supabase / Neon

1. Create a project and copy the connection string.
2. Set `DATABASE_URL=postgres://...` in your env.
3. Run `schema.sql` in the SQL editor or via `psql`.

### Docker Compose (local with Postgres container)

```yaml
version: '3.9'
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: rapido
      POSTGRES_PASSWORD: rapido
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./schema.sql:/docker-entrypoint-initdb.d/schema.sql

  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgres://postgres:rapido@db:5432/rapido
      JWT_SECRET: change_me
    depends_on:
      - db

volumes:
  pgdata:
```

```bash
docker compose up
```

---

## Default credentials

| Role       | PIN  |
|------------|------|
| Admin      | 0000 |
| Ahmed      | 1234 |
| Khalil     | 2345 |
| Rim        | 3456 |
| Mohamed    | 4567 |

> PINs are stored as bcrypt hashes — never in plain text.

---

## Schema overview

```
restaurants   ← menus stored as JSONB
     ↑
   orders  ← items stored as JSONB, FK → restaurants + drivers
     ↑
   drivers
     
settings  (singleton row, admin PIN hash here)
```

Key design decisions:
- **JSONB for `items` and `menu`**: avoids an extra join for the hot read path while keeping flexibility.
- **`pgcrypto` crypt()**: PIN verification happens inside Postgres — the hash never leaves the DB.
- **`order_seq` sequence**: guarantees unique `RP-XXXX` IDs even under concurrent load.
- **Transaction in `PATCH /orders`**: driver stats update and order status update are atomic.
