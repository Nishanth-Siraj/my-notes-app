/* Detail page: render the note and handle delete. */
(function () {
  'use strict';
  var N = window.Notes;
  var note = JSON.parse(document.getElementById('note-data').textContent);
  var rendered = document.getElementById('rendered');

  N.renderMarkdown(rendered, note.content);
  N.bindMarkdownContainer(rendered);

  document.getElementById('btn-delete').addEventListener('click', function () {
    if (!confirm('Delete "' + note.title + '"? This cannot be undone.')) return;
    N.api('DELETE', '/api/notes/' + note.id).then(function () {
      location.href = '/';
    }).catch(function (e) { N.toast('Delete failed: ' + e.message, true); });
  });
})();
