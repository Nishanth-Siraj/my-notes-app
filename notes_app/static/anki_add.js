/* Anki "Add" dialog: Type/Deck, Front, Back, Tags. Stays open after adding, keeps deck + tags. */
(function () {
  'use strict';
  var N = window.Notes;
  var $ = function (id) { return document.getElementById(id); };
  var card = JSON.parse($('card-data').textContent);
  var cardId = card.id || null;
  var deckSel = $('deck');

  // "New deck…" option prompts for a name and adds it to the select
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

  document.querySelectorAll('.field[data-field]').forEach(function (sec) {
    var ta = sec.querySelector('textarea'), prev = sec.querySelector('.preview');
    var lang = sec.querySelector('.lang'), file = sec.querySelector('.file'), pbtn = sec.querySelector('[data-act="preview"]');
    N.bindMarkdownContainer(prev);
    function render() { if (!prev.hidden) N.renderMarkdown(prev, ta.value || '_(empty)_'); }
    ta.addEventListener('input', render);
    sec.querySelector('[data-act="bold"]').addEventListener('click', function () { wrap(ta, '**', '**', 'bold'); });
    sec.querySelector('[data-act="italic"]').addEventListener('click', function () { wrap(ta, '_', '_', 'italic'); });
    sec.querySelector('[data-act="code"]').addEventListener('click', function () { wrap(ta, '`', '`', 'code'); });
    sec.querySelector('[data-act="codeblock"]').addEventListener('click', function () {
      var sel = ta.value.substring(ta.selectionStart, ta.selectionEnd);
      block(ta, '```' + lang.value + '\n' + (sel || '# code') + '\n```');
    });
    sec.querySelector('[data-act="math"]').addEventListener('click', function () { wrap(ta, '$', '$', 'x^2'); });
    sec.querySelector('[data-act="mathblock"]').addEventListener('click', function () {
      var sel = ta.value.substring(ta.selectionStart, ta.selectionEnd); block(ta, '$$\n' + (sel || 'E = mc^2') + '\n$$');
    });
    sec.querySelector('[data-act="image"]').addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () { upload(ta, file.files); file.value = ''; });
    pbtn.addEventListener('click', function () { prev.hidden = !prev.hidden; pbtn.classList.toggle('active', !prev.hidden); render(); });
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
      if ((e.ctrlKey || e.metaKey) && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); if (e.shiftKey) block(ta, '$$\n' + 'E = mc^2' + '\n$$'); else wrap(ta, '$', '$', 'x^2'); }
    });
  });

  // ---------------- save
  var saving = false;
  function save() {
    if (saving) return;
    var question = $('question').value.trim();
    if (!question) { N.toast('The first field is empty.', true); $('question').focus(); return; }
    saving = true;
    var body = { question: question, answer: $('answer').value, tags: $('tags').value.replace(/\s+/g, ','), deck: deckSel.value };
    var req = cardId ? N.api('PUT', '/api/cards/' + cardId, body) : N.api('POST', '/api/cards', body);
    req.then(function (c) {
      if (cardId) { location.href = '/quiz/cards/' + c.id; return; }
      // Anki keeps the Add dialog open: clear fields, keep deck and tags
      $('question').value = ''; $('answer').value = '';
      document.querySelectorAll('.field .preview').forEach(function (p) { if (!p.hidden) N.renderMarkdown(p, '_(empty)_'); });
      $('question').focus();
      N.toast('Added.');
    }).catch(function (e) { N.toast('Could not add: ' + e.message, true); })
      .finally(function () { saving = false; });
  }
  $('btn-save').addEventListener('click', save);
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') location.href = $('btn-close').href;
  });
  if (!cardId) $('question').focus();

  // tag autocomplete
  N.tagAutocomplete($('tags'), '/api/quiz/tags', ',');
})();
