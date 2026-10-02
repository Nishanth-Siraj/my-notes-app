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

Open `/quiz`. Cards have a Markdown question and answer (text, code blocks, images). The review flow is Anki's: read the question, recall it in your head, press Show answer, then rate **Again / Hard / Good / Easy** (keys 1-4, Space = Good). Each button shows the interval it will set. Scheduling is Anki's SM-2 in days: new cards graduate at 1 day (Easy 4), Good multiplies by the card's ease (starts 250%), Hard x1.2 and lowers ease, Easy x1.3 extra and raises ease, Again lapses the card back to relearning in the same session (it returns a few cards later until you rate it Good) and resets it to 1 day. Intervals are capped at a year, and a custom number of days can be entered instead of the four buttons. The dashboard shows due, forgotten and new counts with "Relearn forgotten" and "Practice all" modes.

Locally it uses `notes_app/notes.db` (SQLite). For hosting, set `DATABASE_URL` to a free Postgres (Neon or Supabase) and `NOTES_PASSWORD`. See [notes_app/DEPLOY.md](notes_app/DEPLOY.md).
