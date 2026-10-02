/* Anki-style review: question -> Show answer -> Again / Hard / Good / Easy (or custom days). */
(function () {
  'use strict';
  var N = window.Notes;
  var $ = function (id) { return document.getElementById(id); };
  var cfg = JSON.parse($('review-config').textContent);

  var queue = [], index = 0, current = null, revealed = false, submitting = false;
  var seen = {};                       // id -> true once rated at least once this session
  var counts = { again: 0, hard: 0, good: 0, easy: 0, custom: 0 };
  var RELEARN_GAP = 2;                 // a card rated Again/Hard-in-learning returns after this many cards

  var qEl = $('question'), aEl = $('answer');
  N.bindMarkdownContainer(qEl); N.bindMarkdownContainer(aEl);

  function ivlText(days) { return days === 0 ? '<10m' : days + 'd'; }

  function load() {
    var url = '/api/cards/due?all=' + (cfg.all ? 1 : 0) + (cfg.forgotten ? '&forgotten=1' : '') +
              (cfg.tag ? '&tag=' + encodeURIComponent(cfg.tag) : '');
    N.api('GET', url).then(function (cards) {
      queue = cards; index = 0;
      $('loading').hidden = true;
      if (!queue.length) return finish();
      show();
    }).catch(function (e) { $('loading').textContent = 'Could not load cards: ' + e.message; });
  }

  function updateCounts() {
    var remaining = queue.length - index;
    $('counts').innerHTML =
      '<span class="c-again" title="again">' + counts.again + '</span> · ' +
      '<span class="c-good" title="hard/good/easy/custom">' + (counts.hard + counts.good + counts.easy + counts.custom) + '</span> · ' +
      '<span class="muted" title="remaining">' + remaining + ' left</span>';
  }

  function show() {
    current = queue[index]; revealed = false;
    $('progress').textContent = (index + 1) + ' / ' + queue.length;
    updateCounts();
    $('card-tags').innerHTML = current.tags.map(function (t) { return '<span class="tag">' + N.esc(t) + '</span>'; }).join('');
    $('card-info').textContent = current.reps
      ? ('interval ' + current.interval_days + 'd · ease ' + Math.round(current.ease * 100) + '% · ' + current.reps + ' reviews')
      : 'new card';
    $('relearn-badge').hidden = !(current.learning && current.reps > 0);
    $('card-edit').href = '/quiz/cards/' + current.id + '/edit';
    N.renderMarkdown(qEl, current.question);
    N.renderMarkdown(aEl, current.answer || '_No answer written._');
    ['again', 'hard', 'good', 'easy'].forEach(function (r) { $('ivl-' + r).textContent = ivlText(current.preview[r]); });
    $('custom-days').value = '';
    $('front').hidden = false;
    $('back').hidden = true;
    $('card').hidden = false;
    $('done').hidden = true;
    window.scrollTo(0, 0);
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    $('front').hidden = true;
    $('back').hidden = false;
  }

  function rate(rating, days) {
    if (!revealed || submitting) return;
    submitting = true;
    var body = { rating: rating };
    if (rating === 'custom') body.days = days;
    N.api('POST', '/api/cards/' + current.id + '/review', body).then(function (updated) {
      if (!seen[current.id]) counts[rating] += 1;      // count each card once, by its first rating
      seen[current.id] = true;
      if (updated.scheduled_days === 0) {
        // Anki learning step: the card comes back a few cards later, until it graduates
        queue.splice(Math.min(queue.length, index + 1 + RELEARN_GAP), 0, updated);
      }
      index += 1;
      if (index >= queue.length) finish(); else show();
    }).catch(function (e) { N.toast('Could not save: ' + e.message, true); })
      .finally(function () { submitting = false; });
  }

  function finish() {
    $('card').hidden = true;
    $('done').hidden = false;
    var total = Object.keys(seen).length;
    if (!total) {
      $('done-title').textContent = cfg.forgotten ? 'Nothing to relearn' : cfg.all ? 'No cards yet' : 'Nothing due';
      $('done-summary').textContent = cfg.forgotten ? 'No card was rated Again last time.' : cfg.all ? 'Create a card to start.' : 'Come back when cards are due, or practice all cards now.';
    } else {
      $('done-title').textContent = 'Session complete';
      $('done-summary').textContent = total + ' card' + (total === 1 ? '' : 's') + ' · Again ' + counts.again +
        ' · Hard ' + counts.hard + ' · Good ' + counts.good + ' · Easy ' + counts.easy + (counts.custom ? ' · Custom ' + counts.custom : '');
    }
    $('progress').textContent = 'Done';
    updateCounts();
  }

  // ------------------------------------------------------------ events
  $('btn-reveal').addEventListener('click', reveal);
  document.querySelectorAll('.anki').forEach(function (b) {
    b.addEventListener('click', function () { rate(b.dataset.rating); });
  });
  $('custom-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var d = parseInt($('custom-days').value, 10);
    if (!d || d < 1) { N.toast('Enter a number of days (1 or more)', true); return; }
    rate('custom', d);
  });
  document.addEventListener('keydown', function (e) {
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (!revealed) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); reveal(); }
      return;
    }
    var map = { '1': 'again', '2': 'hard', '3': 'good', '4': 'easy' };
    if (map[e.key]) { e.preventDefault(); rate(map[e.key]); }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); rate('good'); }   // Anki: space = Good
  });

  load();
})();
