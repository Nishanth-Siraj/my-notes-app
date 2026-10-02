# Deploying the notes app (FastAPI)

The app stores **everything, including images, in one database**. That is deliberate: every free container host wipes its local disk on each deploy, so a SQLite file or an uploads folder there would be lost. Point `DATABASE_URL` at a free hosted Postgres and the app itself becomes disposable.

Three environment variables matter:

| Variable | Required on a public host | Purpose |
|----------|---------------------------|---------|
| `DATABASE_URL` | Yes | Postgres URL from Neon or Supabase. Unset = local `notes.db` SQLite file. |
| `NOTES_PASSWORD` | Yes | Login password. Without it anyone with the URL can edit your notes. |
| `NOTES_SECRET` | Recommended | Signs the login cookie. If unset, a restart logs you out. |

## Why not InfinityFree

InfinityFree and similar "free unlimited" hosts run PHP + MySQL only. They cannot run Python, so this app will not work there.

## Step 1: free database (do this first)

Pick one. Both are free forever on their base tier and need no card.

**Neon** (https://neon.tech): New project → copy the connection string. Free tier gives 0.5 GB storage, which is plenty for notes and a few hundred screenshots. The database auto-suspends when idle and wakes in under a second.

**Supabase** (https://supabase.com): New project → Settings → Database → Connection string (URI, use the "Session" pooler). Free tier gives 500 MB. Projects are paused after 7 days without any request; one visit un-pauses them.

Either way you end with a URL like `postgresql://user:pass@host/dbname?sslmode=require`. That is your `DATABASE_URL`.

## Step 2: free app host

### Option A: Render (simplest, recommended)

Free web service. Sleeps after 15 minutes idle and takes about 30 seconds to wake on the next visit. Deploys from GitHub on every push. A `render.yaml` is already in the repo root.

1. Push this project to a GitHub repo.
2. https://dashboard.render.com → New → Blueprint → pick the repo. Render reads `render.yaml`.
3. When prompted, set `DATABASE_URL` (from step 1) and `NOTES_PASSWORD`. `NOTES_SECRET` is generated for you.
4. Deploy. Your URL is `https://notes-xxxx.onrender.com`.

Upkeep: none. Render's free tier has a monthly instance-hours limit (750 h) that a single service never exceeds.

### Option B: Hugging Face Spaces (Docker)

Free, no card, no monthly hour limit. Sleeps after 48 hours without visits. Your URL is `https://<user>-notes.hf.space`.

1. https://huggingface.co/new-space → SDK: **Docker** → Visibility: private or public (the app has its own password either way).
2. Upload the contents of `notes_app/` (Dockerfile included) to the Space, or push it with git.
3. Settings → Variables and secrets → add `DATABASE_URL`, `NOTES_PASSWORD`, `NOTES_SECRET` as **secrets**.
4. Settings → add variable `PORT=7860` (Spaces expect that port).

### Option C: Koyeb

Free "nano" web service, one per account, no card. Deploys from GitHub or a Docker image. Set the same three env vars. Sleeps when idle like Render.

### Option D: Oracle Cloud Always Free VM

A real always-on Linux VM with persistent disk, free forever. Here you could even keep SQLite. The trade-off is that you maintain it: OS updates, nginx, TLS certificate, running uvicorn as a service. Only pick this if you want a server to administer.

## Test the Docker image locally

```bash
cd notes_app
docker build -t notes .
docker run --rm -p 8000:8000 -e NOTES_PASSWORD=secret notes
# open http://localhost:8000
```

With a Postgres URL:

```bash
docker run --rm -p 8000:8000 -e NOTES_PASSWORD=secret \
  -e DATABASE_URL='postgresql://...' notes
```

## Backups

Everything is in the one Postgres database. From Neon or Supabase you can download a dump, or run:

```bash
pg_dump "$DATABASE_URL" > notes-backup.sql
```

## Running locally without Docker

```bash
cd notes_app
../.venv/bin/uvicorn app:app --reload --port 8000
# with login:
NOTES_PASSWORD=secret ../.venv/bin/uvicorn app:app --port 8000
```

Local data goes to `notes_app/notes.db` (SQLite).
