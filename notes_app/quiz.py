"""
Quiz / flashcards (Anki-style spaced repetition), mounted by app.py.

Cards have a Markdown question and answer, so text, code blocks and images all
work. Reviewing a card schedules the next recall "in N days": presets or a
custom number, chosen separately for correct and wrong answers.
"""

import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy import Column, DateTime, Integer, String, Text, literal, or_
from sqlalchemy.orm import Session

from app import Base, get_db, norm_tags, render, require_login, utcnow

router = APIRouter(dependencies=[Depends(require_login)])

PRESETS_CORRECT = [1, 3, 7, 14, 30]
PRESETS_WRONG = [0, 1, 2, 3]


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
    reps = Column(Integer, nullable=False, default=0)
    lapses = Column(Integer, nullable=False, default=0)
    last_result = Column(String(10), nullable=True)
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


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def first_line(md: str, limit: int = 90) -> str:
    import re
    text = re.sub(r"```.*?```", " [code] ", md, flags=re.S)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " [image] ", text)
    text = re.sub(r"[`*_#>]", "", text)
    text = " ".join(text.split())
    return text[:limit] + ("…" if len(text) > limit else "")


EASE = 2.5          # Anki's default ease: interval grows x2.5 on each correct answer
FIRST_STEPS = [1, 3, 7]


def suggest_days(card: Card, result: str) -> int:
    """
    Recommended next interval, Anki-style:
      wrong                 -> 1 day (card is relearned in-session first)
      correct after a lapse -> stay short: the lapse interval (>= 1 day)
      correct, new card     -> 1 -> 3 -> 7 days for the first steps
      correct, mature card  -> previous interval x 2.5
    """
    if result == "wrong":
        return 1
    if card.last_result == "wrong":
        return max(1, card.interval_days)
    if card.interval_days < FIRST_STEPS[-1]:
        for step in FIRST_STEPS:
            if card.interval_days < step:
                return step
    return min(365, int(round(card.interval_days * EASE)))


def card_out(c: Card, with_content=True):
    now = utcnow()
    d = {
        "id": c.id,
        "tags": [t for t in c.tags.split(",") if t],
        "due_at": c.due_at.isoformat() + "Z",
        "due": c.due_at <= now,
        "days_until_due": max(0, (c.due_at - now).days + (1 if (c.due_at - now).seconds else 0)) if c.due_at > now else 0,
        "interval_days": c.interval_days,
        "reps": c.reps,
        "lapses": c.lapses,
        "last_result": c.last_result,
        "last_reviewed": c.last_reviewed.isoformat() + "Z" if c.last_reviewed else None,
        "created_at": c.created_at.isoformat() + "Z",
        "updated_at": c.updated_at.isoformat() + "Z",
        "suggest": {"correct": suggest_days(c, "correct"), "wrong": suggest_days(c, "wrong")},
    }
    if with_content:
        d["question"] = c.question
        d["answer"] = c.answer
    else:
        d["preview"] = first_line(c.question)
    return d


def query_cards(db: Session, q: str = "", tag: str = "", due_only: bool = False, forgotten: bool = False):
    query = db.query(Card)
    if forgotten:
        query = query.filter(Card.last_result == "wrong")
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
    return sorted(({"tag": k, "count": v} for k, v in counts.items()),
                  key=lambda x: (-x["count"], x["tag"]))


def stats(db: Session):
    now = utcnow()
    start_today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    total = db.query(Card).count()
    due = db.query(Card).filter(Card.due_at <= now).count()
    reviewed_today = db.query(Review).filter(Review.reviewed_at >= start_today).count()
    wrong_today = db.query(Review).filter(Review.reviewed_at >= start_today, Review.result == "wrong").count()
    due_tomorrow = db.query(Card).filter(Card.due_at > now, Card.due_at <= now + datetime.timedelta(days=1)).count()
    new = db.query(Card).filter(Card.reps == 0).count()
    forgotten = db.query(Card).filter(Card.last_result == "wrong").count()
    return {"total": total, "due": due, "due_tomorrow": due_tomorrow, "new": new,
            "forgotten": forgotten, "reviewed_today": reviewed_today, "wrong_today": wrong_today}


def fmt(dt: datetime.datetime) -> str:
    return dt.strftime("%d %b %Y")


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #

class CardIn(BaseModel):
    question: Optional[str] = None
    answer: Optional[str] = None
    tags: Optional[object] = None
    due_in_days: Optional[int] = None   # when creating/editing: recall on (days from now)


class ReviewIn(BaseModel):
    result: str                 # "correct" | "wrong"
    days: int                   # recall again in N days (0 = later today)


@router.get("/api/cards")
def list_cards(q: str = "", tag: str = "", due: int = 0, db: Session = Depends(get_db)):
    return [card_out(c, with_content=False) for c in query_cards(db, q, tag, bool(due))]


@router.get("/api/cards/due")
def due_cards(tag: str = "", all: int = 0, forgotten: int = 0, limit: int = 200, db: Session = Depends(get_db)):
    """Session queue. forgotten=1 -> only cards last answered wrong (regardless of due date).
    Forgotten cards are put first, like Anki's relearning queue."""
    cards = query_cards(db, "", tag, due_only=not (all or forgotten), forgotten=bool(forgotten))[:limit]
    cards.sort(key=lambda c: (0 if c.last_result == "wrong" else 1, c.due_at, c.id))
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
    if body.result not in ("correct", "wrong"):
        raise HTTPException(400, "result must be 'correct' or 'wrong'")
    days = max(0, min(3650, int(body.days)))
    now = utcnow()
    c.reps += 1
    if body.result == "wrong":
        c.lapses += 1
    c.interval_days = days
    c.last_result = body.result
    c.last_reviewed = now
    # 0 days = "again later today": push 10 minutes so it comes back at the end of the session
    c.due_at = now + (datetime.timedelta(days=days) if days > 0 else datetime.timedelta(minutes=10))
    c.updated_at = now
    db.add(Review(card_id=c.id, result=body.result, interval_days=days, reviewed_at=now))
    db.commit()
    db.refresh(c)
    return card_out(c)


@router.post("/api/cards/{card_id}/reset")
def reset_card(card_id: int, db: Session = Depends(get_db)):
    c = db.get(Card, card_id)
    if c is None:
        raise HTTPException(404, "card not found")
    c.due_at = utcnow()
    c.interval_days = 0
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
    return render(request, "quiz_review.html", tag=tag, all=bool(all), forgotten=bool(forgotten), mode=mode,
                  presets_correct=PRESETS_CORRECT, presets_wrong=PRESETS_WRONG)


@router.get("/quiz/cards", response_class=HTMLResponse)
def quiz_cards(request: Request, q: str = "", tag: str = "", due: int = 0, db: Session = Depends(get_db)):
    cards = query_cards(db, q, tag, bool(due))
    items = []
    for c in cards:
        d = card_out(c, with_content=False)
        d["due_display"] = "due now" if d["due"] else f"in {d['days_until_due']} day{'s' if d['days_until_due'] != 1 else ''}"
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
