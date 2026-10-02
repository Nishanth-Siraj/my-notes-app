/* Shared helpers: API calls, toast, Markdown rendering, image viewer. */
window.Notes = (function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  // ---------------------------------------------------------------- API
  function api(method, url, body, isForm) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) {
      if (isForm) opts.body = body;
      else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    }
    return fetch(url, opts).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) {
        var msg = j.error || j.detail;
        if (Array.isArray(msg)) msg = msg.map(function (d) { return d.msg || JSON.stringify(d); }).join('; ');
        if (r.status === 401) location.href = '/login?next=' + encodeURIComponent(location.pathname);
        throw new Error(msg || (r.status + ' ' + r.statusText));
      });
      return r.status === 204 ? null : r.json();
    });
  }

  // ---------------------------------------------------------------- toast
  var toastEl = $('toast');
  function toast(msg, isError) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.className = 'toast'; }, 2200);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---------------------------------------------------------------- markdown
  marked.setOptions({ gfm: true, breaks: false });
  var renderer = new marked.Renderer();
  renderer.code = function (code, lang) {
    var text = typeof code === 'object' ? code.text : code;
    var language = typeof code === 'object' ? code.lang : lang;
    var valid = language && hljs.getLanguage(language);
    var html = valid ? hljs.highlight(text, { language: language }).value : hljs.highlightAuto(text).value;
    return '<pre>' + (language ? '<span class="lang">' + esc(language) + '</span>' : '') +
           '<button class="copy" type="button">Copy</button>' +
           '<code class="hljs' + (language ? ' language-' + esc(language) : '') + '">' + html + '</code></pre>';
  };
  marked.use({ renderer: renderer });

  function renderMarkdown(target, md) {
    var raw = marked.parse(md || '');
    target.innerHTML = DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
    target.querySelectorAll('a[href^="http"]').forEach(function (a) { a.target = '_blank'; a.rel = 'noopener'; });
  }

  // Copy buttons + image clicks inside any rendered markdown container
  function bindMarkdownContainer(el) {
    el.addEventListener('click', function (e) {
      var copy = e.target.closest('button.copy');
      if (copy) {
        var code = copy.parentElement.querySelector('code');
        navigator.clipboard.writeText(code.innerText).then(function () {
          copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy'; }, 1200);
        });
        return;
      }
      var img = e.target.closest('img');
      if (img) openViewer(img.src, img.alt);
    });
  }

  // ---------------------------------------------------------------- image viewer
  var lb = $('lightbox'), stage = $('lb-stage'), lbImg = $('lb-img');
  var scale = 1, tx = 0, ty = 0, natW = 0, natH = 0;
  function applyT() {
    lbImg.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    $('lb-zoom-level').textContent = Math.round(scale * 100) + '%';
  }
  function clampS(s) { return Math.min(8, Math.max(0.1, s)); }
  function fit() {
    if (!natW) return;
    scale = clampS(Math.min(stage.clientWidth / natW, stage.clientHeight / natH, 1));
    tx = (stage.clientWidth - natW * scale) / 2; ty = (stage.clientHeight - natH * scale) / 2; applyT();
  }
  function zoomTo(ns, px, py) { ns = clampS(ns); var k = ns / scale; tx = px - (px - tx) * k; ty = py - (py - ty) * k; scale = ns; applyT(); }
  function zoomBy(f, px, py) { if (px === undefined) { px = stage.clientWidth / 2; py = stage.clientHeight / 2; } zoomTo(scale * f, px, py); }
  function openViewer(src, alt) {
    $('lb-title').textContent = alt || src.split('/').pop();
    $('lb-newtab').href = src;
    lbImg.style.visibility = 'hidden';
    lbImg.onload = function () { natW = lbImg.naturalWidth; natH = lbImg.naturalHeight; fit(); lbImg.style.visibility = 'visible'; };
    lbImg.src = src;
    lb.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeViewer() { lb.classList.remove('open'); lbImg.src = ''; document.body.style.overflow = ''; }

  if (lb) {
    $('lb-close').addEventListener('click', closeViewer);
    $('lb-zoom-in').addEventListener('click', function () { zoomBy(1.25); });
    $('lb-zoom-out').addEventListener('click', function () { zoomBy(0.8); });
    $('lb-fit').addEventListener('click', fit);
    $('lb-actual').addEventListener('click', function () { zoomTo(1, stage.clientWidth / 2, stage.clientHeight / 2); });
    stage.addEventListener('wheel', function (e) {
      e.preventDefault(); var r = stage.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    stage.addEventListener('dblclick', function (e) {
      var r = stage.getBoundingClientRect(); var fs = Math.min(stage.clientWidth / natW, stage.clientHeight / natH, 1);
      if (Math.abs(scale - fs) < 0.01) zoomTo(Math.max(2, fs * 2.5), e.clientX - r.left, e.clientY - r.top); else fit();
    });
    var drag = null;
    stage.addEventListener('pointerdown', function (e) { stage.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, tx: tx, ty: ty }; stage.classList.add('dragging'); });
    stage.addEventListener('pointermove', function (e) { if (!drag) return; tx = drag.tx + e.clientX - drag.x; ty = drag.ty + e.clientY - drag.y; applyT(); });
    stage.addEventListener('pointerup', function () { drag = null; stage.classList.remove('dragging'); });
    stage.addEventListener('pointercancel', function () { drag = null; stage.classList.remove('dragging'); });
    document.addEventListener('keydown', function (e) {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') closeViewer();
      else if (e.key === '+' || e.key === '=') zoomBy(1.25);
      else if (e.key === '-') zoomBy(0.8);
      else if (e.key === 'f' || e.key === 'F' || e.key === '0') fit();
      else if (e.key === '1') zoomTo(1, stage.clientWidth / 2, stage.clientHeight / 2);
      else return;
      e.preventDefault();
    });
    window.addEventListener('resize', function () { if (lb.classList.contains('open')) fit(); });
  }

  return { api: api, toast: toast, esc: esc, renderMarkdown: renderMarkdown, bindMarkdownContainer: bindMarkdownContainer, openViewer: openViewer };
})();
