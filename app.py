"""
Root-level entry point so `uvicorn app:app` works from the repo root
(e.g. Render with no Root Directory set). The real app lives in notes_app/app.py.
"""
from notes_app.app import app  # noqa: F401
