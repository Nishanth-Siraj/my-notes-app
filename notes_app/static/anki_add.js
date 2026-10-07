/* Anki "Add/Edit" card dialog */
(function () {
  'use strict';
  var N = window.Notes;
  var $ = function (id) { return document.getElementById(id); };
  var card = JSON.parse($('card-data').textContent);
  var cardId = card.id || null;
  var deckSel = $('deck');

  // New cards go to the deck used last time unless the URL names one
  var KEY = 'azazel:lastDeck';
  function remember(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
  if (!cardId && !new URLSearchParams(location.search).get('deck')) {
    var saved = null; try { saved = localStorage.getItem(KEY); } catch (e) {}
    if (saved && Array.prototype.some.call(deckSel.options, function (o) { return o.value === saved; })) deckSel.value = saved;
  }

  // "New deck…" option
  var lastDeck = deckSel.value;
  deckSel.addEventListener('change', function () {
    if (deckSel.value !== '__new__') { lastDeck = deckSel.value; return; }
    var name = prompt('New deck name:');
    if (name && name.trim()) {
      var opt = document.createElement('option'); opt.value = opt.textContent = name.trim();
      deckSel.insertBefore(opt, deckSel.querySelector('option[value="__new__"]'));
      deckSel.value = opt.value; lastDeck = opt.value;
    } else deckSel.value = lastDeck;
  });

  // ---------------- field editors
  function wrap(ta, before, after, ph) {
    var s = ta.selectionStart, e = ta.selectionEnd, had = ta.value.substring(s, e);
    ta.setRangeText(before + (had || ph) + after, s, e, 'end');
    if (!had) ta.setSelectionRange(s + before.length, s + before.length + ph.length);
    ta.focus(); ta.dispatchEvent(new Event('input'));
  }
  function block(ta, text) {
    var s = ta.selectionStart, before = ta.value.substring(0, s);
    var pre = before.length === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    ta.setRangeText(pre + text + '\n', s, ta.selectionEnd, 'end');
    ta.focus(); ta.dispatchEvent(new Event('input'));
  }
  function upload(ta, files) {
    var list = Array.prototype.filter.call(files, function (f) { return /^image\//.test(f.type); });
    if (!list.length) { N.toast('Only images can be attached', true); return; }
    list.forEach(function (f) {
      var fd = new FormData(); fd.append('file', f, f.name || 'pasted.png');
      var ph = '![uploading…]()'; block(ta, ph);
      N.api('POST', '/api/upload', fd, true).then(function (r) {
        var alt = (r.original_name || 'image').replace(/\.[^.]+$/, '').replace(/[\[\]]/g, '');
        ta.value = ta.value.replace(ph, '![' + alt + '](' + r.url + ')'); ta.dispatchEvent(new Event('input'));
      }).catch(function (e) {
        ta.value = ta.value.replace(ph + '\n', '').replace(ph, ''); ta.dispatchEvent(new Event('input'));
        N.toast('Upload failed: ' + e.message, true);
      });
    });
  }

  document.querySelectorAll('.ac-card[data-field]').forEach(function (sec) {
    var ta = sec.querySelector('textarea'), prev = sec.querySelector('.preview');
    var lang = sec.querySelector('.lang'), file = sec.querySelector('.file');
    var pbtn = sec.querySelector('[data-act="preview"]');
    N.bindMarkdownContainer(prev);
    function render() { if (!prev.hidden) N.renderMarkdown(prev, ta.value || '_(empty)_'); }
    ta.addEventListener('input', render);
    sec.querySelector('[data-act="bold"]').addEventListener('click', function () { wrap(ta, '**', '**', 'bold'); });
    sec.querySelector('[data-act="italic"]').addEventListener('click', function () { wrap(ta, '_', '_', 'italic'); });
    sec.querySelector('[data-act="code"]').addEventListener('click', function () { wrap(ta, '`', '`', 'code'); });
    sec.querySelector('[data-act="codeblock"]').addEventListener('click', function () {
      var sel = ta.value.substring(ta.selectionStart, ta.selectionEnd);
      block(ta, '```' + (lang ? lang.value : '') + '\n' + (sel || '# code') + '\n```');
    });
    sec.querySelector('[data-act="math"]').addEventListener('click', function () { wrap(ta, '$', '$', 'x^2'); });
    var lnkBtn = sec.querySelector('[data-act="link"]');
    if (lnkBtn) lnkBtn.addEventListener('click', function () { wrap(ta, '[', '](url)', 'link text'); });
    sec.querySelector('[data-act="image"]').addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () { upload(ta, file.files); file.value = ''; });
    pbtn.addEventListener('click', function () {
      prev.hidden = !prev.hidden; pbtn.classList.toggle('active', !prev.hidden); render();
    });
    ta.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items; if (!items) return;
      var files = [];
      for (var i = 0; i < items.length; i++) if (items[i].kind === 'file' && /^image\//.test(items[i].type)) files.push(items[i].getAsFile());
      if (files.length) { e.preventDefault(); upload(ta, files); }
    });
    ['dragenter', 'dragover'].forEach(function (ev) { sec.addEventListener(ev, function (e) { e.preventDefault(); sec.classList.add('dragover'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { sec.addEventListener(ev, function (e) { e.preventDefault(); sec.classList.remove('dragover'); }); });
    sec.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) upload(ta, e.dataTransfer.files); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end'); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); wrap(ta, '**', '**', 'bold'); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'i') { e.preventDefault(); wrap(ta, '_', '_', 'italic'); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'm') { e.preventDefault(); if (e.shiftKey) block(ta, '$$\nE = mc^2\n$$'); else wrap(ta, '$', '$', 'x^2'); }
    });
  });

  function closePreviews() {
    document.querySelectorAll('.ac-card[data-field]').forEach(function (sec) {
      sec.querySelector('.preview').hidden = true;
      sec.querySelector('[data-act="preview"]').classList.remove('active');
    });
  }

  // ---------------- tag chips
  var tagsInput = $('tags');           // hidden, comma-joined
  var tagInput = $('tag-input');       // visible text input
  var chipsEl = $('tag-chips');
  var tags = tagsInput.value ? tagsInput.value.split(',').map(function (t) { return t.trim(); }).filter(Boolean) : [];

  function syncTags() {
    tagsInput.value = tags.join(',');
    chipsEl.innerHTML = '';
    tags.forEach(function (t, i) {
      var chip = document.createElement('span'); chip.className = 'ac-chip';
      chip.innerHTML = t + '<button type="button" aria-label="Remove" data-i="' + i + '">&times;</button>';
      chipsEl.appendChild(chip);
    });
    if (window.lucide) lucide.createIcons({ nodes: [chipsEl] });
  }
  chipsEl.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-i]');
    if (!btn) return;
    tags.splice(parseInt(btn.dataset.i, 10), 1);
    syncTags();
  });
  function addTag(raw) {
    raw.split(/[,\s]+/).forEach(function (t) {
      t = t.trim().toLowerCase();
      if (t && !tags.includes(t)) tags.push(t);
    });
    syncTags();
  }
  tagInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (tagInput.value.trim()) { addTag(tagInput.value); tagInput.value = ''; }
    } else if (e.key === 'Backspace' && !tagInput.value && tags.length) {
      tags.pop(); syncTags();
    }
  });
  tagInput.addEventListener('blur', function () {
    if (tagInput.value.trim()) { addTag(tagInput.value); tagInput.value = ''; }
  });
  syncTags();

  // tag autocomplete on the visible input
  N.tagAutocomplete(tagInput, '/api/quiz/tags', ',');

  // ---------------- clear button
  $('btn-clear').addEventListener('click', function () {
    $('question').value = ''; $('answer').value = '';
    tags = []; syncTags(); closePreviews();
    $('question').focus();
  });

  // ---------------- preview all
  $('btn-preview-all') && $('btn-preview-all').addEventListener('click', function () {
    document.querySelectorAll('.ac-card[data-field] [data-act="preview"]').forEach(function (b) { b.click(); });
  });

  // ---------------- save
  var saving = false;
  function save() {
    if (saving) return;
    var question = $('question').value.trim();
    if (!question) { N.toast('The front field is empty.', true); $('question').focus(); return; }
    if (tagInput.value.trim()) { addTag(tagInput.value); tagInput.value = ''; }
    saving = true;
    var body = { question: question, answer: $('answer').value, tags: tagsInput.value, deck: deckSel.value };
    var req = cardId ? N.api('PUT', '/api/cards/' + cardId, body) : N.api('POST', '/api/cards', body);
    req.then(function (c) {
      remember(c.deck);
      if (cardId) { location.href = '/quiz/cards/' + c.id; return; }
      $('question').value = ''; $('answer').value = '';
      closePreviews();
      $('question').focus();
      N.toast('Card added to ' + c.deck);
    }).catch(function (e) { N.toast('Could not save: ' + e.message, true); })
      .finally(function () { saving = false; });
  }
  // Keep focus where it is so blur-driven layout shifts can't swallow the first click
  ['mousedown', 'pointerdown'].forEach(function (ev) { $('btn-save').addEventListener(ev, function (e) { e.preventDefault(); }); });
  $('btn-save').addEventListener('click', save);
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') location.href = $('btn-close').href;
  });
  if (!cardId) $('question').focus();
})();
