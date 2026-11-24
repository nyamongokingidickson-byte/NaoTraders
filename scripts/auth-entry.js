// Routes every "log in / sign in" intent on the NovaTrade KE site to our own account page
// (/login) instead of the Deriv OAuth hand-off the mirrored app performs by default.
//
// Loaded first in <head> on every page, before the app bundles, so the capture-phase
// listener runs ahead of React's handlers: the app's own click handler never fires, which
// is what stops it building a PKCE challenge and navigating to auth.deriv.com.
//
// Covers four paths to Deriv:
//   1. clicks on any control that means "log in" (text, id, class, aria-label or test id)
//   2. links whose href points at Deriv's OAuth/login endpoints
//   3. window.open() calls aimed at those endpoints
//   4. client-side route changes to /start-login or /login (the app's login route)
(function () {
  'use strict';
  if (window.__ntAuthEntry) return;
  window.__ntAuthEntry = true;

  var OUR_LOGIN = '/login';
  var MAX_ANCESTORS = 6;
  var DERIV_AUTH = /^https?:\/\/([a-z0-9-]+\.)*deriv\.com\/(oauth2|login|signin|sign-in|signup)/i;
  var LOGIN_TEXT = /^\s*(log\s?in|login|sign\s?in|signin|sign\s?in with deriv|log\s?in with deriv)\s*[›>→]?\s*$/i;
  var LOGIN_ATTR = /(^|[-_])(log-?in|login|sign-?in|signin|auth-entry)($|[-_])/i;

  function onOurLoginPage() {
    return /^\/login\/?$/i.test(location.pathname);
  }

  function goToLogin() {
    if (onOurLoginPage()) return;
    location.assign(OUR_LOGIN);
  }

  // Is this reference an intent to authenticate (ours or Deriv's)?
  function isAuthTarget(el) {
    if (!el || el.nodeType !== 1) return false;

    var href = el.getAttribute && el.getAttribute('href');
    if (href) {
      if (DERIV_AUTH.test(href)) return true;
      try {
        var u = new URL(href, location.href);
        if (u.origin === location.origin && /^\/(start-login|login|sign-?in)\/?$/i.test(u.pathname)) return true;
      } catch (e) { /* relative junk, ignore */ }
    }

    var label = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
    var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (LOGIN_TEXT.test(text) || LOGIN_TEXT.test(label)) return true;

    var tagging = [el.id, el.className, el.getAttribute('data-testid'), el.getAttribute('name')]
      .filter(function (v) { return typeof v === 'string' && v; }).join(' ');
    return LOGIN_ATTR.test(tagging) || /sign\s?in/i.test(label);
  }

  // 1 + 2. click interception, walking up from the clicked node
  function onClickCapture(e) {
    if (e.__ntHandled) return;
    var node = e.target;
    for (var depth = 0; node && depth <= MAX_ANCESTORS; depth++, node = node.parentElement) {
      if (isAuthTarget(node)) {
        // Only intercept real controls, so a heading that merely contains "Login" is ignored.
        var tag = node.tagName;
        var clickable = tag === 'A' || tag === 'BUTTON' || node.getAttribute('role') === 'button'
          || node.hasAttribute('onclick') || node.getAttribute('tabindex') === '0';
        if (!clickable) continue;
        e.__ntHandled = true;
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        goToLogin();
        return;
      }
    }
  }

  // Enter/Space on a focused fake button fires the same path as a click; covered above.
  window.addEventListener('click', onClickCapture, true);
  window.addEventListener('auxclick', onClickCapture, true);

  // 3. pop-ups aimed at Deriv's OAuth
  var nativeOpen = window.open;
  if (typeof nativeOpen === 'function') {
    window.open = function (url) {
      if (typeof url === 'string' && DERIV_AUTH.test(url)) { goToLogin(); return null; }
      return nativeOpen.apply(window, arguments);
    };
  }

  // 4. client-side route changes into the app's own login route
  ['pushState', 'replaceState'].forEach(function (name) {
    var native = history[name];
    if (typeof native !== 'function') return;
    history[name] = function (state, title, url) {
      if (typeof url === 'string' && /^\/(start-login)\/?($|[?#])/i.test(url)) {
        goToLogin();
        return;
      }
      return native.apply(history, arguments);
    };
  });
  window.addEventListener('popstate', function () {
    if (/^\/start-login\/?$/i.test(location.pathname)) goToLogin();
  });

  // Rewrite any Deriv auth anchor that is already in the markup, and any that appears later.
  function rewriteAnchors(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var anchors = scope.querySelectorAll ? scope.querySelectorAll('a[href]') : [];
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (DERIV_AUTH.test(a.getAttribute('href') || '')) a.setAttribute('href', OUR_LOGIN);
    }
    if (root && root.tagName === 'A' && DERIV_AUTH.test(root.getAttribute('href') || '')) {
      root.setAttribute('href', OUR_LOGIN);
    }
  }
  rewriteAnchors(document);
  if (typeof MutationObserver === 'function') {
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        Array.prototype.forEach.call(r.addedNodes || [], function (n) { rewriteAnchors(n); });
        if (r.type === 'attributes' && r.target) rewriteAnchors(r.target);
      });
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  } else {
    document.addEventListener('DOMContentLoaded', function () { rewriteAnchors(document); });
  }

  // If a page is reached at the app's login route by direct navigation, send it to ours.
  if (/^\/(start-login)\/?$/i.test(location.pathname)) goToLogin();
})();
