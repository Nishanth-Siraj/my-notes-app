/* Review heatmap (Review Heatmap add-on style): past days = green by reviews, future days = blue by cards due. */
window.AnkiHeatmap = (function () {
  'use strict';
  var N = window.Notes;
  var tz = new Date().getTimezoneOffset();

  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function level(n, max) { if (!n) return 0; var r = n / Math.max(max, 1); return r > .75 ? 4 : r > .5 ? 3 : r > .25 ? 2 : 1; }

  var tip = null;
  function tooltip() {
    if (tip) return tip;
    tip = document.createElement('div'); tip.className = 'hm-tip'; document.body.appendChild(tip); return tip;
  }

  function render(container, opts) {
    opts = opts || {};
    var days = parseInt(container.dataset.days || opts.days || 365, 10);
    var future = opts.future !== false ? 90 : 0;
    container.innerHTML = '<div class="hm-head"><span class="hm-title">Review heatmap</span>' +
      '<span class="hm-range">' + [365, 180, 90].map(function (d) {
        return '<button type="button" data-days="' + d + '" class="' + (d === days ? 'active' : '') + '">' + (d === 365 ? '1 year' : d + ' days') + '</button>';
      }).join('') + '</span></div><div class="muted small">Loading…</div>';

    Promise.all([
      N.api('GET', '/api/quiz/heatmap?days=' + days + '&tz=' + tz),
      future ? N.api('GET', '/api/quiz/future?days=' + future + '&tz=' + tz) : Promise.resolve(null)
    ]).then(function (res) {
      var hm = res[0], fut = res[1];
      var today = new Date(); today.setHours(0, 0, 0, 0);
      var start = addDays(today, -(days - 1));
      // start the grid on a Sunday so weeks line up in columns
      var gridStart = addDays(start, -start.getDay());
      var end = future ? addDays(today, future - 1) : today;
      var maxPast = 0; Object.keys(hm.days).forEach(function (k) { maxPast = Math.max(maxPast, hm.days[k]); });
      var maxFut = fut ? Math.max.apply(null, fut.counts.concat([1])) : 1;

      var cells = '', months = '', lastMonth = -1, col = 0;
      for (var d = new Date(gridStart); d <= end; d = addDays(d, 1)) {
        var key = iso(d), isFuture = d > today, isToday = d.getTime() === today.getTime();
        var cls = 'hm-cell', title;
        if (d < start) { cls += ' pad'; title = ''; }
        else if (isFuture) {
          var off = Math.round((d - today) / 86400000), n = fut ? fut.counts[off] || 0 : 0;
          cls += ' future l' + level(n, maxFut); title = n + ' due on ' + key;
        } else {
          var c = hm.days[key] || 0;
          cls += ' l' + level(c, maxPast) + (isToday ? ' today' : ''); title = c + ' review' + (c === 1 ? '' : 's') + ' on ' + key;
        }
        if (d < start) cells += '<div class="hm-cell" style="visibility:hidden"></div>';
        else cells += '<div class="' + cls + '" data-title="' + title + '"></div>';
        if (d.getDay() === 0) {                      // new column: month label when the month changes
          var m = d.getMonth();
          months += '<span style="width:15px">' + (m !== lastMonth && d >= start ? d.toLocaleString(undefined, { month: 'short' }) : '') + '</span>';
          lastMonth = m; col++;
        }
      }
      container.innerHTML =
        '<div class="hm-head"><span class="hm-title">Review heatmap</span><span class="hm-range">' +
          [365, 180, 90].map(function (d) { return '<button type="button" data-days="' + d + '" class="' + (d === days ? 'active' : '') + '">' + (d === 365 ? '1 year' : d + ' days') + '</button>'; }).join('') +
        '</span></div>' +
        '<div class="hm-scroll"><div class="hm-months">' + months + '</div><div class="hm-grid">' + cells + '</div></div>' +
        '<div class="hm-foot"><span>Past: reviews per day · Future: cards due</span>' +
          '<span class="hm-legend">Less <span class="hm-cell"></span><span class="hm-cell l1"></span><span class="hm-cell l2"></span><span class="hm-cell l3"></span><span class="hm-cell l4"></span> More</span></div>' +
        '<div class="hm-stats">' +
          stat(hm.streak_current + (hm.streak_current === 1 ? ' day' : ' days'), 'Current streak') +
          stat(hm.streak_longest + (hm.streak_longest === 1 ? ' day' : ' days'), 'Longest streak') +
          stat(hm.days_learned_pct + '%', 'Days learned (' + hm.days_learned + '/' + days + ')') +
          stat(hm.avg_active_day, 'Avg per active day') +
          stat(hm.total, 'Reviews in period') +
        '</div>';

      container.querySelectorAll('.hm-range button').forEach(function (b) {
        b.addEventListener('click', function () { container.dataset.days = b.dataset.days; render(container, opts); });
      });
      var t = tooltip();
      container.querySelectorAll('.hm-cell[data-title]').forEach(function (cell) {
        cell.addEventListener('mouseenter', function (e) { t.textContent = cell.dataset.title; t.style.display = 'block'; move(e); });
        cell.addEventListener('mousemove', move);
        cell.addEventListener('mouseleave', function () { t.style.display = 'none'; });
        cell.addEventListener('click', function () { N.toast(cell.dataset.title); });
      });
      function move(e) { t.style.left = (e.clientX + 12) + 'px'; t.style.top = (e.clientY + 12) + 'px'; }
      var sc = container.querySelector('.hm-scroll'); if (sc) sc.scrollLeft = sc.scrollWidth;   // show the most recent weeks first
    }).catch(function (e) { container.innerHTML = '<div class="muted small">Heatmap unavailable: ' + N.esc(e.message) + '</div>'; });
  }
  function stat(v, k) { return '<div class="hm-stat"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>'; }

  document.querySelectorAll('.heatmap-wrap').forEach(function (el) { render(el); });
  return { render: render, tz: tz };
})();
