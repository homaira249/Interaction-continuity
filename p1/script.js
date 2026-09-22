/* ==========================================================================
   Multimodal Desktop: script.js
   Phase 1 (skeleton): hash router for the five sections
   --------------------------------------------------------------------------
   Plain script, no modules, so index.html also works when opened from disk.
   Everything hangs off one namespace (window.MultimodalDesktop) that later
   phases extend.
   ========================================================================== */
(() => {
  'use strict';

  const App = {
    meta: { name: 'Multimodal Desktop', version: '0.1.0', phase: 1, phases: 20 },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  /* Router ---------------------------------------------------------------
     Sections are addressed by URL hash (#workspace), so reload, back and
     forward behave as people expect. Hashes that are not section ids (for
     example the skip link's #main) are deliberately ignored. */
  const Router = (() => {
    const sections = new Map(); // id -> { id, label, view, link }
    const listeners = new Set();
    let currentId = null;

    function collect() {
      $$('[data-section-link]').forEach((link) => {
        const id = link.dataset.sectionLink;
        const view = document.getElementById(`view-${id}`);
        if (view) sections.set(id, { id, label: link.textContent.trim(), view, link });
      });
    }

    function idFromHash() {
      const raw = location.hash.replace(/^#\/?/, '');
      try { return decodeURIComponent(raw); } catch { return ''; }
    }

    // On narrow screens the nav scrolls sideways; keep the current tab in view.
    // Deliberately not scrollIntoView: Chrome treats it as the keyboard focus
    // starting point, so the first Tab after load would skip the skip link.
    function revealInNav(link) {
      const nav = link.closest('.nav');
      if (!nav || nav.scrollWidth <= nav.clientWidth) return;
      const n = nav.getBoundingClientRect();
      const l = link.getBoundingClientRect();
      if (l.left < n.left) nav.scrollLeft += l.left - n.left - 8;
      else if (l.right > n.right) nav.scrollLeft += l.right - n.right + 8;
    }

    function show(id, { moveFocus = false } = {}) {
      const next = sections.get(id);
      if (!next || id === currentId) return false;

      for (const section of sections.values()) {
        const active = section.id === id;
        section.view.hidden = !active;
        if (active) section.link.setAttribute('aria-current', 'page');
        else section.link.removeAttribute('aria-current');
      }

      const previous = currentId;
      currentId = id;
      document.title = `${next.label} | ${App.meta.name}`;
      window.scrollTo(0, 0);
      revealInNav(next.link);

      // Keyboard and screen-reader users land on the new section's heading.
      if (moveFocus) $('[tabindex="-1"]', next.view)?.focus({ preventScroll: true });

      listeners.forEach((fn) => fn(id, previous));
      return true;
    }

    function onHashChange() {
      const id = idFromHash();
      if (sections.has(id)) show(id, { moveFocus: true });
    }

    function init() {
      collect();
      const initial = idFromHash();
      show(sections.has(initial) ? initial : 'home');
      window.addEventListener('hashchange', onHashChange);
    }

    return {
      init,
      go: (id) => { if (sections.has(id)) location.hash = id; },
      current: () => currentId,
      ids: () => Array.from(sections.keys()),
      onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    };
  })();

  /* Page furniture ------------------------------------------------------- */

  function initSkipLink() {
    $('[data-skip]')?.addEventListener('click', (event) => {
      event.preventDefault();
      $('#main')?.focus();
    });
  }

  // The home illustration draws itself in once, then settles. The timer starts
  // the first time Home is actually on screen.
  function initSignalIntro() {
    const signal = $('[data-signal]');
    if (!signal) return;
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      window.setTimeout(() => signal.classList.remove('signal--intro'), 3500);
    };
    if (Router.current() === 'home') start();
    else Router.onChange((id) => { if (id === 'home') start(); });
  }

  function renderVersion() {
    const el = $('[data-version]');
    if (el) el.textContent = `Version ${App.meta.version}, phase ${App.meta.phase} of ${App.meta.phases}`;
  }

  function init() {
    Router.init();
    renderVersion();
    initSkipLink();
    initSignalIntro();
  }

  App.router = Router;
  window.MultimodalDesktop = App;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
