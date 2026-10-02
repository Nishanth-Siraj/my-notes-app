# S3 Bucket Manager

Python CLI to create, list, inspect, update and delete AWS S3 buckets.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Configure credentials with `aws configure`, or set these environment variables:

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_DEFAULT_REGION=us-east-1
```

## Usage

```bash
# Create (public access blocked by default)
python s3_manager.py create my-unique-bucket --region ap-south-1 --versioning --tag env=dev --tag owner=nishanth

# List
python s3_manager.py list
python s3_manager.py list --json

# Detail
python s3_manager.py detail my-unique-bucket
python s3_manager.py detail my-unique-bucket --json

# Update
python s3_manager.py update my-unique-bucket --versioning suspend
python s3_manager.py update my-unique-bucket --tag env=prod --tag team=infra
python s3_manager.py update my-unique-bucket --public-access block
python s3_manager.py update my-unique-bucket --encryption kms --kms-key-id alias/my-key

# Upload a file (object key defaults to the file name)
python s3_manager.py upload my-unique-bucket ./report.pdf
python s3_manager.py upload my-unique-bucket ./report.pdf --key docs/report.pdf

# Empty (deletes all objects and versions, keeps the bucket; prompts first)
python s3_manager.py empty my-unique-bucket
python s3_manager.py empty my-unique-bucket --prefix logs/ -y

# Delete (prompts for confirmation; --force empties the bucket first)
python s3_manager.py delete my-unique-bucket
python s3_manager.py delete my-unique-bucket --force -y
```

## Notes app

A FastAPI notes editor (Markdown, code blocks with syntax highlighting, image upload, search, tags) with everything stored in one database.

```bash
pip install -r requirements.txt
cd notes_app
../.venv/bin/uvicorn app:app --reload --port 8000     # http://127.0.0.1:8000
```

### Quiz (flashcards)

Open `/quiz`. Cards have a Markdown question and answer (text, code blocks, images). Review flow: read the question, optionally type your answer, reveal, then grade yourself as Wrong or Correct and pick when to see the card again (1/3/7/14/30 days, or a custom number). Anki-style behaviour: a wrong card comes back later in the same session until you answer it correctly, keeps a short interval afterwards, and intervals grow about 2.5x on each correct answer. The dashboard shows due, forgotten and new counts and offers "Relearn forgotten" and "Practice all" modes.

Locally it uses `notes_app/notes.db` (SQLite). For hosting, set `DATABASE_URL` to a free Postgres (Neon or Supabase) and `NOTES_PASSWORD`. See [notes_app/DEPLOY.md](notes_app/DEPLOY.md).
