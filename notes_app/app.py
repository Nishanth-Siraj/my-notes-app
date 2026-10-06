#!/usr/bin/env python3
"""
Notes app - FastAPI + SQLAlchemy. Markdown notes with code blocks and images.

Run locally:
    uvicorn app:app --reload --port 8000        (from the notes_app folder)
    python app.py                               (same, without reload)

Storage:
    Everything, including uploaded images, lives in ONE database so the app
    works on hosts that wipe local disk on every deploy.

    DATABASE_URL     sqlite:///./notes.db (default)  or a Postgres URL such as
                     postgresql://user:pass@host/db  (Neon, Supabase, Render)
    NOTES_PASSWORD   if set, the app asks for this password before use
    NOTES_SECRET     secret for the login cookie (auto-generated if unset,
                     which logs everyone out on each restart)

    These can also be put in notes_app/.env (gitignored), one KEY=VALUE per line.
"""

import datetime
import hmac
import os
import re
import secrets
import sys
import uuid
from typing import List, Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from sqlalchemy import (
    Column, DateTime, Integer, LargeBinary, String, Text, create_engine, literal, or_
)
from sqlalchemy.orm import Session, declarative_base, sessionmaker
from starlette.middleware.sessions import SessionMiddleware

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)
# quiz.py imports shared objects from this module under a fixed alias, so it works whether this
# file was imported as `app` (uvicorn in notes_app/) or `notes_app.app` (root shim on Render).
sys.modules["notes_core"] = sys.modules[__name__]


def load_dotenv(path):
    """Minimal .env loader: KEY=VALUE lines, no dependency. Existing env wins."""
    if not os.path.exists(path):
        return
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)


load_dotenv(os.path.join(BASE_DIR, ".env"))

DATA_DIR = os.environ.get("NOTES_DATA_DIR", BASE_DIR)
DATABASE_URL = os.environ.get("DATABASE_URL") or f"sqlite:///{os.path.join(DATA_DIR, 'notes.db')}"
# Heroku/Render style URLs -> SQLAlchemy psycopg3 driver
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len("postgres://"):]
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = "postgresql+psycopg://" + DATABASE_URL[len("postgresql://"):]

PASSWORD = os.environ.get("NOTES_PASSWORD", "")
SECRET = os.environ.get("NOTES_SECRET") or secrets.token_hex(32)
ALLOWED_EXT = {"png", "jpg", "jpeg", "gif", "webp", "svg"}
MAX_UPLOAD_MB = 10

# --------------------------------------------------------------------------- #
# Database
# --------------------------------------------------------------------------- #

engine_kwargs = {"pool_pre_ping": True}
if DATABASE_URL.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}
engine = create_engine(DATABASE_URL, **engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)


class Note(Base):
    __tablename__ = "notes"
    id = Column(Integer, primary_key=True)
    title = Column(String(300), nullable=False, default="Untitled")
    content = Column(Text, nullable=False, default="")
    tags = Column(String(500), nullable=False, default="")
    created_at = Column(DateTime, nullable=False, default=utcnow)
    updated_at = Column(DateTime, nullable=False, default=utcnow)


class Image(Base):
    __tablename__ = "images"
    id = Column(Integer, primary_key=True)
    filename = Column(String(200), nullable=False, unique=True)
    original_name = Column(String(300))
    content_type = Column(String(100), nullable=False)
    data = Column(LargeBinary, nullable=False)
    size_bytes = Column(Integer, nullable=False)
    note_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# App + auth
# --------------------------------------------------------------------------- #

app = FastAPI(title="Azazel", docs_url=None, redoc_url=None)
app.add_middleware(
    SessionMiddleware, secret_key=SECRET, max_age=30 * 24 * 3600, same_site="lax"
)
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"), auto_reload=True)


class NotLoggedIn(Exception):
    pass


def require_login(request: Request):
    if PASSWORD and request.session.get("auth") is not True:
        raise NotLoggedIn()


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    if request.url.path.startswith("/api/") or request.url.path.startswith("/images/"):
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
    return templates.TemplateResponse(
        request, "error.html",
        {"status": exc.status_code, "detail": exc.detail, "has_password": bool(PASSWORD)},
        status_code=exc.status_code,
    )


@app.exception_handler(NotLoggedIn)
async def not_logged_in(request: Request, _exc):
    if request.url.path.startswith("/api/"):
        return JSONResponse({"error": "login required"}, status_code=401)
    return RedirectResponse(f"/login?next={request.url.path}", status_code=303)


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    if not PASSWORD or request.session.get("auth") is True:
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse(request, "login.html", {"error": None})


@app.post("/login")
def login_submit(request: Request, password: str = Form(""), next: str = "/"):
    if hmac.compare_digest(password, PASSWORD):
        request.session["auth"] = True
        return RedirectResponse(next if next.startswith("/") else "/", status_code=303)
    return templates.TemplateResponse(
        request, "login.html", {"error": "Wrong password"}, status_code=401
    )


@app.post("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


@app.get("/healthz")
def healthz():
    # Render exposes the deployed commit as RENDER_GIT_COMMIT; CI uses it to wait for the right build.
    return {"ok": True, "commit": os.environ.get("RENDER_GIT_COMMIT") or os.environ.get("GIT_COMMIT") or "unknown"}


# --------------------------------------------------------------------------- #
# Notes API
# --------------------------------------------------------------------------- #

class NoteIn(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    tags: Optional[object] = None  # list[str] or "a, b" string


def norm_tags(tags) -> str:
    if tags is None:
        return ""
    if isinstance(tags, str):
        tags = tags.split(",")
    seen, out = set(), []
    for t in tags:
        t = str(t).strip().lower()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return ",".join(out)


def note_out(n: Note, with_content=True):
    d = {
        "id": n.id,
        "title": n.title,
        "tags": [t for t in n.tags.split(",") if t],
        "created_at": n.created_at.isoformat() + "Z",
        "updated_at": n.updated_at.isoformat() + "Z",
    }
    if with_content:
        d["content"] = n.content
    else:
        d["snippet"] = snippet(n.content)
    return d


def snippet(md: str, limit: int = 140) -> str:
    """Plain-text preview of Markdown: drop code fences, images, headings, emphasis."""
    text = re.sub(r"```.*?```", " ", md, flags=re.S)          # fenced code blocks
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)       # images
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)   # links -> text
    text = re.sub(r"^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+", "", text, flags=re.M)  # headings, quotes, bullets
    text = re.sub(r"[`*_~|]", "", text)                       # inline markers, table pipes
    text = re.sub(r"-{3,}", " ", text)
    text = " ".join(text.split())
    return text[:limit] + ("…" if len(text) > limit else "")


@app.get("/api/notes", dependencies=[Depends(require_login)])
def list_notes(q: str = "", tag: str = "", db: Session = Depends(get_db)):
    return [note_out(n, with_content=False) for n in query_notes(db, q, tag)]


@app.post("/api/notes", status_code=201, dependencies=[Depends(require_login)])
def create_note(body: NoteIn, db: Session = Depends(get_db)):
    n = Note(
        title=(body.title or "Untitled").strip() or "Untitled",
        content=body.content or "",
        tags=norm_tags(body.tags),
    )
    db.add(n)
    db.commit()
    db.refresh(n)
    return note_out(n)


@app.get("/api/notes/{note_id}", dependencies=[Depends(require_login)])
def get_note(note_id: int, db: Session = Depends(get_db)):
    n = db.get(Note, note_id)
    if n is None:
        raise HTTPException(404, "note not found")
    return note_out(n)


@app.put("/api/notes/{note_id}", dependencies=[Depends(require_login)])
def update_note(note_id: int, body: NoteIn, db: Session = Depends(get_db)):
    n = db.get(Note, note_id)
    if n is None:
        raise HTTPException(404, "note not found")
    if body.title is not None:
        n.title = body.title.strip() or "Untitled"
    if body.content is not None:
        n.content = body.content
    if body.tags is not None:
        n.tags = norm_tags(body.tags)
    n.updated_at = utcnow()
    db.commit()
    db.refresh(n)
    return note_out(n)


@app.delete("/api/notes/{note_id}", dependencies=[Depends(require_login)])
def delete_note(note_id: int, db: Session = Depends(get_db)):
    n = db.get(Note, note_id)
    if n is None:
        raise HTTPException(404, "note not found")
    db.delete(n)
    db.query(Image).filter(Image.note_id == note_id).delete()
    db.commit()
    return {"deleted": note_id}


@app.get("/api/tags", dependencies=[Depends(require_login)])
def list_tags(db: Session = Depends(get_db)):
    return tag_counts(db)


@app.get("/api/search/suggest", dependencies=[Depends(require_login)])
def search_suggest(q: str = "", db: Session = Depends(get_db)):
    """Return up to 8 suggestions: matching note titles + matching tags."""
    if not q or len(q) < 1:
        return {"titles": [], "tags": []}
    like = f"%{q.lower()}%"
    # titles matching anywhere in title
    titles = (
        db.query(Note.id, Note.title)
        .filter(Note.title.ilike(like))
        .order_by(Note.updated_at.desc())
        .limit(6)
        .all()
    )
    # tags matching q
    tc = tag_counts(db)
    matched_tags = [t["tag"] for t in tc if q.lower() in t["tag"].lower()][:6]
    return {
        "titles": [{"id": r.id, "title": r.title} for r in titles],
        "tags": matched_tags,
    }


# --------------------------------------------------------------------------- #
# Pages
# --------------------------------------------------------------------------- #

def render(request: Request, name: str, **ctx):
    ctx.setdefault("has_password", bool(PASSWORD))
    resp = templates.TemplateResponse(request, name, ctx)
    resp.headers["Cache-Control"] = "no-store"
    return resp


def fmt(dt: datetime.datetime) -> str:
    return dt.strftime("%d %b %Y, %H:%M UTC")


def query_notes(db: Session, q: str = "", tag: str = ""):
    query = db.query(Note)
    q, tag = q.strip(), tag.strip().lower()
    if q:
        like = f"%{q}%"
        query = query.filter(or_(Note.title.like(like), Note.content.like(like), Note.tags.like(like)))
    if tag:
        query = query.filter((literal(",") + Note.tags + literal(",")).like(f"%,{tag},%"))
    return query.order_by(Note.updated_at.desc()).all()


def tag_counts(db: Session):
    counts = {}
    for (tags,) in db.query(Note.tags).filter(Note.tags != "").all():
        for t in tags.split(","):
            counts[t] = counts.get(t, 0) + 1
    return sorted(({"tag": k, "count": v} for k, v in counts.items()),
                  key=lambda x: (-x["count"], x["tag"]))


@app.get("/", response_class=HTMLResponse, dependencies=[Depends(require_login)])
def list_page(request: Request, q: str = "", tag: str = "", db: Session = Depends(get_db)):
    notes = query_notes(db, q, tag)
    items = []
    for n in notes:
        d = note_out(n, with_content=False)
        d["updated_display"] = fmt(n.updated_at)
        items.append(d)
    return render(request, "list.html", notes=items, tags=tag_counts(db), q=q, active_tag=tag.lower())


@app.get("/notes/new", response_class=HTMLResponse, dependencies=[Depends(require_login)])
def new_page(request: Request):
    return render(request, "editor.html", note=None, mode="create")


@app.get("/notes/{note_id}", response_class=HTMLResponse, dependencies=[Depends(require_login)])
def detail_page(request: Request, note_id: int, db: Session = Depends(get_db)):
    n = db.get(Note, note_id)
    if n is None:
        raise HTTPException(404, "note not found")
    d = note_out(n)
    d["created_display"] = fmt(n.created_at)
    d["updated_display"] = fmt(n.updated_at)
    return render(request, "detail.html", note=d)


@app.get("/notes/{note_id}/edit", response_class=HTMLResponse, dependencies=[Depends(require_login)])
def edit_page(request: Request, note_id: int, db: Session = Depends(get_db)):
    n = db.get(Note, note_id)
    if n is None:
        raise HTTPException(404, "note not found")
    return render(request, "editor.html", note=note_out(n), mode="edit")


# --------------------------------------------------------------------------- #
# Images (stored in the database)
# --------------------------------------------------------------------------- #

@app.post("/api/upload", status_code=201, dependencies=[Depends(require_login)])
async def upload_image(
    file: UploadFile = File(...),
    note_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
):
    name = file.filename or "image.png"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in ALLOWED_EXT or not (file.content_type or "").startswith("image/"):
        raise HTTPException(400, f"unsupported type; allowed: {sorted(ALLOWED_EXT)}")
    data = await file.read()
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"file larger than {MAX_UPLOAD_MB} MB")

    img = Image(
        filename=f"{datetime.datetime.now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:8]}.{ext}",
        original_name=name,
        content_type=file.content_type,
        data=data,
        size_bytes=len(data),
        note_id=note_id,
    )
    db.add(img)
    db.commit()
    db.refresh(img)
    return {
        "id": img.id,
        "url": f"/images/{img.id}/{img.filename}",
        "filename": img.filename,
        "original_name": name,
        "size_bytes": len(data),
    }


@app.get("/images/{image_id}/{filename}", dependencies=[Depends(require_login)])
def serve_image(image_id: int, filename: str, db: Session = Depends(get_db)):
    img = db.get(Image, image_id)
    if img is None or img.filename != filename:
        raise HTTPException(404, "image not found")
    return Response(
        content=img.data,
        media_type=img.content_type,
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )


@app.get("/api/images", dependencies=[Depends(require_login)])
def list_images(db: Session = Depends(get_db)):
    rows = db.query(Image.id, Image.filename, Image.original_name, Image.size_bytes,
                    Image.note_id, Image.created_at).order_by(Image.created_at.desc()).all()
    return [
        {"id": r.id, "url": f"/images/{r.id}/{r.filename}", "filename": r.filename,
         "original_name": r.original_name, "size_bytes": r.size_bytes,
         "note_id": r.note_id, "created_at": r.created_at.isoformat() + "Z"}
        for r in rows
    ]


# --------------------------------------------------------------------------- #
# Quiz module (flashcards) + table creation
# --------------------------------------------------------------------------- #

import quiz  # noqa: E402  (needs the names above)
app.include_router(quiz.router)
Base.metadata.create_all(engine)
quiz.migrate(engine)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8000"))
    print(f"Notes app: http://127.0.0.1:{port}   (db: {DATABASE_URL})")
    uvicorn.run("app:app", host="0.0.0.0", port=port)
