/* Card editor: two mini Markdown fields (question, answer) with code/image/preview, tags, recall-on. */
(function () {
  'use strict';
  var N = window.Notes;
  var $ = function (id) { return document.getElementById(id); };
  var card = JSON.parse($('card-data').textContent);
  var cardId = card.id || null;
  var dueDays = cardId ? 'keep' : 0;

  // ------------------------------------------------------------ mini editors
  function insertBlock(ta, text) {
    var s = ta.selectionStart, before = ta.value.substring(0, s);
    var prefix = before.length === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    ta.setRangeText(prefix + text + '\n', s, ta.selectionEnd, 'end');
    ta.focus();
    ta.dispatchEvent(new Event('input'));
  }

  function uploadInto(ta, files) {
    var list = Array.prototype.filter.call(files, function (f) { return /^image\//.test(f.type); });
    if (!list.length) { N.toast('Only image files can be uploaded', true); return; }
    list.forEach(function (f) {
      var fd = new FormData(); fd.append('file', f, f.name || 'pasted.png');
      var ph = '![uploading ' + (f.name || 'image') + '…]()';
      insertBlock(ta, ph);
      N.api('POST', '/api/upload', fd, true).then(function (r) {
        var alt = (r.original_name || 'image').replace(/\.[^.]+$/, '').replace(/[\[\]]/g, '');
        ta.value = ta.value.replace(ph, '![' + alt + '](' + r.url + ')');
        ta.dispatchEvent(new Event('input'));
        N.toast('Image added');
      }).catch(function (e) {
        ta.value = ta.value.replace(ph + '\n', '').replace(ph, '');
        ta.dispatchEvent(new Event('input'));
        N.toast('Upload failed: ' + e.message, true);
      });
    });
  }

  document.querySelectorAll('.field[data-field]').forEach(function (sec) {
    var ta = sec.querySelector('textarea'), prev = sec.querySelector('.mini-preview');
    var lang = sec.querySelector('.lang'), file = sec.querySelector('.file');
    var btnPrev = sec.querySelector('[data-act="preview"]');
    N.bindMarkdownContainer(prev);

    function render() { if (!prev.hidden) N.renderMarkdown(prev, ta.value || '_Nothing yet._'); }
    ta.addEventListener('input', function () { autosize(ta); render(); });
    function autosize(el) { el.style.height = 'auto'; el.style.height = Math.min(600, Math.max(120, el.scrollHeight + 4)) + 'px'; }
    autosize(ta);

    sec.querySelector('[data-act="code"]').addEventListener('click', function () {
      var sel = ta.value.substring(ta.selectionStart, ta.selectionEnd);
      insertBlock(ta, '```' + lang.value + '\n' + (sel || '# code') + '\n```');
    });
    sec.querySelector('[data-act="image"]').addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () { uploadInto(ta, file.files); file.value = ''; });
    btnPrev.addEventListener('click', function () {
      prev.hidden = !prev.hidden; btnPrev.classList.toggle('active', !prev.hidden); render();
    });
    ta.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items; if (!items) return;
      var files = [];
      for (var i = 0; i < items.length; i++) if (items[i].kind === 'file' && /^image\//.test(items[i].type)) files.push(items[i].getAsFile());
      if (files.length) { e.preventDefault(); uploadInto(ta, files); }
    });
    ['dragenter', 'dragover'].forEach(function (ev) { sec.addEventListener(ev, function (e) { e.preventDefault(); sec.classList.add('dragover'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { sec.addEventListener(ev, function (e) { e.preventDefault(); sec.classList.remove('dragover'); }); });
    sec.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) uploadInto(ta, e.dataTransfer.files); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end'); }
    });
  });

  // ------------------------------------------------------------ recall-on chips
  var chips = $('chips-due'), custom = $('custom-due');
  chips.querySelectorAll('.chip-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      dueDays = b.dataset.days === 'keep' ? 'keep' : parseInt(b.dataset.days, 10);
      chips.querySelectorAll('.chip-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
      custom.value = '';
    });
  });
  custom.addEventListener('input', function () {
    if (custom.value === '') return;
    dueDays = Math.max(0, parseInt(custom.value, 10) || 0);
    chips.querySelectorAll('.chip-btn').forEach(function (x) { x.classList.remove('active'); });
  });

  // ------------------------------------------------------------ save
  var saving = false;
  function save() {
    if (saving) return;
    var question = $('question').value.trim();
    if (!question) { N.toast('Question is required', true); $('question').focus(); return; }
    saving = true;
    $('status').textContent = 'Saving…';
    var body = { question: question, answer: $('answer').value, tags: $('tags').value };
    if (dueDays !== 'keep') body.due_in_days = dueDays;
    var req = cardId ? N.api('PUT', '/api/cards/' + cardId, body) : N.api('POST', '/api/cards', body);
    req.then(function (c) { location.href = '/quiz/cards/' + c.id; })
       .catch(function (e) { $('status').textContent = ''; N.toast('Save failed: ' + e.message, true); })
       .finally(function () { saving = false; });
  }
  $('btn-save').addEventListener('click', save);
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
  });
  if (!cardId) $('question').focus();
})();
