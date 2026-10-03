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

  // ---------------------------------------------------------------- math (KaTeX)
  // Supported: $inline$, $$display$$, \(inline\), \[display\], ```math fences,
  // and bare \begin{equation|align|gather|multline|cases|matrix...} environments.
  // Chemistry via \ce{...} and units via \pu{...} (mhchem). Code spans/blocks are left alone.
  var MATH_MACROS = {
    '\\R': '\\mathbb{R}', '\\N': '\\mathbb{N}', '\\Z': '\\mathbb{Z}', '\\Q': '\\mathbb{Q}', '\\C': '\\mathbb{C}',
    '\\abs': '\\left|#1\\right|', '\\norm': '\\left\\lVert#1\\right\\rVert', '\\set': '\\left\\{#1\\right\\}',
    '\\dd': '\\mathrm{d}', '\\e': '\\mathrm{e}'
  };
  function renderTex(tex, display) {
    if (!window.katex) return '<code>' + esc(tex) + '</code>';
    var html = katex.renderToString(tex, {
      displayMode: display, throwOnError: false, strict: 'ignore', trust: false,
      output: 'htmlAndMathml', macros: Object.assign({}, MATH_MACROS), maxExpand: 2000, errorColor: '#d13212'
    });
    return display ? '<div class="math-display" title="Copy the equation to get its LaTeX">' + html + '</div>' : html;
  }
  var ENV = '(equation|align|alignat|gather|multline|flalign|eqnarray|split|aligned|gathered|cases|rcases|matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix|array|subarray|CD)';
  function extractMath(md) {
    var store = [];
    function put(tex, display) { store.push(renderTex(tex.trim(), display)); return 'MATHPH' + (store.length - 1) + 'XQ'; }
    // ```math / ```latex / ```tex fences become display math
    md = md.replace(/^(```|~~~)[ \t]*(math|latex|tex|katex)[ \t]*\n([\s\S]*?)\n\1[ \t]*$/gm, function (_, f, l, tex) { return '\n' + put(tex, true) + '\n'; });
    // leave other code fences and inline code untouched
    var parts = md.split(/(^(?:```|~~~)[\s\S]*?^(?:```|~~~)[ \t]*$|`[^`\n]+`)/m);
    for (var i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i]
        .replace(/\$\$([\s\S]+?)\$\$/g, function (_, t) { return put(t, true); })
        .replace(/\\\[([\s\S]+?)\\\]/g, function (_, t) { return put(t, true); })
        .replace(new RegExp('\\\\begin\\{' + ENV + '(\\*?)\\}[\\s\\S]*?\\\\end\\{\\1\\2\\}', 'g'), function (m) { return put(m, true); })
        .replace(/\\\(([\s\S]+?)\\\)/g, function (_, t) { return put(t, false); })
        // $inline$: no space just inside the dollars, closing $ not followed by a digit (so "$5 and $10" stays text)
        .replace(/(^|[^\\$])\$(?=\S)((?:\\\$|[^$\n])+?)(?<=\S)\$(?!\d)/g, function (_, pre, t) { return pre + put(t, false); });
    }
    return { md: parts.join(''), store: store };
  }

  function renderMarkdown(target, md) {
    var m = extractMath(md || '');
    var raw = marked.parse(m.md);
    var clean = DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
    // KaTeX output is generated from escaped input (trust: false), so it is inserted after sanitizing
    clean = clean.replace(/<p>\s*(MATHPH\d+XQ)\s*<\/p>/g, '$1').replace(/MATHPH(\d+)XQ/g, function (_, i) { return m.store[+i] || ''; });
    target.innerHTML = clean;
    target.querySelectorAll('a[href^="http"]').forEach(function (a) { a.target = '_blank'; a.rel = 'noopener'; });
    // GitHub-style callouts: > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
    target.querySelectorAll('blockquote').forEach(function (bq) {
      var p = bq.querySelector('p'); if (!p) return;
      var m = p.innerHTML.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(<br>)?/i); if (!m) return;
      var kind = m[1].toLowerCase();
      p.innerHTML = p.innerHTML.substring(m[0].length);
      bq.classList.add('callout', 'callout-' + kind);
      var t = document.createElement('div'); t.className = 'callout-title'; t.textContent = kind.charAt(0).toUpperCase() + kind.slice(1);
      bq.insertBefore(t, bq.firstChild);
    });
    target.querySelectorAll('li > input[type=checkbox]').forEach(function (cb) { cb.closest('li').classList.add('task'); });
    target.querySelectorAll('table').forEach(function (t) {
      if (t.parentElement.classList.contains('scroll-x')) return;
      var w = document.createElement('div'); w.className = 'scroll-x'; t.parentNode.insertBefore(w, t); w.appendChild(t);
    });
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

  // ---------------------------------------------------------------- tag autocomplete
  function tagAutocomplete(input, apiUrl, sep) {
    if (!input) return;
    var tags = null; // cached tag list [{name, count}]
    var box = document.createElement("div");
    box.className = "tag-suggest";
    box.style.display = "none";
    input.parentNode.style.position = "relative";
    input.parentNode.appendChild(box);
    var idx = -1;

    function fetchTags() {
      if (tags) return Promise.resolve(tags);
      return api("GET", apiUrl).then(function (data) {
        // data is {tag: count, ...}
        tags = Object.keys(data).sort(function (a, b) { return data[b] - data[a]; });
        return tags;
      });
    }

    function currentToken() {
      var v = input.value, pos = input.selectionStart || v.length;
      // find token start: scan back from cursor for separator
      var sepChar = sep === " " ? " " : ",";
      var start = v.lastIndexOf(sepChar, pos - 1) + 1;
      // skip leading whitespace
      while (start < pos && v[start] === " ") start++;
      return { start: start, end: pos, text: v.substring(start, pos).toLowerCase() };
    }

    function existingTags() {
      var sepChar = sep === " " ? " " : ",";
      return input.value.split(sepChar).map(function (t) { return t.trim().toLowerCase(); }).filter(Boolean);
    }

    function show(matches) {
      if (!matches.length) { box.style.display = "none"; idx = -1; return; }
      box.innerHTML = "";
      var existing = existingTags();
      var filtered = matches.filter(function (m) { return existing.indexOf(m.toLowerCase()) === -1; });
      if (!filtered.length) { box.style.display = "none"; idx = -1; return; }
      filtered.forEach(function (m, i) {
        var d = document.createElement("div");
        d.className = "tag-opt" + (i === idx ? " active" : "");
        d.textContent = m;
        d.addEventListener("mousedown", function (e) { e.preventDefault(); pick(m); });
        box.appendChild(d);
      });
      box.style.display = "block";
    }

    function pick(tag) {
      var tok = currentToken();
      var v = input.value;
      var joiner = sep === " " ? " " : ", ";
      var before = v.substring(0, tok.start);
      var after = v.substring(tok.end);
      // add a trailing separator so user can keep typing
      if (!after.trim()) after = joiner;
      else if (sep !== " " && after[0] !== ",") after = joiner + after.trimStart();
      input.value = before + tag + after;
      input.selectionStart = input.selectionEnd = (before + tag + joiner).length;
      box.style.display = "none";
      idx = -1;
      input.focus();
      input.dispatchEvent(new Event("input"));
    }

    input.addEventListener("input", function () {
      var tok = currentToken();
      if (tok.text.length < 1) { box.style.display = "none"; idx = -1; return; }
      fetchTags().then(function (all) {
        var q = tok.text;
        var matches = all.filter(function (t) { return t.toLowerCase().indexOf(q) !== -1; });
        idx = -1;
        show(matches);
      });
    });

    input.addEventListener("keydown", function (e) {
      var items = box.querySelectorAll(".tag-opt");
      if (!items.length || box.style.display === "none") return;
      if (e.key === "ArrowDown") {
        e.preventDefault(); idx = Math.min(idx + 1, items.length - 1);
        items.forEach(function (el, i) { el.classList.toggle("active", i === idx); });
      } else if (e.key === "ArrowUp") {
        e.preventDefault(); idx = Math.max(idx - 1, 0);
        items.forEach(function (el, i) { el.classList.toggle("active", i === idx); });
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (idx >= 0 && items[idx]) { e.preventDefault(); pick(items[idx].textContent); }
      } else if (e.key === "Escape") {
        box.style.display = "none"; idx = -1;
      }
    });

    input.addEventListener("blur", function () { setTimeout(function () { box.style.display = "none"; idx = -1; }, 150); });
  }

  return { api: api, toast: toast, esc: esc, renderMarkdown: renderMarkdown, bindMarkdownContainer: bindMarkdownContainer, openViewer: openViewer, tagAutocomplete: tagAutocomplete };
})();
