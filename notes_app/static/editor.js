/* Editor page: used for both create (/notes/new) and edit (/notes/{id}/edit). */
(function () {
  'use strict';
  var N = window.Notes;
  var $ = function (id) { return document.getElementById(id); };

  var note = JSON.parse($('note-data').textContent);   // {} on create
  var noteId = note.id || null;
  var titleEl = $('title'), tagsEl = $('tags'), contentEl = $('content'), previewEl = $('preview');
  var statusEl = $('status'), panesEl = $('panes'), paneEdit = document.querySelector('.pane-edit');
  var fileInput = $('file-input'), btnSave = $('btn-save'), btnDone = $('btn-done');

  var dirty = false, saveTimer = null, saving = false;

  function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = 'status ' + (cls || ''); }
  function renderPreview() { N.renderMarkdown(previewEl, contentEl.value); }
  N.bindMarkdownContainer(previewEl);
  renderPreview();

  // ------------------------------------------------------------ save
  function payload() { return { title: titleEl.value, content: contentEl.value, tags: tagsEl.value }; }

  function markDirty() {
    dirty = true;
    setStatus('Unsaved', 'dirty');
    if (noteId) { clearTimeout(saveTimer); saveTimer = setTimeout(save, 900); }   // autosave only when editing
  }

  function save() {
    if (saving) return Promise.resolve();
    if (!noteId && !titleEl.value.trim() && !contentEl.value.trim()) {
      N.toast('Add a title or some content first', true);
      return Promise.resolve();
    }
    saving = true;
    clearTimeout(saveTimer);
    setStatus('Saving…', 'dirty');
    var req = noteId ? N.api('PUT', '/api/notes/' + noteId, payload())
                     : N.api('POST', '/api/notes', payload());
    return req.then(function (n) {
      dirty = false;
      if (!noteId) {                                    // just created: go to its page
        location.href = '/notes/' + n.id;
        return;
      }
      setStatus('Saved');
    }).catch(function (e) {
      setStatus('Save failed', 'error');
      N.toast('Save failed: ' + e.message, true);
    }).finally(function () { saving = false; });
  }

  btnSave.addEventListener('click', save);
  if (btnDone) {
    btnDone.addEventListener('click', function (e) {
      if (!dirty) return;
      e.preventDefault();
      save().then(function () { if (!dirty) location.href = btnDone.href; });
    });
  }

  titleEl.addEventListener('input', markDirty);
  tagsEl.addEventListener('input', markDirty);
  contentEl.addEventListener('input', function () { markDirty(); renderPreview(); });

  window.addEventListener('beforeunload', function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ------------------------------------------------------------ toolbar helpers
  // All edits go through replaceRange so the browser's own Undo / Redo (Ctrl+Z) keeps working.
  function replaceRange(s, e, text, select) {
    contentEl.focus();
    contentEl.setSelectionRange(s, e);
    var ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (err) { ok = false; }
    if (!ok || contentEl.value.substring(s, s + text.length) !== text) contentEl.setRangeText(text, s, e, 'end');
    if (select === 'select') contentEl.setSelectionRange(s, s + text.length);
    else if (select && select.length === 2) contentEl.setSelectionRange(select[0], select[1]);
    markDirty(); renderPreview(); updateCount();
  }
  function insertAtCursor(before, after, placeholder) {
    var s = contentEl.selectionStart, e = contentEl.selectionEnd;
    var had = contentEl.value.substring(s, e), sel = had || placeholder || '';
    after = after || '';
    // toggle off if the selection is already wrapped
    var v = contentEl.value;
    if (had && v.substring(s - before.length, s) === before && v.substring(e, e + after.length) === after && before) {
      replaceRange(s - before.length, e + after.length, had, [s - before.length, s - before.length + had.length]); return;
    }
    var start = s + before.length;
    replaceRange(s, e, before + sel + after, had ? [start, start + sel.length] : (placeholder ? [start, start + placeholder.length] : null));
  }
  function insertBlock(text, cursorOffset) {
    var s = contentEl.selectionStart, before = contentEl.value.substring(0, s);
    var prefix = before.length === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    var full = prefix + text + '\n';
    replaceRange(s, contentEl.selectionEnd, full, cursorOffset !== undefined ? [s + prefix.length + cursorOffset, s + prefix.length + cursorOffset] : null);
  }
  function lineBounds() {
    var s = contentEl.selectionStart, e = contentEl.selectionEnd, v = contentEl.value;
    var ls = v.lastIndexOf('\n', s - 1) + 1;
    var le = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e); if (le === -1) le = v.length;
    return [ls, le, v.substring(ls, le).split('\n')];
  }
  var LIST_RE = /^(\s*)(?:[-*+] \[[ xX]\] |[-*+] |\d+\. |> |#{1,6} )?/;
  function linePrefix(prefix, numbered) {
    var b = lineBounds();
    var allHave = b[2].every(function (l) { return numbered ? /^\s*\d+\. /.test(l) : l.indexOf(prefix) === l.match(/^\s*/)[0].length && l.trim().startsWith(prefix.trim()); });
    var out = b[2].map(function (l, i) {
      var m = l.match(LIST_RE), indent = m[1], rest = l.substring(m[0].length);
      if (allHave) return indent + rest;                       // toggle off
      return indent + (numbered ? (i + 1) + '. ' : prefix) + rest;
    }).join('\n');
    replaceRange(b[0], b[1], out, 'select');
  }
  function heading(level) {
    var b = lineBounds();
    var out = b[2].map(function (l) {
      var rest = l.replace(/^#{1,6}\s+/, '');
      return level === 'p' ? rest : '#'.repeat(+level) + ' ' + rest;
    }).join('\n');
    replaceRange(b[0], b[1], out, 'select');
  }
  function indent(dir) {
    var b = lineBounds();
    var out = b[2].map(function (l) { return dir > 0 ? '    ' + l : l.replace(/^( {1,4}|\t)/, ''); }).join('\n');
    replaceRange(b[0], b[1], out, 'select');
  }
  function clearFormatting() {
    var s = contentEl.selectionStart, e = contentEl.selectionEnd;
    if (s === e) { N.toast('Select some text to clear its formatting'); return; }
    var t = contentEl.value.substring(s, e)
      .replace(/<\/?(u|mark|sup|sub|kbd)>/g, '')
      .replace(/(\*\*|__|~~)(.+?)\1/g, '$2').replace(/(\*|_)(.+?)\1/g, '$2').replace(/`([^`]+)`/g, '$1')
      .replace(/^\s*(#{1,6}|>|[-*+] \[[ xX]\]|[-*+]|\d+\.)\s+/gm, '');
    replaceRange(s, e, t, 'select');
  }
  function insertTable() {
    var v = prompt('Table size as columns x rows (e.g. 3x4):', '3x3'); if (!v) return;
    var m = v.match(/(\d+)\s*[x×*, ]\s*(\d+)/); if (!m) { N.toast('Use the form 3x4', true); return; }
    var c = Math.min(12, Math.max(1, +m[1])), r = Math.min(50, Math.max(1, +m[2]));
    var row = function (cell) { return '| ' + Array(c).fill(cell).join(' | ') + ' |'; };
    var head = '| ' + Array.from({ length: c }, function (_, i) { return 'Column ' + (i + 1); }).join(' | ') + ' |';
    insertBlock([head, row('---')].concat(Array(r).fill(row('   '))).join('\n'));
  }

  var actions = {
    undo:      function () { contentEl.focus(); document.execCommand('undo'); },
    redo:      function () { contentEl.focus(); document.execCommand('redo'); },
    bold:      function () { insertAtCursor('**', '**', 'bold text'); },
    italic:    function () { insertAtCursor('_', '_', 'italic text'); },
    underline: function () { insertAtCursor('<u>', '</u>', 'underlined'); },
    strike:    function () { insertAtCursor('~~', '~~', 'struck text'); },
    highlight: function () { insertAtCursor('<mark>', '</mark>', 'highlighted'); },
    sup:       function () { insertAtCursor('<sup>', '</sup>', 'sup'); },
    sub:       function () { insertAtCursor('<sub>', '</sub>', 'sub'); },
    kbd:       function () { insertAtCursor('<kbd>', '</kbd>', 'Ctrl'); },
    clear:     clearFormatting,
    h1:        function () { heading(1); },
    h2:        function () { heading(2); },
    h3:        function () { heading(3); },
    code:      function () { insertAtCursor('`', '`', 'code'); },
    codeblock: function () {
      var lang = $('code-lang').value;
      var sel = contentEl.value.substring(contentEl.selectionStart, contentEl.selectionEnd);
      insertBlock('```' + lang + '\n' + (sel || '') + '\n```', 4 + lang.length);
    },
    ul:        function () { linePrefix('- '); },
    ol:        function () { linePrefix('', true); },
    task:      function () { linePrefix('- [ ] '); },
    indent:    function () { indent(1); },
    outdent:   function () { indent(-1); },
    quote:     function () { linePrefix('> '); },
    details:   function () {
      var sel = contentEl.value.substring(contentEl.selectionStart, contentEl.selectionEnd);
      insertBlock('<details>\n<summary>Click to expand</summary>\n\n' + (sel || 'Hidden content') + '\n\n</details>');
    },
    hr:        function () { insertBlock('---'); },
    link:      function () {
      var s = contentEl.selectionStart, e = contentEl.selectionEnd, had = contentEl.value.substring(s, e);
      var url = prompt('Link URL:', /^https?:\/\//.test(had) ? had : 'https://'); if (!url) return;
      var text = /^https?:\/\//.test(had) ? 'link text' : (had || 'link text');
      replaceRange(s, e, '[' + text + '](' + url + ')', [s + 1, s + 1 + text.length]);
    },
    imageurl:  function () {
      var url = prompt('Image URL:', 'https://'); if (!url || url === 'https://') return;
      insertBlock('![image](' + url + ')');
    },
    table:     insertTable,
    date:      function () {
      var d = new Date();
      insertAtCursor(d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' +
                     d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }), '', '');
    },
    find:      function () { openFind(); },
    focus:     function () { document.body.classList.toggle('focus-mode'); contentEl.focus(); }
  };

  $('heading').addEventListener('change', function (e) { if (e.target.value) heading(e.target.value); e.target.value = ''; });
  $('callout').addEventListener('change', function (e) {
    var kind = e.target.value; e.target.value = ''; if (!kind) return;
    var sel = contentEl.value.substring(contentEl.selectionStart, contentEl.selectionEnd);
    var body = (sel || 'Write your ' + kind.toLowerCase() + ' here').split('\n').map(function (l) { return '> ' + l; }).join('\n');
    insertBlock('> [!' + kind + ']\n' + body);
  });

  // ------------------------------------------------------------ word count
  function updateCount() {
    var t = contentEl.value.replace(/```[\s\S]*?```/g, ' ').trim();
    var words = t ? t.split(/\s+/).length : 0;
    $('wordcount').textContent = words + ' words · ' + Math.max(1, Math.round(words / 200)) + ' min read';
  }
  contentEl.addEventListener('input', updateCount);
  updateCount();

  // ------------------------------------------------------------ find & replace
  var findbar = $('findbar'), fq = $('find-q'), fr = $('find-r'), fcase = $('find-case');
  function openFind() {
    findbar.hidden = false;
    var sel = contentEl.value.substring(contentEl.selectionStart, contentEl.selectionEnd);
    if (sel && sel.indexOf('\n') === -1) fq.value = sel;
    fq.focus(); fq.select(); countMatches();
  }
  function needle() { return fcase.checked ? fq.value : fq.value.toLowerCase(); }
  function hay() { return fcase.checked ? contentEl.value : contentEl.value.toLowerCase(); }
  function countMatches() {
    if (!fq.value) { $('find-count').textContent = ''; return 0; }
    var n = hay().split(needle()).length - 1;
    $('find-count').textContent = n + ' match' + (n === 1 ? '' : 'es'); return n;
  }
  function findNext() {
    if (!fq.value) return false;
    var from = contentEl.selectionEnd, i = hay().indexOf(needle(), from);
    if (i === -1) i = hay().indexOf(needle());
    if (i === -1) { N.toast('No matches'); return false; }
    contentEl.focus(); contentEl.setSelectionRange(i, i + fq.value.length);
    var lines = contentEl.value.substring(0, i).split('\n').length;
    contentEl.scrollTop = Math.max(0, (lines - 5) * parseFloat(getComputedStyle(contentEl).lineHeight || 22));
    return true;
  }
  function replaceOne() {
    var s = contentEl.selectionStart, e = contentEl.selectionEnd, cur = contentEl.value.substring(s, e);
    if ((fcase.checked ? cur : cur.toLowerCase()) === needle() && cur) replaceRange(s, e, fr.value, [s + fr.value.length, s + fr.value.length]);
    findNext(); countMatches();
  }
  function replaceAll() {
    if (!fq.value) return;
    var n = countMatches(); if (!n) return;
    var re = new RegExp(fq.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), fcase.checked ? 'g' : 'gi');
    replaceRange(0, contentEl.value.length, contentEl.value.replace(re, function () { return fr.value; }));
    N.toast('Replaced ' + n); countMatches();
  }
  fq.addEventListener('input', countMatches); fcase.addEventListener('change', countMatches);
  fq.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); findNext(); } if (e.key === 'Escape') findbar.hidden = true; });
  fr.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); replaceOne(); } if (e.key === 'Escape') findbar.hidden = true; });
  $('find-next').addEventListener('click', findNext);
  $('find-one').addEventListener('click', replaceOne);
  $('find-all').addEventListener('click', replaceAll);
  $('find-close').addEventListener('click', function () { findbar.hidden = true; contentEl.focus(); });

  document.querySelectorAll('#toolbar [data-md]').forEach(function (b) {
    b.addEventListener('click', function () { actions[b.dataset.md](); });
  });

  // view modes
  document.querySelectorAll('#toolbar [data-view]').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#toolbar [data-view]').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      panesEl.className = 'panes view-' + b.dataset.view;
      try { localStorage.setItem('notes.view', b.dataset.view); } catch (e) {}
    });
  });
  try {
    var v = localStorage.getItem('notes.view');
    var vb = v && document.querySelector('#toolbar [data-view="' + v + '"]');
    if (vb) vb.click();
  } catch (e) {}

  // ------------------------------------------------------------ images
  function uploadFiles(files) {
    var list = Array.prototype.filter.call(files, function (f) { return /^image\//.test(f.type); });
    if (!list.length) { N.toast('Only image files can be uploaded', true); return; }
    list.forEach(function (f) {
      var fd = new FormData();
      fd.append('file', f, f.name || 'pasted.png');
      if (noteId) fd.append('note_id', noteId);
      var placeholder = '![uploading ' + (f.name || 'image') + '…]()';
      insertBlock(placeholder);
      N.api('POST', '/api/upload', fd, true).then(function (r) {
        var alt = (r.original_name || 'image').replace(/\.[^.]+$/, '').replace(/[\[\]]/g, '');
        contentEl.value = contentEl.value.replace(placeholder, '![' + alt + '](' + r.url + ')');
        markDirty(); renderPreview();
        N.toast('Image added');
      }).catch(function (e) {
        contentEl.value = contentEl.value.replace(placeholder + '\n', '').replace(placeholder, '');
        markDirty(); renderPreview();
        N.toast('Upload failed: ' + e.message, true);
      });
    });
  }
  $('btn-image').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () { uploadFiles(fileInput.files); fileInput.value = ''; });
  contentEl.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items; if (!items) return;
    var files = [];
    for (var i = 0; i < items.length; i++) if (items[i].kind === 'file' && /^image\//.test(items[i].type)) files.push(items[i].getAsFile());
    if (files.length) { e.preventDefault(); uploadFiles(files); }
  });
  ['dragenter', 'dragover'].forEach(function (ev) { paneEdit.addEventListener(ev, function (e) { e.preventDefault(); paneEdit.classList.add('dragover'); }); });
  ['dragleave', 'drop'].forEach(function (ev) { paneEdit.addEventListener(ev, function (e) { e.preventDefault(); paneEdit.classList.remove('dragover'); }); });
  paneEdit.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files); });

  // ------------------------------------------------------------ keyboard
  contentEl.addEventListener('keydown', function (e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      if (contentEl.selectionStart !== contentEl.selectionEnd || e.shiftKey) indent(e.shiftKey ? -1 : 1);
      else replaceRange(contentEl.selectionStart, contentEl.selectionEnd, '    ');
      return;
    }
    // Enter continues bullets, numbers, checklists and quotes; Enter on an empty item ends the list
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && contentEl.selectionStart === contentEl.selectionEnd) {
      var v = contentEl.value, s = contentEl.selectionStart, ls = v.lastIndexOf('\n', s - 1) + 1, line = v.substring(ls, s);
      var m = line.match(/^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)\. |> )/);
      if (!m) return;
      e.preventDefault();
      if (line.trim() === m[2].trim()) { replaceRange(ls, s, ''); return; }   // empty item: stop the list
      var next = m[3] ? (+m[3] + 1) + '. ' : m[2].replace(/\[[xX]\]/, '[ ]');
      replaceRange(s, s, '\n' + m[1] + next);
    }
  });
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey; if (!mod) return;
    var inEditor = document.activeElement === contentEl;
    if (e.key === 's') { e.preventDefault(); save(); }
    else if (inEditor && e.key === 'b') { e.preventDefault(); actions.bold(); }
    else if (inEditor && e.key === 'i') { e.preventDefault(); actions.italic(); }
    else if (inEditor && e.key === 'k' && e.shiftKey) { e.preventDefault(); actions.codeblock(); }
    else if (inEditor && e.key === 'k') { e.preventDefault(); actions.link(); }
    else if (inEditor && e.key === '`') { e.preventDefault(); actions.code(); }
    else if (inEditor && e.key === 'u') { e.preventDefault(); actions.underline(); }
    else if (inEditor && e.shiftKey && (e.key === 'X' || e.key === 'x')) { e.preventDefault(); actions.strike(); }
    else if (inEditor && e.shiftKey && (e.key === 'H' || e.key === 'h')) { e.preventDefault(); actions.highlight(); }
    else if (e.key === 'f' && !e.shiftKey) { e.preventDefault(); openFind(); }
    else if (inEditor && e.altKey && /^[1-6]$/.test(e.key)) { e.preventDefault(); heading(e.key); }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.body.classList.contains('focus-mode')) document.body.classList.remove('focus-mode');
  });

  if (!noteId) titleEl.focus();
})();
