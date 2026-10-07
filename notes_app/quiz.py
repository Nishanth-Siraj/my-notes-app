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

from notes_core import Base, get_db, norm_tags, render, require_login, utcnow  # alias set by app.py

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

DEFAULT_DECK = "Default"


class Deck(Base):
    __tablename__ = "decks"
    id = Column(Integer, primary_key=True)
    name = Column(String(200), nullable=False, unique=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)


class Card(Base):
    __tablename__ = "cards"
    id = Column(Integer, primary_key=True)
    deck = Column(String(200), nullable=False, default=DEFAULT_DECK, index=True)
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
        if "deck" not in cols:
            conn.execute(text(f"ALTER TABLE cards ADD COLUMN deck VARCHAR(200) NOT NULL DEFAULT '{DEFAULT_DECK}'"))
        if not conn.execute(text("SELECT 1 FROM decks WHERE name = :n"), {"n": DEFAULT_DECK}).first():
            conn.execute(text("INSERT INTO decks (name, created_at) VALUES (:n, :t)"), {"n": DEFAULT_DECK, "t": utcnow()})
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
    if days > 0:
        # Schedule to midnight UTC on the target date, not 24h from now.
        # This matches Anki: "1 day" means "available first thing tomorrow."
        target_date = (now + datetime.timedelta(days=days)).date()
        card.due_at = datetime.datetime(target_date.year, target_date.month, target_date.day, 0, 0, 0)
    else:
        card.due_at = now + datetime.timedelta(minutes=RELEARN_MINUTES)
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
        "deck": c.deck or DEFAULT_DECK,
        "queue": "new" if c.reps == 0 else ("learn" if is_learning(c) else "review"),
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


def norm_deck(name) -> str:
    name = " ".join(str(name or "").split())
    return name or DEFAULT_DECK


def query_cards(db: Session, q: str = "", tag: str = "", due_only=False, forgotten=False, deck: str = ""):
    query = db.query(Card)
    if deck:
        query = query.filter(Card.deck == deck)
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


def deck_counts(db: Session):
    """Anki deck list numbers. new: never studied & due; learn: (re)learning & due; due: review cards due."""
    now = utcnow()
    names = {d.name for d in db.query(Deck).all()} | {c[0] for c in db.query(Card.deck).distinct().all() if c[0]}
    names.add(DEFAULT_DECK)
    rows = {n: {"name": n, "new": 0, "learn": 0, "due": 0, "total": 0} for n in names}
    for c in db.query(Card).all():
        r = rows.setdefault(c.deck or DEFAULT_DECK, {"name": c.deck, "new": 0, "learn": 0, "due": 0, "total": 0})
        r["total"] += 1
        if c.due_at <= now:
            if c.reps == 0:
                r["new"] += 1
            elif is_learning(c):
                r["learn"] += 1
            else:
                r["due"] += 1
    return sorted(rows.values(), key=lambda r: (r["name"] != DEFAULT_DECK, r["name"].lower()))


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
    deck: Optional[str] = None
    due_in_days: Optional[int] = None


class DeckIn(BaseModel):
    name: str


class ReviewIn(BaseModel):
    rating: str                     # again | hard | good | easy | custom
    days: Optional[int] = None      # required for custom


@router.get("/api/cards")
def list_cards(q: str = "", tag: str = "", due: int = 0, deck: str = "", db: Session = Depends(get_db)):
    return [card_out(c, with_content=False) for c in query_cards(db, q, tag, bool(due), deck=deck)]


@router.get("/api/decks")
def list_decks(db: Session = Depends(get_db)):
    return deck_counts(db)


@router.post("/api/decks", status_code=201)
def create_deck(body: DeckIn, db: Session = Depends(get_db)):
    name = norm_deck(body.name)
    if db.query(Deck).filter(Deck.name == name).first():
        raise HTTPException(409, "deck already exists")
    db.add(Deck(name=name))
    db.commit()
    return {"name": name}


@router.delete("/api/decks/{name}")
def delete_deck(name: str, db: Session = Depends(get_db)):
    """Anki deletes the cards with the deck. The Default deck cannot be deleted."""
    if name == DEFAULT_DECK:
        raise HTTPException(400, "the Default deck cannot be deleted")
    ids = [c.id for c in db.query(Card).filter(Card.deck == name).all()]
    if ids:
        db.query(Review).filter(Review.card_id.in_(ids)).delete(synchronize_session=False)
        db.query(Card).filter(Card.deck == name).delete(synchronize_session=False)
    db.query(Deck).filter(Deck.name == name).delete(synchronize_session=False)
    db.commit()
    return {"deleted": name, "cards": len(ids)}


@router.get("/api/cards/due")
def due_cards(tag: str = "", deck: str = "", all: int = 0, forgotten: int = 0, limit: int = 200,
              db: Session = Depends(get_db)):
    """Study queue in Anki's order: learning cards, then due reviews, then new cards."""
    cards = query_cards(db, "", tag, due_only=not (all or forgotten), forgotten=bool(forgotten), deck=deck)[:limit]
    def order(c):
        if c.reps > 0 and is_learning(c):
            return (0, c.due_at, c.id)
        if c.reps > 0:
            return (1, c.due_at, c.id)
        return (2, c.id, c.id)
    cards.sort(key=order)
    return [card_out(c) for c in cards]


@router.get("/api/quiz/stats")
def quiz_stats(db: Session = Depends(get_db)):
    return stats(db)


@router.get("/api/quiz/heatmap")
def heatmap(days: int = 365, tz: int = 0, db: Session = Depends(get_db)):
    """
    Reviews per calendar day for the heatmap, plus streaks. `tz` is the browser's
    timezone offset in minutes as JS reports it (IST = -330), so days are local days.
    """
    days = max(7, min(730, days))
    shift = datetime.timedelta(minutes=-tz)
    now_local = utcnow() + shift
    today = now_local.date()
    start_local = datetime.datetime.combine(today - datetime.timedelta(days=days - 1), datetime.time.min)
    rows = db.query(Review.reviewed_at).filter(Review.reviewed_at >= start_local - shift).all()
    per_day = {}
    for (ts,) in rows:
        d = (ts + shift).date().isoformat()
        per_day[d] = per_day.get(d, 0) + 1
    # streaks over the whole history (not just the window)
    all_days = sorted({(ts + shift).date() for (ts,) in db.query(Review.reviewed_at).all()})
    longest = cur = 0
    prev = None
    for d in all_days:
        cur = cur + 1 if prev is not None and (d - prev).days == 1 else 1
        longest = max(longest, cur)
        prev = d
    current = 0
    if all_days:
        d = today if today in set(all_days) else today - datetime.timedelta(days=1)
        s_all = set(all_days)
        while d in s_all:
            current += 1
            d -= datetime.timedelta(days=1)
    total_in_window = sum(per_day.values())
    active = len(per_day)
    return {
        "start": start_local.date().isoformat(), "end": today.isoformat(), "days": per_day,
        "streak_current": current, "streak_longest": longest,
        "days_learned": active, "days_learned_pct": round(100 * active / days),
        "total": total_in_window, "avg_active_day": round(total_in_window / active, 1) if active else 0,
        "avg_day": round(total_in_window / days, 1),
    }


@router.get("/api/quiz/future")
def future_due(days: int = 30, tz: int = 0, db: Session = Depends(get_db)):
    """Cards becoming due per local day for the next N days (overdue counted on day 0)."""
    days = max(7, min(365, days))
    shift = datetime.timedelta(minutes=-tz)
    today = (utcnow() + shift).date()
    buckets = [0] * days
    for (due,) in db.query(Card.due_at).all():
        offset = ((due + shift).date() - today).days
        if offset < 0:
            offset = 0
        if offset < days:
            buckets[offset] += 1
    return {"start": today.isoformat(), "counts": buckets}


@router.get("/api/quiz/tags")
def quiz_tags(db: Session = Depends(get_db)):
    return card_tag_counts(db)


@router.post("/api/cards", status_code=201)
def create_card(body: CardIn, db: Session = Depends(get_db)):
    if not (body.question or "").strip():
        raise HTTPException(400, "question is required")
    c = Card(question=body.question.strip(), answer=(body.answer or "").strip(), tags=norm_tags(body.tags),
             deck=norm_deck(body.deck))
    if not db.query(Deck).filter(Deck.name == c.deck).first():
        db.add(Deck(name=c.deck))
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
    if body.deck is not None:
        c.deck = norm_deck(body.deck)
        if not db.query(Deck).filter(Deck.name == c.deck).first():
            db.add(Deck(name=c.deck))
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
# Pages (Anki screens: Decks, Overview, Reviewer, Add, Browse, Card Info)
# --------------------------------------------------------------------------- #

@router.get("/quiz", response_class=HTMLResponse)
def decks_page(request: Request, db: Session = Depends(get_db)):
    return render(request, "anki_decks.html", decks=deck_counts(db), stats=stats(db), nav="quiz")


@router.get("/quiz/stats", response_class=HTMLResponse)
def stats_page(request: Request, db: Session = Depends(get_db)):
    now = utcnow()
    counts = {
        "new": db.query(Card).filter(Card.reps == 0).count(),
        "learning": db.query(Card).filter(Card.reps > 0, Card.last_result == "again").count(),
        "young": db.query(Card).filter(Card.reps > 0, Card.last_result != "again", Card.interval_days < 21).count(),
        "mature": db.query(Card).filter(Card.reps > 0, Card.last_result != "again", Card.interval_days >= 21).count(),
        "total": db.query(Card).count(),
        "reviews_total": db.query(Review).count(),
    }
    total_due = sum(d["due"] + d["learn"] for d in deck_counts(db))
    return render(request, "anki_stats.html", counts=counts, total_due=total_due, nav="quiz")


@router.get("/quiz/deck/{name}", response_class=HTMLResponse)
def overview_page(request: Request, name: str, db: Session = Depends(get_db)):
    row = next((d for d in deck_counts(db) if d["name"] == name), None)
    if row is None:
        raise HTTPException(404, "deck not found")
    cards = db.query(Card).filter(Card.deck == name).order_by(Card.due_at.asc()).all()
    cards_out = [card_out(c) for c in cards]
    return render(request, "anki_overview.html", deck=row, cards=cards_out, decks=[d["name"] for d in deck_counts(db)], nav="quiz")


@router.get("/quiz/review", response_class=HTMLResponse)
def review_page(request: Request, deck: str = "", tag: str = "", all: int = 0, forgotten: int = 0):
    return render(request, "anki_review.html", deck=deck, tag=tag, all=bool(all), forgotten=bool(forgotten), nav="quiz")


@router.get("/quiz/add", response_class=HTMLResponse)
def add_page(request: Request, deck: str = "", db: Session = Depends(get_db)):
    decks = [d["name"] for d in deck_counts(db)]
    return render(request, "anki_add.html", card=None, mode="add", decks=decks, deck=deck or DEFAULT_DECK, nav="quiz")


@router.get("/quiz/cards/new")
def add_redirect(deck: str = ""):
    from fastapi.responses import RedirectResponse
    return RedirectResponse("/quiz/add" + (f"?deck={deck}" if deck else ""), status_code=303)


@router.get("/quiz/browse", response_class=HTMLResponse)
def browse_page(request: Request, q: str = "", deck: str = "", tag: str = "", due: int = 0, db: Session = Depends(get_db)):
    items = []
    now = utcnow()
    for c in query_cards(db, q, tag, bool(due), deck=deck):
        d = card_out(c, with_content=False)
        d["sort_field"] = d.pop("preview_text")
        d["due_display"] = ("new" if c.reps == 0 else "learning") if (c.reps == 0 or is_learning(c)) and c.due_at <= now \
            else ("now" if c.due_at <= now else fmt(c.due_at))
        items.append(d)
    decks = [d["name"] for d in deck_counts(db)]
    return render(request, "anki_browse.html", cards=items, decks=decks, q=q, deck=deck, tag=tag, due_only=bool(due), nav="quiz")


@router.get("/quiz/cards")
def browse_redirect(q: str = "", tag: str = "", due: int = 0):
    from fastapi.responses import RedirectResponse
    qs = "&".join(p for p in [f"q={q}" if q else "", f"tag={tag}" if tag else "", "due=1" if due else ""] if p)
    return RedirectResponse("/quiz/browse" + (f"?{qs}" if qs else ""), status_code=303)


@router.get("/quiz/cards/{card_id}", response_class=HTMLResponse)
def card_info_page(request: Request, card_id: int, db: Session = Depends(get_db)):
    c = db.get(Card, card_id)
    if c is None:
        raise HTTPException(404, "card not found")
    d = card_out(c)
    d["due_display"] = "now" if d["due"] else fmt(c.due_at)
    d["added_display"] = fmt(c.created_at)
    d["history"] = [
        {"result": r.result, "interval_days": r.interval_days, "reviewed_at": r.reviewed_at.strftime("%Y-%m-%d %H:%M")}
        for r in db.query(Review).filter(Review.card_id == card_id).order_by(Review.reviewed_at.desc()).limit(50)
    ]
    return render(request, "anki_card.html", card=d, nav="quiz")


@router.get("/quiz/cards/{card_id}/edit", response_class=HTMLResponse)
def edit_page(request: Request, card_id: int, db: Session = Depends(get_db)):
    c = db.get(Card, card_id)
    if c is None:
        raise HTTPException(404, "card not found")
    decks = [d["name"] for d in deck_counts(db)]
    return render(request, "anki_add.html", card=card_out(c), mode="edit", decks=decks, deck=c.deck, nav="quiz")
