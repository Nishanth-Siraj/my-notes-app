"""
Quiz / flashcards: Anki-style spaced repetition, mounted by app.py.

Scheduling follows Anki's SM-2 variant, but every interval is expressed in days
and capped at a year, and the reviewer can type a custom number of days.

    rating   learning / relearning card        review card (interval I, ease E)
    ------   ---------------------------       --------------------------------
    again    repeat in this session (10 min)   lapse: repeat now, then 1 day; E -= 0.20
    hard     repeat in this session            I x 1.2;                       E -= 0.15
    good     graduate: 1 day (or lapse ivl)    I x E
    easy     4 days (or 2 x lapse ivl)         I x E x 1.3;                   E += 0.15
    custom   N days, ease unchanged
"""

import datetime
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy import Column, DateTime, Float, Integer, String, Text, inspect, literal, or_, text
from sqlalchemy.orm import Session

from app import Base, get_db, norm_tags, render, require_login, utcnow

router = APIRouter(dependencies=[Depends(require_login)])

RATINGS = ("again", "hard", "good", "easy", "custom")
EASE_START = 2.5
EASE_MIN = 1.3
MAX_DAYS = 365
GRADUATE_DAYS = 1       # Anki "graduating interval"
EASY_NEW_DAYS = 4       # Anki "easy interval"
LAPSE_DAYS = 1          # Anki "new interval" after a lapse (0% -> minimum 1 day)
RELEARN_MINUTES = 10    # Anki learning step


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #

class Card(Base):
    __tablename__ = "cards"
    id = Column(Integer, primary_key=True)
    question = Column(Text, nullable=False, default="")
    answer = Column(Text, nullable=False, default="")
    tags = Column(String(500), nullable=False, default="")
    due_at = Column(DateTime, nullable=False, default=utcnow)
    interval_days = Column(Integer, nullable=False, default=0)
    ease = Column(Float, nullable=False, default=EASE_START)
    reps = Column(Integer, nullable=False, default=0)
    lapses = Column(Integer, nullable=False, default=0)
    last_result = Column(String(10), nullable=True)      # again | hard | good | easy | custom
    last_reviewed = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)
    updated_at = Column(DateTime, nullable=False, default=utcnow)


class Review(Base):
    __tablename__ = "card_reviews"
    id = Column(Integer, primary_key=True)
    card_id = Column(Integer, nullable=False, index=True)
    result = Column(String(10), nullable=False)
    interval_days = Column(Integer, nullable=False)
    reviewed_at = Column(DateTime, nullable=False, default=utcnow)


def migrate(engine):
    """Add columns / rename values introduced after the first deploy (create_all never alters tables)."""
    insp = inspect(engine)
    if "cards" not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns("cards")}
    with engine.begin() as conn:
        if "ease" not in cols:
            conn.execute(text(f"ALTER TABLE cards ADD COLUMN ease FLOAT NOT NULL DEFAULT {EASE_START}"))
        conn.execute(text("UPDATE cards SET last_result='again' WHERE last_result='wrong'"))
        conn.execute(text("UPDATE cards SET last_result='good'  WHERE last_result='correct'"))
        conn.execute(text("UPDATE card_reviews SET result='again' WHERE result='wrong'"))
        conn.execute(text("UPDATE card_reviews SET result='good'  WHERE result='correct'"))


# --------------------------------------------------------------------------- #
# Scheduling (Anki SM-2, in days)
# --------------------------------------------------------------------------- #

def is_learning(card: Card) -> bool:
    """New cards and lapsed cards are in (re)learning: short steps, no ease change."""
    return card.interval_days <= 0 or card.last_result == "again"


def preview_intervals(card: Card) -> dict:
    """Days each rating would schedule. 0 means 'again in this session' (10 min)."""
    if is_learning(card):
        base = LAPSE_DAYS if card.last_result == "again" else GRADUATE_DAYS
        return {"again": 0, "hard": 0, "good": base,
                "easy": EASY_NEW_DAYS if card.last_result != "again" else max(2, base * 2)}
    i, e = card.interval_days, card.ease or EASE_START
    hard = min(MAX_DAYS, max(i + 1, round(i * 1.2)))
    good = min(MAX_DAYS, max(hard + 1, round(i * e)))
    easy = min(MAX_DAYS, max(good + 1, round(i * e * 1.3)))
    return {"again": 0, "hard": hard, "good": good, "easy": easy}


def apply_rating(card: Card, rating: str, custom_days: Optional[int] = None) -> int:
    """Mutate card for this rating; return scheduled days (0 = 10 minutes)."""
    now = utcnow()
    learning = is_learning(card)
    if rating == "custom":
        days = max(0, min(3650, int(custom_days or 0)))
        if days > 0:
            card.interval_days = days
    else:
        days = preview_intervals(card)[rating]
        if not learning:                      # ease only moves for review cards, as in Anki
            if rating == "again":
                card.ease = max(EASE_MIN, round((card.ease or EASE_START) - 0.20, 2))
            elif rating == "hard":
                card.ease = max(EASE_MIN, round((card.ease or EASE_START) - 0.15, 2))
            elif rating == "easy":
                card.ease = round((card.ease or EASE_START) + 0.15, 2)
        if rating == "again":
            card.lapses += 1
            card.interval_days = 0
        elif days > 0:
            card.interval_days = days
    card.reps += 1
    card.last_result = rating if rating != "custom" else "good"
    card.last_reviewed = now
    card.updated_at = now
    card.due_at = now + (datetime.timedelta(days=days) if days > 0 else datetime.timedelta(minutes=RELEARN_MINUTES))
    return days


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def first_line(md: str, limit: int = 90) -> str:
    s = re.sub(r"```.*?```", " [code] ", md, flags=re.S)
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", " [image] ", s)
    s = re.sub(r"[`*_#>]", "", s)
    s = " ".join(s.split())
    return s[:limit] + ("…" if len(s) > limit else "")


def card_out(c: Card, with_content=True):
    now = utcnow()
    delta = c.due_at - now
    d = {
        "id": c.id,
        "tags": [t for t in c.tags.split(",") if t],
        "due_at": c.due_at.isoformat() + "Z",
        "due": c.due_at <= now,
        "days_until_due": 0 if c.due_at <= now else max(1, delta.days + (1 if delta.seconds else 0)),
        "interval_days": c.interval_days,
        "ease": round(c.ease or EASE_START, 2),
        "reps": c.reps,
        "lapses": c.lapses,
        "learning": is_learning(c),
        "last_result": c.last_result,
        "last_reviewed": c.last_reviewed.isoformat() + "Z" if c.last_reviewed else None,
        "created_at": c.created_at.isoformat() + "Z",
        "updated_at": c.updated_at.isoformat() + "Z",
        "preview": preview_intervals(c),
    }
    if with_content:
        d["question"] = c.question
        d["answer"] = c.answer
    else:
        d["preview_text"] = first_line(c.question)
    return d


def query_cards(db: Session, q: str = "", tag: str = "", due_only=False, forgotten=False):
    query = db.query(Card)
    if forgotten:
        query = query.filter(Card.last_result == "again")
    q, tag = q.strip(), tag.strip().lower()
    if q:
        like = f"%{q}%"
        query = query.filter(or_(Card.question.like(like), Card.answer.like(like), Card.tags.like(like)))
    if tag:
        query = query.filter((literal(",") + Card.tags + literal(",")).like(f"%,{tag},%"))
    if due_only:
        query = query.filter(Card.due_at <= utcnow())
    return query.order_by(Card.due_at.asc(), Card.id.asc()).all()


def card_tag_counts(db: Session):
    counts = {}
    for (tags,) in db.query(Card.tags).filter(Card.tags != "").all():
        for t in tags.split(","):
            counts[t] = counts.get(t, 0) + 1
    return sorted(({"tag": k, "count": v} for k, v in counts.items()), key=lambda x: (-x["count"], x["tag"]))


def stats(db: Session):
    now = utcnow()
    start_today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return {
        "total": db.query(Card).count(),
        "due": db.query(Card).filter(Card.due_at <= now).count(),
        "due_tomorrow": db.query(Card).filter(Card.due_at > now, Card.due_at <= now + datetime.timedelta(days=1)).count(),
        "new": db.query(Card).filter(Card.reps == 0).count(),
        "forgotten": db.query(Card).filter(Card.last_result == "again").count(),
        "reviewed_today": db.query(Review).filter(Review.reviewed_at >= start_today).count(),
        "again_today": db.query(Review).filter(Review.reviewed_at >= start_today, Review.result == "again").count(),
    }


def fmt(dt: datetime.datetime) -> str:
    return dt.strftime("%d %b %Y")


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #

class CardIn(BaseModel):
    question: Optional[str] = None
    answer: Optional[str] = None
    tags: Optional[object] = None
    due_in_days: Optional[int] = None


class ReviewIn(BaseModel):
    rating: str                     # again | hard | good | easy | custom
    days: Optional[int] = None      # required for custom


@router.get("/api/cards")
def list_cards(q: str = "", tag: str = "", due: int = 0, db: Session = Depends(get_db)):
    return [card_out(c, with_content=False) for c in query_cards(db, q, tag, bool(due))]


@router.get("/api/cards/due")
def due_cards(tag: str = "", all: int = 0, forgotten: int = 0, limit: int = 200, db: Session = Depends(get_db)):
    """Session queue. Lapsed (relearning) cards come first, like Anki's learning queue."""
    cards = query_cards(db, "", tag, due_only=not (all or forgotten), forgotten=bool(forgotten))[:limit]
    cards.sort(key=lambda c: (0 if c.last_result == "again" else 1, c.due_at, c.id))
    return [card_out(c) for c in cards]


@router.get("/api/quiz/stats")
def quiz_stats(db: Session = Depends(get_db)):
    return stats(db)


@router.get("/api/quiz/tags")
def quiz_tags(db: Session = Depends(get_db)):
    return card_tag_counts(db)


@router.post("/api/cards", status_code=201)
def create_card(body: CardIn, db: Session = Depends(get_db)):
    if not (body.question or "").strip():
        raise HTTPException(400, "question is required")
    c = Card(question=body.question.strip(), answer=(body.answer or "").strip(), tags=norm_tags(body.tags))
    if body.due_in_days:
        c.due_at = utcnow() + datetime.timedelta(days=max(0, body.due_in_days))
    db.add(c)
    db.commit()
    db.refresh(c)
    return card_out(c)


@router.get("/api/cards/{card_id}")
def get_card(card_id: int, db: Session = Depends(get_db)):
    c = db.get(Card, card_id)
    if c is None:
        raise HTTPException(404, "card not found")
    d = card_out(c)
    d["history"] = [
        {"result": r.result, "interval_days": r.interval_days, "reviewed_at": r.reviewed_at.isoformat() + "Z"}
        for r in db.query(Review).filter(Review.card_id == card_id).order_by(Review.reviewed_at.desc()).limit(50)
    ]
    return d


@router.put("/api/cards/{card_id}")
def update_card(card_id: int, body: CardIn, db: Session = Depends(get_db)):
    c = db.get(Card, card_id)
    if c is None:
        raise HTTPException(404, "card not found")
    if body.question is not None:
        if not body.question.strip():
            raise HTTPException(400, "question is required")
        c.question = body.question.strip()
    if body.answer is not None:
        c.answer = body.answer.strip()
    if body.tags is not None:
        c.tags = norm_tags(body.tags)
    if body.due_in_days is not None:
        c.due_at = utcnow() + datetime.timedelta(days=max(0, body.due_in_days))
    c.updated_at = utcnow()
    db.commit()
    db.refresh(c)
    return card_out(c)


@router.delete("/api/cards/{card_id}")
def delete_card(card_id: int, db: Session = Depends(get_db)):
    c = db.get(Card, card_id)
    if c is None:
        raise HTTPException(404, "card not found")
    db.delete(c)
    db.query(Review).filter(Review.card_id == card_id).delete()
    db.commit()
    return {"deleted": card_id}


@router.post("/api/cards/{card_id}/review")
def review_card(card_id: int, body: ReviewIn, db: Session = Depends(get_db)):
    c = db.get(Card, card_id)
    if c is None:
        raise HTTPException(404, "card not found")
    if body.rating not in RATINGS:
        raise HTTPException(400, f"rating must be one of {RATINGS}")
    if body.rating == "custom" and body.days is None:
        raise HTTPException(400, "days is required for a custom rating")
    days = apply_rating(c, body.rating, body.days)
    db.add(Review(card_id=c.id, result=body.rating, interval_days=days, reviewed_at=c.last_reviewed))
    db.commit()
    db.refresh(c)
    out = card_out(c)
    out["scheduled_days"] = days
    return out


@router.post("/api/cards/{card_id}/reset")
def reset_card(card_id: int, db: Session = Depends(get_db)):
    c = db.get(Card, card_id)
    if c is None:
        raise HTTPException(404, "card not found")
    c.due_at = utcnow()
    c.interval_days = 0
    c.ease = EASE_START
    c.last_result = None
    c.updated_at = utcnow()
    db.commit()
    return card_out(c)


# --------------------------------------------------------------------------- #
# Pages
# --------------------------------------------------------------------------- #

@router.get("/quiz", response_class=HTMLResponse)
def quiz_home(request: Request, db: Session = Depends(get_db)):
    return render(request, "quiz_home.html", stats=stats(db), tags=card_tag_counts(db))


@router.get("/quiz/review", response_class=HTMLResponse)
def quiz_review(request: Request, tag: str = "", all: int = 0, forgotten: int = 0):
    mode = "forgotten cards" if forgotten else ("all cards" if all else "due cards")
    return render(request, "quiz_review.html", tag=tag, all=bool(all), forgotten=bool(forgotten), mode=mode)


@router.get("/quiz/cards", response_class=HTMLResponse)
def quiz_cards(request: Request, q: str = "", tag: str = "", due: int = 0, db: Session = Depends(get_db)):
    items = []
    for c in query_cards(db, q, tag, bool(due)):
        d = card_out(c, with_content=False)
        d["preview"] = d.pop("preview_text")
        n = d["days_until_due"]
        d["due_display"] = "due now" if d["due"] else f"in {n} day{'s' if n != 1 else ''}"
        items.append(d)
    return render(request, "quiz_cards.html", cards=items, tags=card_tag_counts(db), q=q,
                  active_tag=tag.lower(), due_only=bool(due))


@router.get("/quiz/cards/new", response_class=HTMLResponse)
def quiz_card_new(request: Request):
    return render(request, "quiz_card_editor.html", card=None, mode="create")


@router.get("/quiz/cards/{card_id}", response_class=HTMLResponse)
def quiz_card_detail(request: Request, card_id: int, db: Session = Depends(get_db)):
    c = db.get(Card, card_id)
    if c is None:
        raise HTTPException(404, "card not found")
    d = card_out(c)
    d["due_display"] = "due now" if d["due"] else fmt(c.due_at)
    d["history"] = [
        {"result": r.result, "interval_days": r.interval_days, "reviewed_at": r.reviewed_at.strftime("%d %b %Y, %H:%M")}
        for r in db.query(Review).filter(Review.card_id == card_id).order_by(Review.reviewed_at.desc()).limit(20)
    ]
    return render(request, "quiz_card_detail.html", card=d)


@router.get("/quiz/cards/{card_id}/edit", response_class=HTMLResponse)
def quiz_card_edit(request: Request, card_id: int, db: Session = Depends(get_db)):
    c = db.get(Card, card_id)
    if c is None:
        raise HTTPException(404, "card not found")
    return render(request, "quiz_card_editor.html", card=card_out(c), mode="edit")
