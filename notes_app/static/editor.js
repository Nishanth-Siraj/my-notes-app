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
  function insertAtCursor(before, after, placeholder) {
    var s = contentEl.selectionStart, e = contentEl.selectionEnd;
    var had = contentEl.value.substring(s, e);
    var sel = had || placeholder || '';
    contentEl.setRangeText(before + sel + (after || ''), s, e, 'end');
    if (!had && placeholder) contentEl.setSelectionRange(s + before.length, s + before.length + placeholder.length);
    contentEl.focus(); markDirty(); renderPreview();
  }
  function insertBlock(text) {
    var s = contentEl.selectionStart;
    var before = contentEl.value.substring(0, s);
    var prefix = before.length === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    contentEl.setRangeText(prefix + text + '\n', s, contentEl.selectionEnd, 'end');
    contentEl.focus(); markDirty(); renderPreview();
  }
  function linePrefix(prefix, numbered) {
    var s = contentEl.selectionStart, e = contentEl.selectionEnd, v = contentEl.value;
    var ls = v.lastIndexOf('\n', s - 1) + 1;
    var le = v.indexOf('\n', e); if (le === -1) le = v.length;
    var out = v.substring(ls, le).split('\n').map(function (l, i) { return (numbered ? (i + 1) + '. ' : prefix) + l; }).join('\n');
    contentEl.setRangeText(out, ls, le, 'select');
    contentEl.focus(); markDirty(); renderPreview();
  }
  var actions = {
    bold:      function () { insertAtCursor('**', '**', 'bold text'); },
    italic:    function () { insertAtCursor('_', '_', 'italic text'); },
    h1:        function () { linePrefix('# '); },
    h2:        function () { linePrefix('## '); },
    h3:        function () { linePrefix('### '); },
    code:      function () { insertAtCursor('`', '`', 'code'); },
    codeblock: function () {
      var lang = $('code-lang').value;
      var sel = contentEl.value.substring(contentEl.selectionStart, contentEl.selectionEnd);
      insertBlock('```' + lang + '\n' + (sel || '# your code here') + '\n```');
    },
    ul:        function () { linePrefix('- '); },
    ol:        function () { linePrefix('', true); },
    quote:     function () { linePrefix('> '); },
    hr:        function () { insertBlock('---'); },
    link:      function () { insertAtCursor('[', '](https://)', 'link text'); },
    table:     function () { insertBlock('| Column | Column |\n| --- | --- |\n| value | value |'); }
  };
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
    if (e.key === 'Tab') { e.preventDefault(); insertAtCursor('    ', ''); }
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
  });

  if (!noteId) titleEl.focus();
})();
