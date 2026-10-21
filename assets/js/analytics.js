/**
 * analytics.js — loads Google Analytics 4 and Microsoft Clarity (IDs in config.js) and
 * defines track(name, params). Loaded on every page, right after config.js.
 *
 * Not loaded on localhost / 127.0.0.1 / file://, so testing doesn't pollute the data;
 * there track() just logs to the console.
 *
 * Privacy rules (DECISIONS.md, "Analytics"):
 *   - track() only forwards the parameters in ALLOWED, so typed text, queries and session
 *     ids can never reach GA4 by accident.
 *   - Clarity masks inputs by default; the pages also mark every input and every place a
 *     query is displayed with data-clarity-mask="true".
 */
(function () {
  var c = window.LAB_CONFIG || {};
  var host = location.hostname;
  var local = location.protocol === 'file:' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '';
  window.LAB_IS_LOCAL = local;

  // the only event parameters we ever send, and their allowed values
  var ALLOWED = {
    task: /^(search|describe|pair)$/,
    course: /^(Math \d{3}|none)$/,
    rating: /^(wanted|related|not_relevant|none|left|right|both|neither)$/,
    count: /^\d{1,4}$/,
  };

  window.track = function (name, params) {
    var safe = {};
    for (var k in params || {}) {
      if (ALLOWED[k] && ALLOWED[k].test(String(params[k]))) safe[k] = params[k];
    }
    if (local) { console.debug('[track]', name, safe); return; }
    try { gtag('event', name, safe); } catch (e) {}
  };

  if (local) return;

  // Google Analytics 4 (standard gtag.js snippet)
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + c.GA_ID;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { dataLayer.push(arguments); };
  gtag('js', new Date());
  gtag('config', c.GA_ID);

  // Microsoft Clarity (standard snippet)
  (function (c, l, a, r, i, t, y) {
    c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
    t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
    y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
  })(window, document, 'clarity', 'script', c.CLARITY_ID);
})();
