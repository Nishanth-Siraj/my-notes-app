/* Anki reviewer: question -> Show Answer -> Again/Hard/Good/Easy. More menu: Set Due Date, Card Info, Reset, Delete. */
(function () {
  'use strict';
  var N = window.Notes;
  var $ = function (id) { return document.getElementById(id); };
  var cfg = JSON.parse($('review-config').textContent);

  var queue = [], index = 0, current = null, revealed = false, busy = false;
  var seen = {}, counts = { again: 0, hard: 0, good: 0, easy: 0 };
  var RELEARN_GAP = 2;
  var PRACTICE = !!(cfg.all || cfg.forgotten);

  var qEl = $('question'), aEl = $('answer');
  N.bindMarkdownContainer(qEl); N.bindMarkdownContainer(aEl);

  function ivl(days) { return days === 0 ? '<10m' : days + 'd'; }

  function load() {
    var p = ['all=' + (cfg.all ? 1 : 0)];
    if (cfg.deck) p.push('deck=' + encodeURIComponent(cfg.deck));
    if (cfg.tag) p.push('tag=' + encodeURIComponent(cfg.tag));
    if (cfg.forgotten) p.push('forgotten=1');
    N.api('GET', '/api/cards/due?' + p.join('&')).then(function (cards) {
      queue = cards; index = 0;
      $('loading').hidden = true;
      if (!queue.length) return finish();
      show();
    }).catch(function (e) { $('loading').textContent = 'Could not load cards: ' + e.message; });
  }

  // Anki bottom-bar counts: remaining new + learning + review in this session
  function updateCounts() {
    var n = 0, l = 0, r = 0;
    for (var i = index; i < queue.length; i++) {
      var c = queue[i];
      if (c.reps === 0) n++; else if (c.learning) l++; else r++;
    }
    $('counts').innerHTML = '<span class="new">' + n + '</span> + <span class="learn">' + l + '</span> + <span class="review">' + r + '</span>';
    var total = queue.length, pos = Math.min(index + 1, total);
    $('progress').style.width = (total ? 100 * pos / total : 0) + '%';
    $('progress-txt').textContent = pos + ' / ' + total;
    $('btn-prev').disabled = index === 0;
    $('btn-next').disabled = !(queue[index] && queue[index]._rated);
  }

  function paintRated() {
    var r = current && current._rated;
    document.querySelectorAll('#answer-buttons [data-rating]').forEach(function (b) {
      b.classList.toggle('picked', b.dataset.rating === r);
      b.disabled = !!r;
    });
    $('answer-buttons').classList.toggle('locked', !!r);
  }

  function isMarked() { return current && (current.tags || []).indexOf('marked') !== -1; }
  function paintStar() { $('btn-star').classList.toggle('on', !!isMarked()); }

  function show() {
    current = queue[index]; revealed = false;
    N.renderMarkdown(qEl, current.question);
    N.renderMarkdown(aEl, current.answer || '_(empty)_');
    $('answer').hidden = true; $('answer-sep').hidden = true;
    $('btn-show').hidden = false; $('answer-buttons').hidden = true; $('hint').hidden = false;
    paintStar();
    if (current._rated) { revealed = false; showAnswer(); }
    paintRated();
    ['again', 'hard', 'good', 'easy'].forEach(function (r) { $('ivl-' + r).textContent = ivl(current.preview[r]); });
    $('btn-edit').href = '/quiz/cards/' + current.id + '/edit';
    $('card').hidden = false; $('done').hidden = true;
    $('more').removeAttribute('open');
    updateCounts();
    window.scrollTo(0, 0);
  }

  function showAnswer() {
    if (revealed || !current) return;
    revealed = true;
    $('answer').hidden = false; $('answer-sep').hidden = false;
    $('btn-show').hidden = true; $('answer-buttons').hidden = false; $('hint').hidden = true;
  }

  function go(delta) {
    var i = index + delta;
    if (i < 0 || i >= queue.length) return;
    index = i; show();
  }
  $('btn-prev').addEventListener('click', function () { go(-1); });
  function next() {
    if (!current || !current._rated) return;
    if (index + 1 >= queue.length) finish(); else go(1);
  }
  $('btn-next').addEventListener('click', next);
  $('btn-star').addEventListener('click', function () {
    if (!current) return;
    var tags = (current.tags || []).filter(function (t) { return t !== 'marked'; });
    if (!isMarked()) tags.push('marked');
    var c = current;
    N.api('PUT', '/api/cards/' + c.id, { tags: tags }).then(function (u) {
      c.tags = u.tags; if (c === current) paintStar();
      N.toast(isMarked() ? 'Card marked' : 'Mark removed');
    }).catch(function (e) { N.toast(e.message, true); });
  });

  function rate(rating, days) {
    if (!revealed || busy || !current || current._rated) return;
    if (PRACTICE) {
      if (!seen[current.id] && counts[rating] !== undefined) counts[rating] += 1;
      seen[current.id] = true;
      current._rated = rating;
      paintRated(); updateCounts();
      return;
    }
    busy = true;
    var body = { rating: rating }; if (rating === 'custom') body.days = days;
    N.api('POST', '/api/cards/' + current.id + '/review', body).then(function (updated) {
      if (!seen[current.id] && counts[rating] !== undefined) counts[rating] += 1;
      seen[current.id] = true;
      if (updated.scheduled_days === 0) queue.splice(Math.min(queue.length, index + 1 + RELEARN_GAP), 0, updated);
      current._rated = rating;
      paintRated(); updateCounts();
    }).catch(function (e) { N.toast('Could not save: ' + e.message, true); })
      .finally(function () { busy = false; });
  }

  function finish() {
    $('card').hidden = true; $('done').hidden = false;
    $('btn-show').hidden = true; $('answer-buttons').hidden = true;
    var total = Object.keys(seen).length;
    $('done-summary').textContent = total
      ? ('Studied ' + total + ' card' + (total === 1 ? '' : 's') + ' · Again ' + counts.again + ' · Hard ' + counts.hard + ' · Good ' + counts.good + ' · Easy ' + counts.easy)
      : (cfg.forgotten ? 'No cards were rated Again recently.' : (cfg.all ? 'This deck has no cards.' : ''));
    updateCounts();
    $('btn-prev').disabled = true; $('btn-next').disabled = true;
  }

  // ---------------- More menu
  function setDueDate() {
    if (!current || current._rated) return;
    var v = prompt('Show in how many days? (0 = today)', '1'); if (v === null) return;
    var d = parseInt(v, 10); if (isNaN(d) || d < 0) { N.toast('Enter a number of days', true); return; }
    $('more').removeAttribute('open');
    if (!revealed) revealed = true;         // Anki lets you set a due date without answering
    rate('custom', d);
  }
  $('m-due').addEventListener('click', setDueDate);
  $('btn-custom').addEventListener('click', setDueDate);
  $('m-info').addEventListener('click', function () { if (current) location.href = '/quiz/cards/' + current.id; });
  $('m-deck').addEventListener('click', function () {
    if (!current) return;
    var v = prompt('Move this card to deck:', current.deck); if (v === null || !v.trim()) return;
    N.api('PUT', '/api/cards/' + current.id, { deck: v.trim() }).then(function (u) { current.deck = u.deck; N.toast('Moved to ' + u.deck); $('more').removeAttribute('open'); })
      .catch(function (e) { N.toast(e.message, true); });
  });
  $('m-reset').addEventListener('click', function () {
    if (!current || !confirm('Reset this card to new?')) return;
    N.api('POST', '/api/cards/' + current.id + '/reset').then(function () { N.toast('Card reset'); $('more').removeAttribute('open'); });
  });
  $('m-delete').addEventListener('click', function () {
    if (!current || !confirm('Delete this card?')) return;
    N.api('DELETE', '/api/cards/' + current.id).then(function () {
      queue.splice(index, 1); N.toast('Card deleted');
      if (index >= queue.length) finish(); else show();
    });
  });
  document.addEventListener('click', function (e) {
    var m = $('more'); if (m.open && !m.contains(e.target)) m.removeAttribute('open');
  });

  // ---------------- events
  $('btn-show').addEventListener('click', showAnswer);
  document.querySelectorAll('.answer-buttons [data-rating]').forEach(function (b) {
    b.addEventListener('click', function () { rate(b.dataset.rating); });
  });
  document.addEventListener('keydown', function (e) {
    var t = document.activeElement && document.activeElement.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA') return;
    if (e.key === 'd' || e.key === 'D') { e.preventDefault(); setDueDate(); return; }
    if (e.key === 'i' || e.key === 'I') { if (current) location.href = '/quiz/cards/' + current.id; return; }
    if (e.key === 'e' || e.key === 'E') { if (current) location.href = '/quiz/cards/' + current.id + '/edit'; return; }
    if (!revealed) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); showAnswer(); } return; }
    var map = { '1': 'again', '2': 'hard', '3': 'good', '4': 'easy' };
    if (map[e.key]) { e.preventDefault(); rate(map[e.key]); }
    else if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); if (current && current._rated) next(); else if (e.key !== 'ArrowRight') rate('good'); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  });

  // On phones the More menu lives in the top bar and opens downward
  var mq = window.matchMedia('(max-width: 768px)'), more = $('more'), moreHome = more.parentNode;
  function placeMore() {
    if (mq.matches) { $('top-actions').appendChild(more); more.classList.remove('up'); }
    else { moreHome.appendChild(more); more.classList.add('up'); }
  }
  placeMore();
  if (mq.addEventListener) mq.addEventListener('change', placeMore);

  load();
})();
