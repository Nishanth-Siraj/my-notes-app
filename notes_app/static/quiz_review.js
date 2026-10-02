/* Review session: show question, reveal answer, grade, schedule next recall. */
(function () {
  'use strict';
  var N = window.Notes;
  var $ = function (id) { return document.getElementById(id); };
  var cfg = JSON.parse($('review-config').textContent);

  var queue = [], index = 0, current = null, revealed = false;
  var results = { correct: 0, wrong: 0, wrongIds: [] };
  var chosen = { wrong: 1, correct: 1 };
  var relearn = {};            // card id -> days chosen when it was answered wrong (Anki relearning step)
  var RELEARN_GAP = 2;         // a wrong card comes back after this many other cards

  var qEl = $('question'), aEl = $('answer');
  N.bindMarkdownContainer(qEl); N.bindMarkdownContainer(aEl);

  // ------------------------------------------------------------ chips
  function setupChips(kind) {
    var wrap = $('chips-' + kind), custom = $('custom-' + kind);
    wrap.querySelectorAll('.chip-btn').forEach(function (b) {
      b.addEventListener('click', function () { select(kind, parseInt(b.dataset.days, 10)); custom.value = ''; });
    });
    custom.addEventListener('input', function () {
      if (custom.value !== '') select(kind, parseInt(custom.value, 10), true);
    });
  }
  function select(kind, days, isCustom) {
    if (isNaN(days) || days < 0) days = 0;
    chosen[kind] = days;
    $('chips-' + kind).querySelectorAll('.chip-btn').forEach(function (b) {
      b.classList.toggle('active', !isCustom && parseInt(b.dataset.days, 10) === days);
    });
    var btn = $('btn-' + kind);
    btn.textContent = (kind === 'wrong' ? 'Wrong' : 'Correct') + ' · ' + (days === 0 ? 'again today' : days + ' day' + (days === 1 ? '' : 's'));
  }
  setupChips('wrong'); setupChips('correct');

  // ------------------------------------------------------------ flow
  function load() {
    var url = '/api/cards/due?all=' + (cfg.all ? 1 : 0) + (cfg.forgotten ? '&forgotten=1' : '') + (cfg.tag ? '&tag=' + encodeURIComponent(cfg.tag) : '');
    N.api('GET', url).then(function (cards) {
      queue = cards; index = 0;
      $('loading').hidden = true;
      if (!queue.length) return finish();
      show();
    }).catch(function (e) { $('loading').textContent = 'Could not load cards: ' + e.message; });
  }

  function show() {
    current = queue[index]; revealed = false;
    $('progress').textContent = (index + 1) + ' / ' + queue.length;
    $('card-tags').innerHTML = current.tags.map(function (t) { return '<span class="tag">' + N.esc(t) + '</span>'; }).join('');
    $('card-info').textContent = current.reps ? ('interval ' + current.interval_days + 'd · ' + current.reps + ' reviews') : 'new card';
    var isRelearn = relearn[current.id] !== undefined || current.last_result === 'wrong';
    $('relearn-badge').hidden = !isRelearn;
    $('card-edit').href = '/quiz/cards/' + current.id + '/edit';
    N.renderMarkdown(qEl, current.question);
    N.renderMarkdown(aEl, current.answer || '_No answer written._');
    $('attempt').value = '';
    $('attempt-wrap').hidden = false;
    $('answer-wrap').hidden = true;
    $('card').hidden = false;
    $('done').hidden = true;
    $('custom-wrong').value = ''; $('custom-correct').value = '';
    select('wrong', current.suggest.wrong);
    // relearning: a correct answer keeps the short interval chosen at the lapse (Anki behaviour)
    select('correct', relearn[current.id] !== undefined ? Math.max(1, relearn[current.id]) : current.suggest.correct);
    window.scrollTo(0, 0);
    if (window.innerWidth > 800) $('attempt').focus();
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    var typed = $('attempt').value.trim();
    $('compare').hidden = !typed;
    $('attempt-echo').textContent = typed;
    $('attempt-wrap').hidden = true;
    $('answer-wrap').hidden = false;
    $('answer-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  var submitting = false;
  function grade(result) {
    if (!revealed || submitting) return;
    submitting = true;
    var days = chosen[result];
    N.api('POST', '/api/cards/' + current.id + '/review', { result: result, days: days }).then(function (updated) {
      if (result === 'wrong') {
        if (relearn[current.id] === undefined) { results.wrong += 1; results.wrongIds.push(current.id); }
        relearn[current.id] = days;
        // Anki relearning step: ask it again a few cards later, until it is answered correctly
        var c = Object.assign({}, updated, { suggest: updated.suggest });
        queue.splice(Math.min(queue.length, index + 1 + RELEARN_GAP), 0, c);
      } else {
        if (relearn[current.id] === undefined) results.correct += 1;
        delete relearn[current.id];
        if (days === 0) queue.push(updated);   // "again today": once more at the end of the session
      }
      index += 1;
      if (index >= queue.length) finish(); else show();
    }).catch(function (e) { N.toast('Could not save: ' + e.message, true); })
      .finally(function () { submitting = false; });
  }

  function finish() {
    $('card').hidden = true;
    $('done').hidden = false;
    var total = results.correct + results.wrong;
    if (!total) {
      $('done-title').textContent = cfg.forgotten ? 'Nothing forgotten' : cfg.all ? 'No cards yet' : 'Nothing due';
      $('done-summary').textContent = cfg.forgotten ? 'Every card was answered correctly last time.' : cfg.all ? 'Create a card to start.' : 'Come back when cards are due, or practice all cards now.';
    } else {
      $('done-title').textContent = 'Session complete';
      $('done-summary').textContent = total + ' card' + (total === 1 ? '' : 's') + ' · ' + results.correct + ' right first time · ' + results.wrong + ' forgotten and relearned';
      N.toast('Saved. Next recall dates updated.');
    }
    var again = $('done-again');
    var uniq = results.wrongIds.filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (uniq.length) {
      again.hidden = false;
      again.textContent = 'Retry the ' + uniq.length + ' wrong one' + (uniq.length === 1 ? '' : 's');
      again.onclick = function (e) {
        e.preventDefault();
        var ids = uniq.slice();
        results = { correct: 0, wrong: 0, wrongIds: [] };
        Promise.all(ids.map(function (id) { return N.api('GET', '/api/cards/' + id); })).then(function (cards) {
          queue = cards; index = 0; show();
        });
      };
    } else again.hidden = true;
  }

  // ------------------------------------------------------------ events
  $('btn-reveal').addEventListener('click', reveal);
  $('btn-wrong').addEventListener('click', function () { grade('wrong'); });
  $('btn-correct').addEventListener('click', function () { grade('correct'); });
  $('attempt').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); reveal(); }
  });
  document.addEventListener('keydown', function (e) {
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    if (e.key === ' ' || e.key === 'Enter') { if (!revealed) { e.preventDefault(); reveal(); } }
    else if (e.key === '1') grade('wrong');
    else if (e.key === '2') grade('correct');
  });

  load();
})();
