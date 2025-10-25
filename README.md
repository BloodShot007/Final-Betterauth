# Run BetterAuth as a Sidecar (Docker) for CerebraUI

This guide shows how to run your **BetterAuth** service from this repo in Docker, backed by PostgreSQL, so CerebraUI can use it as a third‑party auth backend.

> Works on **macOS**, **Linux** and **Windows (PowerShell)**.

---

## Prerequisites

- Docker Desktop 4.x (includes `docker compose`)
- This repository cloned locally (your repo: `Final-Betterauth`)
- A PostgreSQL volume (created automatically by compose)

---

## Quick Start

### 1) Create an `.env` file (repo root)

Copy this as `.env` in the repo root and adjust as needed:

```
DATABASE_URL="postgresql+psycopg2://postgres:postgres@db:5432/cerebraui"
JWT_SECRET="super-secret-key"
EMAIL_PROVIDER_API_KEY="Provide your email address API from Resend"
MAIL_FROM="CerebraUI <onboarding@resend.dev>"
FRONTEND_URL="http://localhost:3000"
SERVICE_PUBLIC_URL="http://localhost:4000"
```

> Create your account/Login to Resend.com with your personal email where you want to receive the emails for email-verifcation and password-reset.

> After login for the first time, you will see **Add and API Key** option on the dashboard. Copy the API key and paste in on your .env.docker and .env file's **EMAIL_PROVIDER_API_KEY** line.

> Save the .env.docker and .env files

---

### 2) Run this once to put BetterAuth and CerebraUI on the same Docker network (on both macOS/Linux or Windows PowerShell):

```bash
docker network create cerebra_net
```

---

### 3) Run the migrations (Windows vs macOS/Linux)

macOS / Linux (zsh/bash):

```bash
export DATABASE_URL="postgresql://cerebra:cerebra@localhost:5435/cerebra_auth"
npx @better-auth/cli@latest generate --config ./auth.config.mjs
npx @better-auth/cli@latest migrate  --config ./auth.config.mjs
```

Windows (PowerShell):

```bash
$env:DATABASE_URL = "postgresql://cerebra:cerebra@localhost:5435/cerebra_auth"
npx @better-auth/cli@latest generate --config ./auth.config.mjs
npx @better-auth/cli@latest migrate  --config ./auth.config.mjs
```

---

### 4) Start everything:

For BetterAuth:

```bash
docker compose up -d --build
```

For CerebraUI (in its repo):

```bash
docker compose up -d --build
```

Both will join cerebra_net and BetterAuth will connect to Postgres and expose API on its port.


---

### 5) “null value in column id” / sequence mismatch after test data

If you see errors like null value in column "id" (often caused by sequences getting out of sync after manual inserts/deletes), reset the tables and their sequences:

```sql
TRUNCATE TABLE "user" RESTART IDENTITY CASCADE;
TRUNCATE TABLE verification RESTART IDENTITY CASCADE;
```