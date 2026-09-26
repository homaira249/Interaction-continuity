/* ==========================================================================
   Multimodal Desktop: script.js
   Phase 3 (state and accessibility): store, display settings, saved windows
   --------------------------------------------------------------------------
   Plain script, no modules, so index.html also works when opened from disk.
   Everything hangs off one namespace (window.MultimodalDesktop) that later
   phases extend.
   ========================================================================== */
(() => {
  'use strict';

  const App = {
    meta: { name: 'Multimodal Desktop', version: '0.3.0', phase: 3, phases: 20 },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  // Where an action came from: 'pointer', 'keyboard', 'voice' or (default) 'api'.
  const sourceOf = (opts) => (opts && opts.source) || 'api';

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

  /* Core helpers ---------------------------------------------------------- */

  /* Event bus: a tiny publish/subscribe hub. Windows announce what happened
     (window:open, window:move, ...) and later phases (state, logging, feedback)
     listen without the window code knowing about them. on('*', fn) hears
     everything. Every event is { type, detail, at } with at in epoch ms. */
  const Bus = (() => {
    const handlers = new Map(); // type -> Set of functions

    function off(type, fn) { handlers.get(type)?.delete(fn); }

    function on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => off(type, fn);
    }

    function emit(type, detail = {}) {
      const event = { type, detail, at: Date.now() };
      for (const key of [type, '*']) {
        for (const fn of Array.from(handlers.get(key) || [])) {
          try { fn(event); } catch (error) { console.error(`Handler for "${type}" failed`, error); }
        }
      }
      return event;
    }

    return { on, off, emit };
  })();

  /* Motion: CSS draws the animations, JS only needs to know when they are over.
     With reduced motion there is nothing to wait for, so wait() resolves at once. */
  const Motion = (() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reduced = () => query.matches || document.documentElement.dataset.motion === 'reduce';
    const wait = (ms) => (reduced() ? Promise.resolve() : new Promise((resolve) => window.setTimeout(resolve, ms)));
    return { reduced, wait };
  })();

  /* Store -------------------------------------------------------------------
     Everything the prototype remembers lives in one LocalStorage entry:

       { "v": 1, "prefs": { ... }, "workspace": { ... } }

     The app reads from an in-memory copy and writes to both. Each write
     re-reads the stored entry and changes only its own path, so a second tab,
     or a section this version does not know about, is never overwritten by a
     stale copy. There is no live sync between tabs: a change made in another
     tab appears the next time a page loads.

     If the browser blocks LocalStorage or runs out of room, the app carries on
     from memory and announces it (state:storage). Nothing here throws.
     The store knows nothing about what it holds; each owner validates its own
     section when it reads it. */
  const Store = (() => {
    const KEY = 'multimodal-desktop:v1';
    const VERSION = 1;
    const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

    let handle = null;     // the Storage object, if the browser gave us one
    let writable = false;  // false once saving fails: the rest of the session runs from memory
    let reason = '';       // '' while saving works, else 'blocked' or 'full'
    let data = {};         // the in-memory copy

    const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const copy = (value) => (value !== null && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value);
    const failureOf = (error) => (error && (error.name === 'QuotaExceededError' || error.code === 22) ? 'full' : 'blocked');

    // 'a.b' -> ['a', 'b']; null for anything empty or able to reach a prototype.
    function split(path) {
      const parts = String(path).split('.').filter(Boolean);
      return parts.length && !parts.some((part) => UNSAFE.has(part)) ? parts : null;
    }

    function getIn(root, parts) {
      let node = root;
      for (const part of parts) {
        if (!isObject(node) || !Object.prototype.hasOwnProperty.call(node, part)) return undefined;
        node = node[part];
      }
      return node;
    }

    // Sets one path, creating parents as needed. undefined deletes it instead.
    function setIn(root, parts, value) {
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!isObject(node[part])) {
          if (value === undefined) return;
          node[part] = {};
        }
        node = node[part];
      }
      const last = parts[parts.length - 1];
      if (value === undefined) delete node[last];
      else node[last] = value;
    }

    // The stored entry as an object: {} when it is missing, unreadable or not an object.
    function readStored() {
      if (!handle) return {};
      try {
        const parsed = JSON.parse(handle.getItem(KEY));
        return isObject(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }

    // Read the stored entry fresh, let `change` edit it, write it back.
    function write(change) {
      if (!handle || !writable) return false;
      try {
        const raw = readStored();
        change(raw);
        raw.v = Math.max(Number(raw.v) || 0, VERSION); // never downgrade an entry from a newer version
        handle.setItem(KEY, JSON.stringify(raw));
        return true;
      } catch (error) {
        writable = false;
        reason = failureOf(error);
        Bus.emit('state:storage', { persistent: false, reason });
        return false;
      }
    }

    function init() {
      try { handle = window.localStorage; } catch { handle = null; } // reading the property can throw when storage is blocked
      if (!handle) {
        reason = 'blocked';
      } else {
        try {
          const probe = `${KEY}:probe`;
          handle.setItem(probe, '1');
          handle.removeItem(probe);
          writable = true;
        } catch (error) {
          reason = failureOf(error);
        }
      }
      data = readStored();
    }

    // Returns a copy, so callers cannot change the store by accident.
    function get(path, fallback) {
      const parts = split(path);
      const value = parts ? getIn(data, parts) : undefined;
      return value === undefined ? fallback : copy(value);
    }

    function set(path, value) {
      const parts = split(path);
      if (!parts || value === undefined || typeof value === 'function') return false;
      let next;
      try { next = copy(value); } catch { return false; } // not JSON-safe
      const previous = getIn(data, parts);
      setIn(data, parts, next);
      write((raw) => setIn(raw, parts, copy(next)));
      Bus.emit('state:change', { path: parts.join('.'), value: copy(next), previous: copy(previous) });
      return true;
    }

    function remove(path) {
      const parts = split(path);
      const previous = parts ? getIn(data, parts) : undefined;
      if (previous === undefined) return false;
      setIn(data, parts, undefined);
      write((raw) => setIn(raw, parts, undefined));
      Bus.emit('state:change', { path: parts.join('.'), value: undefined, previous: copy(previous) });
      return true;
    }

    // Forget everything this app has stored, including sections it does not know.
    function clear() {
      data = {};
      try { if (handle) handle.removeItem(KEY); } catch { /* blocked: memory is cleared regardless */ }
      Bus.emit('state:clear', {});
    }

    return {
      init, get, set, remove, clear,
      key: KEY,
      persistent: () => writable,
      status: () => ({ persistent: writable, reason }),
    };
  })();

  /* Display settings ---------------------------------------------------------
     Four settings, each a short list of allowed values. Anything else in
     storage (an old value, a typo, hand-edited JSON) falls back to the default
     for that one setting. apply() puts them on <html>: the text size as a
     --text-scale number, the other three as data attributes the stylesheet
     reads. An inline script in index.html applies the saved values before the
     first paint, using the same lists, so the page does not flash. */
  const Prefs = (() => {
    const SPEC = {
      textScale: { values: [100, 115, 130, 150, 200], fallback: 100 },
      contrast: { values: ['standard', 'high'], fallback: 'standard' },
      motion: { values: ['system', 'reduce'], fallback: 'system' },
      transparency: { values: ['system', 'reduce'], fallback: 'system' },
    };
    const keys = Object.keys(SPEC);
    const current = {};

    const valid = (key, value) => Object.prototype.hasOwnProperty.call(SPEC, key) && SPEC[key].values.includes(value);

    function apply() {
      const root = document.documentElement;
      if (current.textScale === SPEC.textScale.fallback) root.style.removeProperty('--text-scale');
      else root.style.setProperty('--text-scale', String(current.textScale / 100));
      const mark = (name, value) => { if (value) root.setAttribute(name, value); else root.removeAttribute(name); };
      mark('data-contrast', current.contrast === 'high' ? 'high' : '');
      mark('data-motion', current.motion === 'reduce' ? 'reduce' : '');
      mark('data-transparency', current.transparency === 'reduce' ? 'reduce' : '');
    }

    function init() {
      keys.forEach((key) => {
        const stored = Store.get(`prefs.${key}`);
        current[key] = valid(key, stored) ? stored : SPEC[key].fallback;
      });
      apply();
    }

    // Returns true when the value was accepted and actually changed something.
    function set(key, value, opts) {
      if (!valid(key, value) || current[key] === value) return false;
      const previous = current[key];
      current[key] = value;
      Store.set(`prefs.${key}`, value);
      apply();
      Bus.emit('prefs:change', { key, value, previous, source: sourceOf(opts) });
      return true;
    }

    function reset(opts) {
      const previous = { ...current };
      keys.forEach((key) => { current[key] = SPEC[key].fallback; });
      // Remove only the four settings, so a field this version does not know survives a reset.
      keys.forEach((key) => Store.remove(`prefs.${key}`));
      const rest = Store.get('prefs');
      if (rest !== undefined && rest !== null && typeof rest === 'object' && !Object.keys(rest).length) Store.remove('prefs');
      apply();
      Bus.emit('prefs:reset', { previous, source: sourceOf(opts) });
    }

    return {
      init, set, reset, keys,
      get: (key) => (key === undefined ? { ...current } : current[key]),
      options: (key) => (SPEC[key] ? SPEC[key].values.slice() : []),
      fallback: (key) => (SPEC[key] ? SPEC[key].fallback : undefined),
    };
  })();

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Never throws: when the range is inverted, the minimum wins.
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

  // el('div', { class: 'x', text: 'Hi' }, child, child): a small DOM builder.
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value == null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child != null && child !== false) node.append(child);
    return node;
  }

  // An icon from the sprite in index.html.
  function icon(id) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#${id}`);
    svg.append(use);
    return svg;
  }

  /* Window manager ---------------------------------------------------------
     Floating windows on the Workspace desktop, plus a dock that lists them.

     Each window keeps its normal bounds (x, y, w, h) in pixels inside the work
     area. Those bounds survive maximizing and minimizing, and the windows
     themselves stay in the page when another section is showing, so nothing is
     lost when the user leaves the Workspace and comes back.

     Whichever non-minimized window is highest in the stack is the active one;
     active, z-order, dock state and the empty state are all derived in
     settle(). Methods return a snapshot of the window, or null if it is gone.
     Pass { source } ('pointer', 'keyboard' or 'api') to say where an action
     came from; it is passed along on the bus. */
  const WM = (() => {
    // Sizes are in rem so they follow the text-size setting: at the default
    // text size these are 280 x 180 px minimum and 520 x 400 px for a new window.
    const MIN_REM_W = 17.5;
    const MIN_REM_H = 11.25;
    const DEFAULT_REM_W = 32.5;
    const DEFAULT_REM_H = 25;
    const MAX_DIM = 10000;   // stands in for the work area until it has been measured
    const MAX_RESTORE = 24;  // most windows brought back from storage
    const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

    const windows = new Map(); // id -> record
    const stack = [];          // ids, bottom to top
    const kinds = new Map();   // kind -> builder(body, { id, props }), for windows that can be saved
    let ref = null;            // { desktop, layer, dock, dockList, empty }
    let area = { w: 960, h: 560 }; // last measured work area, kept while the view is hidden
    let areaKnown = false;     // false until the work area has really been measured
    let unit = 16;             // pixels per rem, as last measured
    let gesture = null;        // the drag or resize in progress, if any
    let nextId = 0;

    const sourceOfClick = (event) => (event.detail === 0 ? 'keyboard' : 'pointer');

    /* Geometry ---------------------------------------------------------- */

    // The Workspace can be hidden (another section showing, or the page opened
    // on #home), and a hidden element measures 0 x 0. Until a real measurement
    // exists, saved windows are not squeezed into the placeholder area.
    function measure() {
      const w = ref.layer.clientWidth;
      const h = ref.layer.clientHeight;
      unit = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      if (w > 0 && h > 0) {
        area = { w, h };
        areaKnown = true;
      }
      return area;
    }

    const limitW = () => (areaKnown ? area.w : MAX_DIM);
    const limitH = () => (areaKnown ? area.h : MAX_DIM);
    const minW = () => Math.min(Math.round(MIN_REM_W * unit), limitW());
    const minH = () => Math.min(Math.round(MIN_REM_H * unit), limitH());

    // Keep a rectangle fully inside the work area, never smaller than the minimum.
    function fit({ x, y, w, h }) {
      const width = clamp(Math.round(w), minW(), limitW());
      const height = clamp(Math.round(h), minH(), limitH());
      return {
        w: width,
        h: height,
        x: clamp(Math.round(x), 0, limitW() - width),
        y: clamp(Math.round(y), 0, limitH() - height),
      };
    }

    // Resize from one edge or corner. Each moving edge stops at the work area
    // or at the minimum size, so the opposite edge never slides.
    function solveResize(o, edge, dx, dy) {
      let left = o.x;
      let top = o.y;
      let right = o.x + o.w;
      let bottom = o.y + o.h;
      if (edge.includes('e')) right = clamp(right + dx, left + minW(), limitW());
      if (edge.includes('w')) left = clamp(left + dx, 0, right - minW());
      if (edge.includes('s')) bottom = clamp(bottom + dy, top + minH(), limitH());
      if (edge.includes('n')) top = clamp(top + dy, 0, bottom - minH());
      return { x: left, y: top, w: right - left, h: bottom - top };
    }

    function place(rec, bounds) {
      Object.assign(rec, fit(bounds));
      const style = rec.el.style;
      style.setProperty('--nx', `${rec.x}px`);
      style.setProperty('--ny', `${rec.y}px`);
      style.setProperty('--nw', `${rec.w}px`);
      style.setProperty('--nh', `${rec.h}px`);
    }

    // The work area or the text size changed (browser resized, the Workspace
    // just appeared, or a new text size was chosen): fit every window again.
    function refit() {
      const before = { w: area.w, h: area.h, unit, known: areaKnown };
      measure();
      if (!areaKnown) return;
      if (before.known && before.w === area.w && before.h === area.h && before.unit === unit) return;
      windows.forEach((rec) => place(rec, rec));
    }

    // Where a window should shrink to or grow from: the middle of its dock item.
    function aim(rec) {
      const dock = rec.dockBtn.getBoundingClientRect();
      const layer = ref.layer.getBoundingClientRect();
      const w = rec.maximized ? layer.width : rec.w;
      const h = rec.maximized ? layer.height : rec.h;
      const style = rec.el.style;
      style.setProperty('--to-x', `${Math.round(dock.left + dock.width / 2 - layer.left - w / 2)}px`);
      style.setProperty('--to-y', `${Math.round(dock.top + dock.height / 2 - layer.top - h / 2)}px`);
    }

    /* State ------------------------------------------------------------- */

    function topId() {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (!windows.get(stack[i]).minimized) return stack[i];
      }
      return null;
    }

    function snapshot(rec) {
      return {
        id: rec.id,
        title: rec.title,
        x: rec.x,
        y: rec.y,
        w: rec.w,
        h: rec.h,
        minimized: rec.minimized,
        maximized: rec.maximized,
        focused: rec.id === topId(),
        z: stack.indexOf(rec.id) + 1,
      };
    }

    function recordFor(node) {
      const holder = node instanceof Element ? node.closest('.window') : null;
      const rec = holder ? windows.get(holder.dataset.windowId) : undefined;
      // The element must be the record's own: a window that is still fading out
      // can share an id with its replacement.
      return rec && rec.el === holder ? rec : undefined;
    }

    // Does keyboard focus belong to this window? Safari and Firefox on macOS do
    // not focus a button when it is clicked, so "nothing focused" counts too.
    function ownsFocus(rec) {
      const active = document.activeElement;
      return !active || active === document.body || rec.el.contains(active);
    }

    function raise(rec) {
      const i = stack.indexOf(rec.id);
      if (i === stack.length - 1) return;
      if (i >= 0) stack.splice(i, 1);
      stack.push(rec.id);
    }

    // Redraw everything that is derived from the stack and the minimized flags.
    function settle() {
      const active = topId();
      stack.forEach((id, i) => {
        const rec = windows.get(id);
        rec.el.style.setProperty('--z', i + 1);
        rec.el.classList.toggle('is-focused', id === active);
        rec.dockBtn.setAttribute('aria-pressed', String(id === active));
        rec.dockBtn.dataset.state = rec.minimized ? 'minimized' : 'open';
        rec.status.textContent = rec.minimized ? ', minimized' : '';
      });
      const any = windows.size > 0;
      ref.empty.hidden = any;
      ref.dock.hidden = !any;
    }

    function focusRec(rec, { dom = true, source = 'api' } = {}) {
      if (rec.closing) return;
      if (rec.minimized) { restore(rec.id, { source }); return; }
      const changed = topId() !== rec.id;
      if (changed) {
        raise(rec);
        settle();
      }
      if (dom && !rec.el.contains(document.activeElement)) rec.el.focus({ preventScroll: true });
      if (changed) Bus.emit('window:focus', { id: rec.id, title: rec.title, source });
    }

    // After the focused window goes away, hand focus to the next thing in line.
    function refocusAfterClose() {
      const top = topId();
      if (top) { windows.get(top).el.focus({ preventScroll: true }); return; }
      const last = stack[stack.length - 1];
      if (last) { windows.get(last).dockBtn.focus({ preventScroll: true }); return; }
      ref.empty.querySelector('button')?.focus({ preventScroll: true });
    }

    function syncMaximizeButton(rec) {
      const label = rec.maximized ? 'Restore' : 'Maximize';
      rec.maxBtn.setAttribute('aria-label', `${label} ${rec.title}`);
      rec.maxBtn.querySelector('use').setAttribute('href', rec.maximized ? '#i-restore' : '#i-maximize');
    }

    /* Public actions ---------------------------------------------------- */

    // Options: id, title, icon, content (function(body, { id, props }), Node or text),
    // x, y, w, h, source. To make a window that is saved and restored, give it a
    // registered kind (see register) and, if it needs them, plain-data props.
    // quiet, minimized and maximized are for restoring: a quiet window opens
    // without animation, without taking focus and without a window:open event.
    function open(options = {}) {
      if (!ref) return null;
      const known = options.id && windows.get(options.id);
      if (known) return restore(known.id, options);

      measure();
      let id = options.id;
      if (!id) {
        do { id = `window-${(nextId += 1)}`; } while (windows.has(id));
      }
      const title = options.title || 'Untitled window';
      const iconId = options.icon || 'i-window';
      const kind = typeof options.kind === 'string' && kinds.has(options.kind) ? options.kind : '';
      const quiet = options.quiet === true;

      // New windows cascade down and to the right of the middle of the desktop.
      const size = fit({
        x: 0,
        y: 0,
        w: options.w ?? Math.min(DEFAULT_REM_W * unit, area.w - 32),
        h: options.h ?? Math.min(DEFAULT_REM_H * unit, area.h - 32),
      });
      const slackX = area.w - size.w;
      const slackY = area.h - size.h;
      const step = (windows.size % 6) * 28;
      const bounds = {
        w: size.w,
        h: size.h,
        x: options.x ?? Math.round(slackX / 2 - Math.min(70, slackX / 4) + step),
        y: options.y ?? Math.round(slackY / 2 - Math.min(50, slackY / 4) + step),
      };

      const titleId = `window-title-${id}`;
      const status = el('span', { class: 'sr-only' });
      const dockBtn = el(
        'button',
        { class: 'dock__item', type: 'button', 'aria-pressed': 'false', 'data-window-id': id },
        icon(iconId),
        el('span', { class: 'dock__label', text: title }),
        status,
      );
      const control = (action, glyph, verb, extra = '') => el(
        'button',
        { class: `window__btn ${extra}`.trim(), type: 'button', 'data-action': action, 'aria-label': `${verb} ${title}` },
        icon(glyph),
      );
      const minBtn = control('minimize', 'i-minimize', 'Minimize');
      const maxBtn = control('maximize', 'i-maximize', 'Maximize');
      const closeBtn = control('close', 'i-close', 'Close', 'window__btn--close');
      const body = el('div', { class: 'window__body' });
      const node = el(
        'div',
        {
          class: quiet ? 'window' : 'window is-opening',
          role: 'dialog',
          'aria-modal': 'false',
          'aria-labelledby': titleId,
          tabindex: '-1',
          'data-window-id': id,
        },
        el(
          'div',
          { class: 'window__bar' },
          el('span', { class: 'window__icon' }, icon(iconId)),
          el('span', { class: 'window__title', id: titleId, text: title }),
          el('div', { class: 'window__controls' }, minBtn, maxBtn, closeBtn),
        ),
        body,
        EDGES.map((edge) => el('span', { class: `window__resize window__resize--${edge}`, 'data-edge': edge, 'aria-hidden': 'true' })),
      );

      // A window of a registered kind with no content of its own is built by its kind.
      const build = typeof options.content === 'function'
        ? options.content
        : (options.content == null && kind ? kinds.get(kind) : null);
      if (build) build(body, { id, props: options.props });
      else if (options.content instanceof Node) body.append(options.content);
      else if (options.content != null) body.textContent = String(options.content);

      const rec = {
        id, title, kind, props: options.props, el: node, minBtn, maxBtn, closeBtn, dockBtn, dockLi: el('li', {}, dockBtn), status,
        x: 0, y: 0, w: 0, h: 0, minimized: false, maximized: false, closing: false, token: 0,
      };
      place(rec, bounds);
      if (options.minimized === true) {
        rec.minimized = true;
        node.classList.add('is-minimizing');
        node.hidden = true;
      }
      if (options.maximized === true) {
        rec.maximized = true;
        node.classList.add('is-maximized');
        syncMaximizeButton(rec);
      }
      windows.set(id, rec);
      stack.push(id);
      ref.layer.append(node);
      ref.dockList.append(rec.dockLi);
      settle();
      if (quiet) return snapshot(rec);
      node.focus({ preventScroll: true });
      Bus.emit('window:open', { id, title, x: rec.x, y: rec.y, w: rec.w, h: rec.h, source: sourceOf(options) });
      Motion.wait(280).then(() => node.classList.remove('is-opening'));
      return snapshot(rec);
    }

    function close(id, opts = {}) {
      const rec = windows.get(id);
      if (!rec || rec.closing) return null;
      endGesture(rec, { cancelled: true });
      const hadFocus = ownsFocus(rec);
      const last = snapshot(rec);
      rec.closing = true;
      rec.token += 1;
      windows.delete(id);
      stack.splice(stack.indexOf(id), 1);
      rec.dockLi.remove();
      rec.el.classList.add('is-closing');
      settle();
      Bus.emit('window:close', { id, title: rec.title, source: sourceOf(opts) });
      if (hadFocus) refocusAfterClose();
      Motion.wait(180).then(() => rec.el.remove());
      return last;
    }

    function focus(id, opts = {}) {
      const rec = windows.get(id);
      if (!rec || rec.closing) return null;
      focusRec(rec, { dom: opts.dom !== false, source: sourceOf(opts) });
      return snapshot(rec);
    }

    function minimize(id, opts = {}) {
      const rec = windows.get(id);
      if (!rec || rec.closing) return null;
      if (rec.minimized) return snapshot(rec);
      endGesture(rec, { cancelled: true });
      const hadFocus = ownsFocus(rec);
      rec.minimized = true;
      const token = (rec.token += 1);
      aim(rec);
      rec.el.classList.add('is-minimizing');
      settle();
      if (hadFocus) rec.dockBtn.focus({ preventScroll: true });
      Bus.emit('window:minimize', { id, title: rec.title, source: sourceOf(opts) });
      // Hide it for good once it has shrunk into the dock (unless it came back meanwhile).
      Motion.wait(280).then(() => { if (rec.token === token && rec.minimized) rec.el.hidden = true; });
      return snapshot(rec);
    }

    function restore(id, opts = {}) {
      const rec = windows.get(id);
      if (!rec || rec.closing) return null;
      if (!rec.minimized) {
        focusRec(rec, { source: sourceOf(opts) });
        return snapshot(rec);
      }
      rec.minimized = false;
      rec.token += 1;
      aim(rec);
      rec.el.hidden = false;
      void rec.el.offsetWidth; // let the browser see the shrunken state first, so it animates back out
      rec.el.classList.remove('is-minimizing');
      raise(rec);
      settle();
      rec.el.focus({ preventScroll: true });
      Bus.emit('window:restore', { id, title: rec.title, source: sourceOf(opts) });
      return snapshot(rec);
    }

    // Toggles by default; { on: true } or { on: false } sets it explicitly.
    function maximize(id, opts = {}) {
      const rec = windows.get(id);
      if (!rec || rec.closing) return null;
      if (rec.minimized) restore(id, opts);
      const on = typeof opts.on === 'boolean' ? opts.on : !rec.maximized;
      if (on !== rec.maximized) {
        rec.maximized = on;
        rec.el.classList.toggle('is-maximized', on);
        syncMaximizeButton(rec);
        Bus.emit(on ? 'window:maximize' : 'window:unmaximize', { id, title: rec.title, source: sourceOf(opts) });
      }
      return snapshot(rec);
    }

    // Moving and resizing change the normal bounds. For a maximized window they
    // take effect when it is restored.
    function moveTo(id, x, y, opts = {}) {
      const rec = windows.get(id);
      if (!rec || rec.closing) return null;
      const from = { x: rec.x, y: rec.y };
      measure();
      place(rec, { x, y, w: rec.w, h: rec.h });
      if (rec.x !== from.x || rec.y !== from.y) {
        Bus.emit('window:move', { id, title: rec.title, x: rec.x, y: rec.y, from, source: sourceOf(opts) });
      }
      return snapshot(rec);
    }

    function moveBy(id, dx, dy, opts = {}) {
      const rec = windows.get(id);
      return rec && !rec.closing ? moveTo(id, rec.x + dx, rec.y + dy, opts) : null;
    }

    function emitResize(rec, from, edge, source) {
      if (rec.w === from.w && rec.h === from.h && rec.x === from.x && rec.y === from.y) return;
      Bus.emit('window:resize', { id: rec.id, title: rec.title, x: rec.x, y: rec.y, w: rec.w, h: rec.h, from, edge, source });
    }

    function resizeTo(id, w, h, opts = {}) {
      const rec = windows.get(id);
      if (!rec || rec.closing) return null;
      const from = { x: rec.x, y: rec.y, w: rec.w, h: rec.h };
      measure();
      place(rec, solveResize(from, 'se', w - rec.w, h - rec.h));
      emitResize(rec, from, 'se', sourceOf(opts));
      return snapshot(rec);
    }

    function resizeBy(id, dw, dh, opts = {}) {
      const rec = windows.get(id);
      return rec && !rec.closing ? resizeTo(id, rec.w + dw, rec.h + dh, opts) : null;
    }

    /* Saving and restoring ----------------------------------------------------
       Only windows opened with a registered kind are saved: the kind says how
       to rebuild the content. Windows opened with ad-hoc content are left out. */

    function register(kind, builder) {
      if (typeof kind !== 'string' || !kind || typeof builder !== 'function') return false;
      kinds.set(kind, builder);
      return true;
    }

    // The saved windows, bottom of the stack first.
    function serialize() {
      return stack
        .map((id) => windows.get(id))
        .filter((rec) => rec.kind)
        .map((rec) => {
          const saved = {
            id: rec.id, kind: rec.kind, title: rec.title,
            x: rec.x, y: rec.y, w: rec.w, h: rec.h,
            minimized: rec.minimized, maximized: rec.maximized,
          };
          if (rec.props !== undefined) saved.props = rec.props;
          return saved;
        });
    }

    // Storage can hold anything, so every field is checked. An entry that makes
    // no sense is skipped; a field that makes no sense falls back to its default.
    function cleanEntry(raw) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
      if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id) || !kinds.has(raw.kind)) return null;
      const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
      const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 120) : '';
      return {
        id: raw.id,
        kind: raw.kind,
        title: title || undefined,
        x: number(raw.x),
        y: number(raw.y),
        w: number(raw.w),
        h: number(raw.h),
        minimized: raw.minimized === true,
        maximized: raw.maximized === true,
        props: raw.props,
      };
    }

    // Bring saved windows back in stack order, quietly. Returns how many came back.
    function restoreAll(list) {
      if (!ref || !Array.isArray(list)) return 0;
      let count = 0;
      for (const raw of list.slice(0, MAX_RESTORE)) {
        const entry = cleanEntry(raw);
        if (!entry || windows.has(entry.id)) continue;
        open({ ...entry, quiet: true });
        count += 1;
      }
      if (count) Bus.emit('workspace:restored', { count });
      return count;
    }

    // Close every window. { quiet: true } skips the animation, the events and the focus hand-off.
    function closeAll(opts = {}) {
      if (!ref) return 0;
      const ids = stack.slice().reverse();
      if (!opts.quiet) {
        ids.forEach((id) => close(id, opts));
        return ids.length;
      }
      if (gesture) endGesture(gesture.rec, { cancelled: true });
      ids.forEach((id) => {
        const rec = windows.get(id);
        rec.closing = true;
        rec.token += 1;
        rec.dockLi.remove();
        rec.el.remove();
      });
      windows.clear();
      stack.length = 0;
      settle();
      return ids.length;
    }

    /* Pointer gestures: drag the title bar, drag an edge or corner ----------
       Listeners sit on the document only while a gesture runs, so the pointer
       can leave the window (or the browser) mid-drag without losing it. */

    function startGesture(rec, event, kind, edge) {
      if (gesture) return;
      measure();
      gesture = {
        rec, kind, edge,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: { x: rec.x, y: rec.y, w: rec.w, h: rec.h },
        moved: false,
      };
      rec.el.classList.add(kind === 'move' ? 'is-dragging' : 'is-resizing');
      ref.desktop.classList.add('is-gesturing');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerUp);
    }

    function onPointerMove(event) {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const { rec, kind, edge, origin } = gesture;
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      gesture.moved = gesture.moved || dx !== 0 || dy !== 0;
      place(rec, kind === 'move' ? { x: origin.x + dx, y: origin.y + dy, w: origin.w, h: origin.h } : solveResize(origin, edge, dx, dy));
    }

    function onPointerUp(event) {
      if (gesture && event.pointerId === gesture.pointerId) endGesture(gesture.rec);
    }

    // One bus event per finished gesture, not one per pointer move.
    function endGesture(rec, { cancelled = false } = {}) {
      if (!gesture || gesture.rec !== rec) return;
      const { kind, edge, origin } = gesture;
      gesture = null;
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      rec.el.classList.remove('is-dragging', 'is-resizing');
      ref.desktop.classList.remove('is-gesturing');
      if (cancelled) return;
      if (kind === 'move') {
        if (rec.x !== origin.x || rec.y !== origin.y) {
          Bus.emit('window:move', { id: rec.id, title: rec.title, x: rec.x, y: rec.y, from: { x: origin.x, y: origin.y }, source: 'pointer' });
        }
      } else {
        emitResize(rec, origin, edge, 'pointer');
      }
    }

    /* Wiring ------------------------------------------------------------ */

    function onPointerDown(event) {
      const rec = recordFor(event.target);
      if (!rec) return;
      // Pressing anywhere on a window brings it to the front. The browser moves
      // keyboard focus on its own, so only the stacking is handled here.
      focusRec(rec, { dom: false, source: 'pointer' });
      if (event.button !== 0 || rec.maximized) return;
      const handle = event.target.closest('.window__resize');
      if (handle) { startGesture(rec, event, 'resize', handle.dataset.edge); return; }
      if (event.target.closest('.window__bar') && !event.target.closest('.window__btn')) startGesture(rec, event, 'move');
    }

    function onClick(event) {
      const button = event.target.closest('.window__btn');
      const rec = button && recordFor(button);
      if (!rec) return;
      const opts = { source: sourceOfClick(event) };
      const action = button.dataset.action;
      if (action === 'minimize') minimize(rec.id, opts);
      else if (action === 'maximize') maximize(rec.id, opts);
      else if (action === 'close') close(rec.id, opts);
    }

    function onDoubleClick(event) {
      if (!event.target.closest('.window__bar') || event.target.closest('.window__btn')) return;
      const rec = recordFor(event.target);
      if (rec) maximize(rec.id, { source: 'pointer' });
    }

    // Tabbing into a window (or any other way of focusing inside it) activates it.
    function onFocusIn(event) {
      const rec = recordFor(event.target);
      if (rec && !rec.minimized) focusRec(rec, { dom: false, source: 'keyboard' });
    }

    // The dock item is a toggle: restore if minimized, minimize if active, else activate.
    function onDockClick(event) {
      const button = event.target.closest('.dock__item');
      const rec = button && windows.get(button.dataset.windowId);
      if (!rec) return;
      const opts = { source: sourceOfClick(event) };
      if (rec.minimized) restore(rec.id, opts);
      else if (rec.id === topId()) minimize(rec.id, opts);
      else focusRec(rec, opts);
    }

    function init(refs) {
      ref = refs;
      measure();
      ref.layer.addEventListener('pointerdown', onPointerDown);
      ref.layer.addEventListener('click', onClick);
      ref.layer.addEventListener('dblclick', onDoubleClick);
      ref.layer.addEventListener('focusin', onFocusIn);
      ref.dockList.addEventListener('click', onDockClick);
      if ('ResizeObserver' in window) new ResizeObserver(refit).observe(ref.layer);
      else window.addEventListener('resize', refit);
      // A new text size changes what a rem is, and with it the minimum window size.
      Bus.on('prefs:change', refit);
      Bus.on('prefs:reset', refit);
      settle();
    }

    return {
      init,
      open, close, focus, minimize, restore, maximize,
      moveTo, moveBy, resizeTo, resizeBy,
      register, serialize, restoreAll, closeAll,
      get: (id) => (windows.has(id) ? snapshot(windows.get(id)) : null),
      list: () => Array.from(windows.values()).map(snapshot),
      focused: () => topId(),
      area: () => ({ ...area }),
    };
  })();

  /* Workspace ---------------------------------------------------------------
     The Workspace remembers its windows: where they are, how big, whether they
     are minimized or maximized, and which is in front. After any window event
     the saved list is rewritten (after a short pause, so a drag is one write),
     and it is written at once when the page is hidden or closed.

     On the next load the windows come back quietly: no focus is taken and no
     window:* events fire, so a restore can never be mistaken for something the
     user did. Windows opened with ad-hoc content are not saved. */
  const Workspace = (() => {
    const SAVE_DELAY = 300;
    const counters = { sample: 0 }; // how many sample windows have been opened, so titles do not repeat
    let timer = 0;

    // Until the real tasks arrive, sample windows let people try the window controls.
    function sampleContent() {
      return el(
        'div',
        { class: 'sample' },
        el('p', { text: 'Drag the title bar to move this window. Drag any edge or corner to resize it.' }),
        el(
          'ul',
          { class: 'sample__tips' },
          el('li', { text: 'Double-click the title bar, or use the square button, to maximize and restore.' }),
          el('li', { text: 'Minimize sends the window to the dock. Select it there to bring it back.' }),
          el('li', { text: 'Reload the page: your windows come back where you left them.' }),
          el('li', { text: 'Moving windows by keyboard and by voice arrives in later phases.' }),
        ),
        el('button', { class: 'btn btn--ghost', type: 'button', 'data-open-sample': '', text: 'Open another sample window' }),
      );
    }
    WM.register('sample', (body) => body.append(sampleContent()));

    function openSample(opts) {
      do { counters.sample += 1; } while (WM.get(`sample-${counters.sample}`));
      return WM.open({ id: `sample-${counters.sample}`, kind: 'sample', title: `Sample window ${counters.sample}`, ...opts });
    }

    function save() {
      timer = 0;
      Store.set('workspace', { windows: WM.serialize(), counters: { ...counters } });
    }

    function schedule() {
      window.clearTimeout(timer);
      timer = window.setTimeout(save, SAVE_DELAY);
    }

    // Write a pending save now.
    function flush() {
      if (!timer) return;
      window.clearTimeout(timer);
      save();
    }

    function cancel() {
      window.clearTimeout(timer);
      timer = 0;
    }

    // Brings saved windows back. Returns how many.
    function restore() {
      const saved = Store.get('workspace');
      if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return 0;
      const count = saved.counters && Number.isInteger(saved.counters.sample) ? saved.counters.sample : 0;
      counters.sample = clamp(count, 0, 9999);
      return WM.restoreAll(saved.windows);
    }

    // Forget the windows: close them quietly and drop any save that was waiting.
    function clear() {
      cancel();
      WM.closeAll({ quiet: true });
      counters.sample = 0;
    }

    function init() {
      Bus.on('*', (event) => { if (event.type.startsWith('window:')) schedule(); });
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    }

    return { init, restore, clear, flush, openSample, counter: () => counters.sample };
  })();

  function initWorkspace() {
    const desktop = $('#desktop');
    if (!desktop) return;
    WM.init({ desktop, layer: $('#windows'), dock: $('#dock'), dockList: $('#dock-list'), empty: $('#desktop-empty') });
    Workspace.init();
    Workspace.restore();
    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-open-sample]')) Workspace.openSample({ source: event.detail === 0 ? 'keyboard' : 'pointer' });
    });
  }

  /* Accessibility panel ------------------------------------------------------
     A button in the top bar opens a small non-modal dialog with the display
     settings. It is built here, not in the HTML, because it only means anything
     with scripting on. Native radio buttons do the work: arrow keys, one tab
     stop per group, and announcements all come from the browser.

     It closes on Escape (focus returns to its button), on a press outside it,
     when keyboard focus leaves it, and when the section changes. */
  const A11y = (() => {
    const GROUPS = [
      {
        key: 'textScale',
        legend: 'Text size',
        hint: 'Makes text and controls larger throughout.',
        labels: { 100: '100%', 115: '115%', 130: '130%', 150: '150%', 200: '200%' },
      },
      {
        key: 'contrast',
        legend: 'Contrast',
        hint: 'Brighter text and stronger outlines.',
        labels: { standard: 'Standard', high: 'High' },
      },
      {
        key: 'motion',
        legend: 'Motion',
        hint: 'Reduce turns off animations and transitions.',
        labels: { system: 'Follow device', reduce: 'Reduce' },
      },
      {
        key: 'transparency',
        legend: 'Transparency',
        hint: 'Solid swaps frosted glass for plain panels.',
        labels: { system: 'Follow device', reduce: 'Solid' },
      },
    ];
    const DEVICE_NOTES = [
      { key: 'motion', query: '(prefers-reduced-motion: reduce)', text: 'Your device already asks for reduced motion, so motion is reduced either way.' },
      { key: 'transparency', query: '(prefers-reduced-transparency: reduce)', text: 'Your device already asks for reduced transparency, so panels are solid either way.' },
    ];

    let root = null;
    let toggle = null;
    let panel = null;
    let inputSource = 'pointer';
    const parts = {}; // note, status, clearButton, confirm, ...

    const isOpen = () => Boolean(panel) && !panel.hidden;

    function field(group) {
      const hintId = `a11y-hint-${group.key}`;
      const options = Prefs.options(group.key).map((value) => el(
        'label',
        { class: 'seg__opt' },
        el('input', { class: 'seg__input', type: 'radio', name: `a11y-${group.key}`, value: String(value), 'data-pref': group.key }),
        el('span', { class: 'seg__text', text: group.labels[value] }),
      ));
      const set = el(
        'fieldset',
        { class: 'a11y__group', 'aria-describedby': hintId },
        el('legend', { class: 'a11y__legend', text: group.legend }),
        el('p', { class: 'a11y__hint', id: hintId, text: group.hint }),
        el('div', { class: 'seg' }, options),
      );
      const note = DEVICE_NOTES.find((n) => n.key === group.key);
      if (note) {
        parts[`device-${group.key}`] = el('p', { class: 'a11y__device', text: note.text, hidden: true });
        set.append(parts[`device-${group.key}`]);
      }
      return set;
    }

    function build() {
      parts.note = el('p', { class: 'a11y__note' });
      parts.status = el('p', { class: 'a11y__status', role: 'status' });
      parts.clearButton = el('button', { class: 'a11y__btn a11y__btn--danger', type: 'button', 'data-a11y': 'clear', text: 'Clear saved data' });
      parts.confirm = el(
        'div',
        { class: 'a11y__confirm', role: 'group', 'aria-labelledby': 'a11y-confirm-text', hidden: true },
        el('p', { id: 'a11y-confirm-text', text: 'This removes your display settings and open windows from this browser. It cannot be undone.' }),
        el(
          'div',
          { class: 'a11y__row' },
          el('button', { class: 'a11y__btn', type: 'button', 'data-a11y': 'clear-cancel', text: 'Cancel' }),
          el('button', { class: 'a11y__btn a11y__btn--danger', type: 'button', 'data-a11y': 'clear-confirm', text: 'Yes, clear saved data' }),
        ),
      );

      toggle = el(
        'button',
        { class: 'a11y__toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'a11y-panel', 'aria-haspopup': 'dialog' },
        icon('i-access'),
        el('span', { class: 'a11y__label', text: 'Accessibility' }),
      );
      panel = el(
        'div',
        { class: 'a11y__panel', id: 'a11y-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'a11y-title', tabindex: '-1', hidden: true },
        el('h2', { class: 'a11y__title', id: 'a11y-title', text: 'Accessibility settings' }),
        el('p', { class: 'a11y__lede', text: 'Changes apply straight away and are remembered in this browser.' }),
        GROUPS.map(field),
        parts.note,
        el(
          'div',
          { class: 'a11y__actions' },
          el('button', { class: 'a11y__btn', type: 'button', 'data-a11y': 'reset', text: 'Reset display settings' }),
          parts.clearButton,
        ),
        parts.confirm,
        parts.status,
      );
      root = el('div', { class: 'a11y' }, toggle, panel);
      return root;
    }

    // Show the current settings in the controls.
    function sync() {
      $$('.seg__input', panel).forEach((input) => {
        input.checked = String(Prefs.get(input.dataset.pref)) === input.value;
      });
      DEVICE_NOTES.forEach((n) => {
        parts[`device-${n.key}`].hidden = !window.matchMedia(n.query).matches;
      });
      const { persistent, reason } = Store.status();
      parts.note.textContent = persistent
        ? 'Saved only in this browser. Nothing is sent anywhere.'
        : `This browser ${reason === 'full' ? 'has no room left to save settings' : 'is not allowing settings to be saved'}, so changes last until you reload or close this page.`;
    }

    function say(text) { parts.status.textContent = text; }

    function showConfirm(on) {
      parts.confirm.hidden = !on;
      parts.clearButton.hidden = on;
    }

    function open(opts) {
      if (isOpen()) return;
      sync();
      say('');
      showConfirm(false);
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      panel.focus({ preventScroll: true });
      Bus.emit('a11y:open', { source: sourceOf(opts) });
    }

    function close(opts = {}) {
      if (!isOpen()) return;
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      showConfirm(false);
      if (opts.restoreFocus) toggle.focus({ preventScroll: true });
      Bus.emit('a11y:close', { source: sourceOf(opts) });
    }

    function onChange(event) {
      const input = event.target.closest('.seg__input');
      if (!input) return;
      const key = input.dataset.pref;
      const value = Prefs.options(key).find((option) => String(option) === input.value);
      Prefs.set(key, value, { source: inputSource });
    }

    function onAction(event) {
      const button = event.target.closest('[data-a11y]');
      if (!button) return;
      const source = event.detail === 0 ? 'keyboard' : 'pointer';
      switch (button.dataset.a11y) {
        case 'reset':
          Prefs.reset({ source });
          sync();
          say('Display settings reset to their defaults.');
          break;
        case 'clear':
          showConfirm(true);
          say('');
          parts.confirm.querySelector('[data-a11y="clear-cancel"]').focus(); // Cancel first, so a stray Enter cannot clear anything
          break;
        case 'clear-cancel':
          showConfirm(false);
          parts.clearButton.focus();
          break;
        case 'clear-confirm':
          Workspace.clear();
          Prefs.reset({ source });
          Store.clear();
          sync();
          showConfirm(false);
          parts.clearButton.focus();
          say('Saved data cleared.');
          break;
        default:
      }
    }

    function init() {
      const tools = $('#topbar-tools');
      if (!tools) return;
      tools.append(build());

      toggle.addEventListener('click', (event) => {
        if (isOpen()) close();
        else open({ source: event.detail === 0 ? 'keyboard' : 'pointer' });
      });
      panel.addEventListener('change', onChange);
      panel.addEventListener('click', onAction);
      // Remember how the last input arrived, so a change can say keyboard or pointer.
      panel.addEventListener('keydown', () => { inputSource = 'keyboard'; }, true);
      panel.addEventListener('pointerdown', () => { inputSource = 'pointer'; }, true);

      root.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !isOpen()) return;
        event.preventDefault();
        close({ restoreFocus: true, source: 'keyboard' });
      });
      root.addEventListener('focusout', (event) => {
        const next = event.relatedTarget;
        if (isOpen() && next instanceof Element && !root.contains(next)) close({ source: 'keyboard' });
      });
      document.addEventListener('pointerdown', (event) => {
        if (isOpen() && !root.contains(event.target)) close({ source: 'pointer' });
      });
      Router.onChange(() => close({ source: 'api' }));

      // Keep the controls honest if a setting changes some other way.
      Bus.on('prefs:change', () => { if (isOpen()) sync(); });
      Bus.on('prefs:reset', () => { if (isOpen()) sync(); });
      Bus.on('state:storage', () => { if (isOpen()) sync(); });
    }

    return { init, open: (opts) => open(opts), close: (opts) => close(opts), isOpen };
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
    Store.init();
    Prefs.init();
    Router.init();
    renderVersion();
    initSkipLink();
    initSignalIntro();
    initWorkspace();
    A11y.init();
  }

  App.router = Router;
  App.bus = Bus;
  App.motion = Motion;
  App.store = Store;
  App.prefs = Prefs;
  App.wm = WM;
  App.workspace = Workspace;
  App.a11y = A11y;
  window.MultimodalDesktop = App;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
