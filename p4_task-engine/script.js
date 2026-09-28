/* ==========================================================================
   Multimodal Desktop: script.js
   Phase 4 (task engine): steps, timer and completion check, plus a practice task
   --------------------------------------------------------------------------
   Plain script, no modules, so index.html also works when opened from disk.
   Everything hangs off one namespace (window.MultimodalDesktop) that later
   phases extend.
   ========================================================================== */
(() => {
  'use strict';

  const App = {
    meta: { name: 'Multimodal Desktop', version: '0.4.0', phase: 4, phases: 20 },
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
      // A window opened minimized has no visible body to focus: its dock item stands in for it.
      (rec.minimized ? dockBtn : node).focus({ preventScroll: true });
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

  /* Task engine -------------------------------------------------------------
     A task is a short, fixed list of steps. The engine looks after what every
     task shares: starting a run, judging its steps, the clock, pausing,
     stopping, saving, and the history of finished runs. It knows nothing about
     windows, files or settings. A task says what each step means by giving it a
     check function that reads the app's state and answers yes or no.

       Tasks.define({
         id: 'practice',        // lower-case letters, digits and dashes
         title, label, summary, // label is the short name shown in the picker
         practice: true,        // a rehearsal, not one of the study tasks
         steps: [{ id, title, hint, events: ['window:close'], check(ctx) { return true; } }],
         setup(ctx), maintain(ctx), verify(ctx), teardown(ctx), // all optional
       });

     Steps go in order and only the first unfinished one is checked. A step is
     checked when a run starts, resumes or comes back from storage, and again
     just after the bus announces something (a step may list the events it cares
     about; the others are skipped for it). A finished step stays finished. When
     one step is found complete the next is checked at once, so work the user
     already did is credited in the same pass. After the last step, verify(ctx)
     must return true. Any other answer, ideally a short sentence about what is
     still wrong, keeps the run going and is shown to the user.

     Checks only read. maintain(ctx) is where a task may repair its surroundings
     (reopen a window that was closed too early); it runs before the checks.
     setup(ctx) runs after a run starts, and again with ctx.restoring true when a
     saved run comes back. teardown(ctx) runs after a run has finished.

     The clock counts only while a run is running. Pausing stops it. A run that
     was running when the page closed comes back paused and says so, and leaving
     the Workspace pauses it too, since the task panel is out of sight there.
     Carrying on is always up to the user. While paused, steps are not checked;
     the check runs again the moment the run resumes.

     A run is one record, kept under "tasks" in the store:
       { id, task, status ('running' | 'paused' | 'complete' | 'abandoned'),
         startedAt, finishedAt, elapsedMs, step, total,
         steps: { [stepId]: { at, atMs, trigger, source } },
         counts: { error: 0, ... }, pauses, interruptions, pausedFor, reason, meta }
     step is how many steps are done. atMs is the run's own clock when the step
     was found complete, so it leaves out paused time. trigger and source say
     which event the engine was reading at that moment. interruptions counts the
     reloads that happened during the run. counts holds whatever report() was
     told about. meta is for whoever starts the run (later, the study condition). */
  const Tasks = (() => {
    const ID = /^[a-z][a-z0-9-]{0,31}$/;
    const KIND = /^[a-z][a-z0-9-]{0,23}$/;
    const RUN_ID = /^run-\d{1,9}$/;
    const META_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
    const SOURCES = ['pointer', 'keyboard', 'voice', 'api'];
    const PAUSE_REASONS = ['user', 'away', 'reload'];
    const IGNORED = /^(task:|tasks:|state:)/; // the engine's own news, and storage news, never counts as something the user did
    const TICK_MS = 250;   // how often the clock on screen is refreshed
    const SAVE_MS = 5000;  // how often a running clock is written to storage
    const MAX_STEPS = 24;
    const MAX_KINDS = 12;  // counter names per run
    const MAX_RUNS = 1000; // finished runs kept

    const defs = new Map();   // id -> definition, functions included
    const tickers = new Set();
    let runs = [];            // finished runs, oldest first
    let counter = 0;          // runs started so far, so run ids never repeat
    let current = null;       // { rec, def, since } for the run in progress; since is null while it is paused
    let pending = [];         // bus events waiting for the next check
    let queued = false;
    let evaluating = false;
    let note = '';            // why verification last said no
    let intervalId = 0;
    let lastSave = 0;

    const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const words = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
    const whole = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
    const sourceFrom = (event) => {
      const value = event && event.detail && event.detail.source;
      return SOURCES.includes(value) ? value : 'api';
    };
    // The same rule for options passed to the engine: an unknown source is 'api'.
    const sourceIn = (opts) => sourceFrom({ detail: opts });

    /* Definitions ------------------------------------------------------- */

    // Returns true when the task was added. Never throws: a bad definition is
    // refused with a console warning.
    function define(input) {
      const refuse = (why) => { console.warn(`Task not defined: ${why}`); return false; };
      if (!isObject(input)) return refuse('it is not an object');
      const { id } = input;
      if (typeof id !== 'string' || !ID.test(id)) return refuse(`${JSON.stringify(id)} is not a usable id`);
      if (defs.has(id)) return refuse(`"${id}" is already defined`);
      const title = words(input.title, 80);
      if (!title) return refuse(`"${id}" needs a title`);
      if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > MAX_STEPS) {
        return refuse(`"${id}" needs between 1 and ${MAX_STEPS} steps`);
      }
      const seen = new Set();
      const steps = [];
      for (const raw of input.steps) {
        if (!isObject(raw) || typeof raw.id !== 'string' || !ID.test(raw.id) || seen.has(raw.id)) {
          return refuse(`a step of "${id}" has a missing, unusable or repeated id`);
        }
        const stepTitle = words(raw.title, 100);
        if (!stepTitle || typeof raw.check !== 'function') return refuse(`step "${raw.id}" needs a title and a check function`);
        if (raw.events !== undefined && !(Array.isArray(raw.events) && raw.events.every((type) => typeof type === 'string'))) {
          return refuse(`step "${raw.id}": events must be a list of event names`);
        }
        seen.add(raw.id);
        steps.push({ id: raw.id, title: stepTitle, hint: words(raw.hint, 160), check: raw.check, events: raw.events ? raw.events.slice() : null });
      }
      const hooks = {};
      for (const name of ['setup', 'maintain', 'verify', 'teardown']) {
        if (input[name] === undefined) continue;
        if (typeof input[name] !== 'function') return refuse(`"${id}": ${name} must be a function`);
        hooks[name] = input[name];
      }
      defs.set(id, {
        id, title, label: words(input.label, 24) || title, summary: words(input.summary, 200),
        practice: input.practice === true, steps, ...hooks,
      });
      Bus.emit('tasks:registered', { id });
      return true;
    }

    /* Records ------------------------------------------------------------ */

    function elapsed() {
      if (!current) return 0;
      return current.rec.elapsedMs + (current.since === null ? 0 : performance.now() - current.since);
    }

    // A copy of a run record plus what is handy to show: its title, whether it
    // is a practice run, the step it is on and why verification last said no.
    function snapshot(rec) {
      const def = defs.get(rec.task);
      const out = copy(rec);
      const live = Boolean(current) && current.rec === rec;
      if (live) out.elapsedMs = Math.round(elapsed());
      out.title = def ? def.title : rec.task;
      out.practice = def ? def.practice : false;
      const step = def && rec.step < def.steps.length ? def.steps[rec.step] : null;
      out.current = step ? { id: step.id, title: step.title, hint: step.hint } : null;
      out.note = live ? note : '';
      return out;
    }

    function lastRunOf(taskId) {
      for (let i = runs.length - 1; i >= 0; i -= 1) if (runs[i].task === taskId) return snapshot(runs[i]);
      return null;
    }

    function outline(def) {
      return {
        id: def.id, title: def.title, label: def.label, summary: def.summary, practice: def.practice,
        steps: def.steps.map((step) => ({ id: step.id, title: step.title, hint: step.hint })),
        last: lastRunOf(def.id),
      };
    }

    function cleanMeta(raw) {
      const meta = {};
      if (!isObject(raw)) return meta;
      for (const key of Object.keys(raw).filter((name) => META_KEY.test(name)).slice(0, 8)) {
        const value = raw[key];
        if (typeof value === 'string') meta[key] = value.slice(0, 40);
        else if (typeof value === 'number' && Number.isFinite(value)) meta[key] = value;
        else if (typeof value === 'boolean') meta[key] = value;
      }
      return meta;
    }

    function cleanCounts(raw) {
      const counts = {};
      if (!isObject(raw)) return counts;
      for (const key of Object.keys(raw).filter((name) => KIND.test(name)).slice(0, MAX_KINDS)) counts[key] = whole(raw[key]);
      return counts;
    }

    const cleanStep = (raw) => ({
      at: whole(raw.at), atMs: whole(raw.atMs), trigger: words(raw.trigger, 40), source: SOURCES.includes(raw.source) ? raw.source : 'api',
    });

    // Storage can hold anything, so a saved record is rebuilt field by field.
    function cleanFinished(raw) {
      if (!isObject(raw) || (raw.status !== 'complete' && raw.status !== 'abandoned')) return null;
      if (typeof raw.task !== 'string' || !ID.test(raw.task) || typeof raw.id !== 'string' || !RUN_ID.test(raw.id)) return null;
      const steps = {};
      if (isObject(raw.steps)) {
        for (const key of Object.keys(raw.steps).filter((name) => ID.test(name)).slice(0, MAX_STEPS)) {
          if (isObject(raw.steps[key])) steps[key] = cleanStep(raw.steps[key]);
        }
      }
      return {
        id: raw.id, task: raw.task, status: raw.status, startedAt: whole(raw.startedAt), finishedAt: whole(raw.finishedAt),
        elapsedMs: whole(raw.elapsedMs), step: whole(raw.step), total: whole(raw.total), steps,
        counts: cleanCounts(raw.counts), pauses: whole(raw.pauses), interruptions: whole(raw.interruptions),
        pausedFor: '', reason: words(raw.reason, 24), meta: cleanMeta(raw.meta),
      };
    }

    // A saved run in progress. Only the leading steps that have a record count as done.
    function cleanActive(raw, def) {
      if (!isObject(raw) || (raw.status !== 'running' && raw.status !== 'paused')) return null;
      const steps = {};
      let done = 0;
      for (const step of def.steps) {
        if (!isObject(raw.steps) || !isObject(raw.steps[step.id])) break;
        steps[step.id] = cleanStep(raw.steps[step.id]);
        done += 1;
      }
      if (typeof raw.id !== 'string' || !RUN_ID.test(raw.id)) counter += 1;
      return {
        id: typeof raw.id === 'string' && RUN_ID.test(raw.id) ? raw.id : `run-${counter}`,
        task: def.id, status: raw.status, startedAt: whole(raw.startedAt) || Date.now(), finishedAt: null,
        elapsedMs: whole(raw.elapsedMs), step: done, total: def.steps.length, steps,
        counts: cleanCounts(raw.counts), pauses: whole(raw.pauses), interruptions: whole(raw.interruptions),
        pausedFor: PAUSE_REASONS.includes(raw.pausedFor) ? raw.pausedFor : 'user', reason: '', meta: cleanMeta(raw.meta),
      };
    }

    /* Clock and saving ---------------------------------------------------- */

    function persist() {
      lastSave = performance.now();
      if (current) Store.set('tasks.active', { ...current.rec, elapsedMs: Math.round(elapsed()) });
    }

    function tick() {
      tickers.forEach((fn) => {
        try { fn(); } catch (error) { console.error('Task clock listener failed', error); }
      });
      if (current && current.since !== null && performance.now() - lastSave >= SAVE_MS) persist();
    }

    function startClock() {
      current.since = performance.now();
      if (!intervalId) {
        lastSave = performance.now();
        intervalId = window.setInterval(tick, TICK_MS);
      }
    }

    function stopClock() {
      if (current && current.since !== null) {
        current.rec.elapsedMs += performance.now() - current.since;
        current.since = null;
      }
      window.clearInterval(intervalId);
      intervalId = 0;
    }

    // Write the clock of a running task now (the page is going away).
    function flush() {
      if (current && current.since !== null) persist();
    }

    /* Judging steps ------------------------------------------------------- */

    function makeContext(rec, extra) {
      return {
        app: App, task: rec.task, run: snapshot(rec), step: null, event: null, restoring: false,
        report: (kind, detail) => report(kind, detail),
        ...extra,
      };
    }

    function hook(fn, rec, extra) {
      if (!fn) return undefined;
      try { return fn(makeContext(rec, extra)); } catch (error) { console.error(`A hook of task "${rec.task}" failed`, error); return undefined; }
    }

    const stepInfo = (rec, def) => (rec.step < def.steps.length ? { id: def.steps[rec.step].id, index: rec.step, total: rec.total } : null);

    function markStep(rec, step, trigger, source) {
      const atMs = Math.round(elapsed());
      rec.steps[step.id] = { at: Date.now(), atMs, trigger: words(trigger, 40), source };
      rec.step += 1;
      note = '';
      persist();
      Bus.emit('task:step', { task: rec.task, run: rec.id, step: step.id, title: step.title, index: rec.step - 1, total: rec.total, atMs, trigger, source });
    }

    // After the last step: verify, then finish or say what is still wrong.
    function settle(rec, def, source) {
      let verdict = true;
      if (def.verify) {
        try { verdict = def.verify(makeContext(rec)); } catch (error) {
          console.error(`Verification of task "${rec.task}" failed`, error);
          verdict = 'The final check could not run.';
        }
      }
      if (verdict === true) { finish('complete', { source }); return; }
      const message = words(typeof verdict === 'string' ? verdict : '', 160) || 'Not finished yet.';
      if (message !== note) {
        note = message;
        Bus.emit('task:verify', { task: rec.task, run: rec.id, ok: false, message });
      }
    }

    // events: the bus events that prompted this pass, or null for a pass on the
    // state alone (start, resume, restore, an explicit check). Returns how many
    // steps were newly completed.
    function evaluate(events, trigger, source) {
      if (evaluating || !current || current.since === null) return 0;
      evaluating = true;
      let credited = 0;
      try {
        const { rec, def } = current;
        const heard = events && events.length ? events : null;
        const last = heard ? heard[heard.length - 1] : null;
        const why = last ? last.type : trigger;
        const how = last ? sourceFrom(last) : source;
        hook(def.maintain, rec, { step: stepInfo(rec, def), event: last });
        let listening = heard;
        while (current && current.rec === rec && current.since !== null && rec.step < def.steps.length) {
          const step = def.steps[rec.step];
          let hit = null;
          if (listening) {
            const matching = step.events ? listening.filter((event) => step.events.includes(event.type)) : listening;
            if (!matching.length) break;
            hit = matching[matching.length - 1];
          }
          let passed = false;
          try {
            passed = Boolean(step.check(makeContext(rec, { step: { id: step.id, index: rec.step, total: rec.total }, event: hit })));
          } catch (error) {
            console.error(`The check for step "${step.id}" failed`, error);
          }
          if (!passed) break;
          markStep(rec, step, why, how);
          credited += 1;
          listening = null; // the next step is judged on the state alone
        }
        if (current && current.rec === rec && current.since !== null && rec.step === def.steps.length) settle(rec, def, how);
      } finally {
        evaluating = false;
      }
      return credited;
    }

    function flushPending() {
      queued = false;
      const events = pending;
      pending = [];
      if (!current || current.since === null) return;
      try { evaluate(events, 'event', 'api'); } catch (error) { console.error('Task check failed', error); }
    }

    // Every bus event passes through here. The check itself waits a moment, so
    // a burst of events (an open, a focus, a move) costs one check.
    function onBus(event) {
      if (!current || current.since === null || IGNORED.test(event.type)) return;
      pending.push(event);
      if (pending.length > 50) pending.shift();
      if (!queued) {
        queued = true;
        Promise.resolve().then(flushPending);
      }
    }

    /* Finishing ------------------------------------------------------------ */

    function finish(status, { reason = '', source = 'api' } = {}) {
      const { rec, def } = current;
      stopClock();
      rec.elapsedMs = Math.round(rec.elapsedMs);
      rec.status = status;
      rec.finishedAt = Date.now();
      rec.pausedFor = '';
      if (status === 'abandoned') rec.reason = reason;
      runs.push(copy(rec));
      if (runs.length > MAX_RUNS) runs = runs.slice(-MAX_RUNS);
      current = null;
      pending = [];
      note = '';
      // Runs first, then the end of the active record: a crash in between leaves
      // the run in both places, and restore() keeps it once.
      Store.set('tasks.runs', runs);
      Store.remove('tasks.active');
      const done = snapshot(rec);
      const detail = { task: rec.task, run: rec.id, elapsedMs: rec.elapsedMs, step: rec.step, total: rec.total, source };
      if (status === 'complete') {
        Bus.emit('task:complete', { ...detail, steps: copy(rec.steps), counts: copy(rec.counts), pauses: rec.pauses, interruptions: rec.interruptions });
      } else {
        Bus.emit('task:abandon', { ...detail, reason });
      }
      hook(def.teardown, rec); // after the announcement, so the log reads: finished, then the tidy-up
      return done;
    }

    /* Public actions ------------------------------------------------------- */

    // Returns the new run, or null when the task is unknown or another run is going.
    function start(id, opts = {}) {
      const def = typeof id === 'string' ? defs.get(id) : null;
      if (!def || current) return null;
      counter += 1;
      const rec = {
        id: `run-${counter}`, task: id, status: 'running', startedAt: Date.now(), finishedAt: null, elapsedMs: 0,
        step: 0, total: def.steps.length, steps: {}, counts: {}, pauses: 0, interruptions: 0,
        pausedFor: '', reason: '', meta: cleanMeta(opts.meta),
      };
      current = { rec, def, since: null };
      note = '';
      pending = [];
      startClock();
      Store.set('tasks.counter', counter);
      persist();
      const source = sourceIn(opts);
      Bus.emit('task:start', { task: id, run: rec.id, title: def.title, practice: def.practice, total: rec.total, meta: copy(rec.meta), source });
      hook(def.setup, rec);
      evaluate(null, 'start', source);
      return snapshot(rec);
    }

    function pause(opts = {}) {
      if (!current || current.since === null) return null;
      const { rec } = current;
      stopClock();
      pending = [];
      rec.status = 'paused';
      rec.pauses += 1;
      rec.pausedFor = PAUSE_REASONS.includes(opts.reason) ? opts.reason : 'user';
      persist();
      Bus.emit('task:pause', { task: rec.task, run: rec.id, reason: rec.pausedFor, elapsedMs: Math.round(rec.elapsedMs), source: sourceIn(opts) });
      return snapshot(rec);
    }

    function resume(opts = {}) {
      if (!current || current.since !== null) return null;
      const { rec } = current;
      rec.status = 'running';
      rec.pausedFor = '';
      startClock();
      persist();
      const source = sourceIn(opts);
      Bus.emit('task:resume', { task: rec.task, run: rec.id, elapsedMs: Math.round(rec.elapsedMs), source });
      evaluate(null, 'resume', source);
      return snapshot(rec);
    }

    // Ends the run in progress as unfinished. Its record stays in the history.
    function abandon(opts = {}) {
      if (!current) return null;
      return finish('abandoned', { reason: words(opts.reason, 24) || 'user', source: sourceIn(opts) });
    }

    // Ends this run as unfinished and starts the same task again from step 1.
    function restart(opts = {}) {
      if (!current) return null;
      const { task, meta } = current.rec;
      const source = sourceIn(opts);
      abandon({ reason: 'restart', source });
      return start(task, { meta, source });
    }

    // Counts one thing that happened in the run (for example an error) and
    // announces it. Only a running run takes reports.
    function report(kind, detail, opts) {
      if (!current || current.since === null || typeof kind !== 'string' || !KIND.test(kind)) return false;
      const { rec } = current;
      if (!hasOwn(rec.counts, kind) && Object.keys(rec.counts).length >= MAX_KINDS) return false;
      rec.counts[kind] = (hasOwn(rec.counts, kind) ? rec.counts[kind] : 0) + 1;
      persist();
      Bus.emit('task:report', { task: rec.task, run: rec.id, kind, detail: detail === undefined ? null : detail, count: rec.counts[kind], source: sourceIn(opts) });
      return true;
    }

    /* Saved state ---------------------------------------------------------- */

    // Picks up where the last page load left off. A run that was running comes
    // back paused: the time the page was closed is not task time.
    function restore() {
      const saved = Store.get('tasks');
      if (!isObject(saved)) return;
      runs = (Array.isArray(saved.runs) ? saved.runs : []).map(cleanFinished).filter(Boolean).slice(-MAX_RUNS);
      const known = new Set(runs.map((run) => run.id));
      counter = Math.max(whole(saved.counter), ...runs.map((run) => Number(run.id.slice(4))));
      const raw = saved.active;
      if (isObject(raw)) {
        const def = typeof raw.task === 'string' ? defs.get(raw.task) : null;
        if (typeof raw.id === 'string' && known.has(raw.id)) {
          Store.remove('tasks.active'); // it had finished; only the clean-up was missed
        } else if (def) {
          const rec = cleanActive(raw, def);
          if (rec) {
            if (rec.status === 'running') {
              rec.status = 'paused';
              rec.pausedFor = 'reload';
              rec.interruptions += 1;
            }
            current = { rec, def, since: null };
            persist();
            hook(def.setup, rec, { restoring: true });
          } else {
            Store.remove('tasks.active');
          }
        } else {
          // The task is not defined any more. Keep a trace that the run happened.
          const trace = cleanFinished({ ...raw, status: 'abandoned', reason: 'unavailable', finishedAt: Date.now() });
          if (trace) {
            runs.push(trace);
            Store.set('tasks.runs', runs);
          }
          Store.remove('tasks.active');
        }
      }
      Bus.emit('tasks:restored', { active: Boolean(current), runs: runs.length });
    }

    // Forget everything in memory (the store itself has just been cleared).
    function reset() {
      stopClock();
      current = null;
      runs = [];
      counter = 0;
      pending = [];
      note = '';
      Bus.emit('tasks:cleared', {});
    }

    function init() {
      Bus.on('*', onBus);
      Bus.on('state:clear', reset);
      Router.onChange((id) => { if (id !== 'workspace') pause({ reason: 'away', source: 'api' }); });
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
      restore();
    }

    return {
      init, define, start, pause, resume, abandon, restart, report, flush,
      list: () => Array.from(defs.values()).map(outline),
      get: (id) => (defs.has(id) ? outline(defs.get(id)) : null),
      active: () => (current ? snapshot(current.rec) : null),
      runs: (taskId) => runs.filter((run) => taskId === undefined || run.task === taskId).map(snapshot),
      elapsed: () => Math.round(elapsed()),
      check: () => evaluate(null, 'check', 'api'),
      onTick: (fn) => { tickers.add(fn); return () => tickers.delete(fn); },
    };
  })();

  /* Practice task -----------------------------------------------------------
     A rehearsal for the real tasks: five steps that use every window control.
     It opens its own window, so nothing the user already has open is touched,
     and it uses only controls that work from a keyboard. It is marked as
     practice so later analysis can leave it out. If the window is closed before
     the last step, it comes back and the slip is counted as an error. */
  const PRACTICE_WINDOW = 'practice';
  const practiceWindow = () => WM.get(PRACTICE_WINDOW);
  // The window opens in the state the given step starts from, so one that comes
  // back in the middle of the task matches what the step asks the user to do.
  const openPractice = (quiet, stepId) => WM.open({
    id: PRACTICE_WINDOW, kind: 'practice', title: 'Practice window', source: 'api', quiet,
    maximized: stepId === 'unmaximize', minimized: stepId === 'restore',
  });

  WM.register('practice', (body) => body.append(
    el(
      'div',
      { class: 'sample' },
      el('p', { text: 'This window is for the practice task. Follow the steps shown above the desktop.' }),
      el('p', { text: 'It does not count as one of the three tasks. Closing it is the last step.' }),
    ),
  ));

  Tasks.define({
    id: 'practice',
    title: 'Practice: window controls',
    label: 'Practice',
    summary: 'Learn the window controls in about a minute. It does not count as one of the three tasks.',
    practice: true,
    steps: [
      {
        id: 'maximize',
        title: 'Maximize the practice window',
        hint: 'Use the square button in its title bar, or double-click the title bar.',
        events: ['window:maximize'],
        check: () => Boolean(practiceWindow() && practiceWindow().maximized),
      },
      {
        id: 'unmaximize',
        title: 'Return it to its normal size',
        hint: 'Press the same button again.',
        events: ['window:unmaximize'],
        check: () => Boolean(practiceWindow()) && !practiceWindow().maximized,
      },
      {
        id: 'minimize',
        title: 'Minimize it',
        hint: 'The dash button sends the window to the dock at the bottom.',
        events: ['window:minimize'],
        check: () => Boolean(practiceWindow() && practiceWindow().minimized),
      },
      {
        id: 'restore',
        title: 'Bring it back from the dock',
        hint: 'Select its name in the dock.',
        events: ['window:restore'],
        check: () => Boolean(practiceWindow()) && !practiceWindow().minimized,
      },
      {
        id: 'close',
        title: 'Close the practice window',
        hint: 'Use the cross button in its title bar.',
        events: ['window:close'],
        check: () => !practiceWindow(),
      },
    ],
    setup(ctx) {
      const existing = practiceWindow();
      const onLastStep = ctx.run.step >= ctx.run.total - 1;
      if (!existing) {
        if (!ctx.restoring || !onLastStep) openPractice(ctx.restoring, ctx.run.current && ctx.run.current.id);
        return;
      }
      if (ctx.restoring) return; // a saved window comes back as it was
      // A window left over from earlier starts this run from a known state.
      if (existing.minimized) WM.restore(PRACTICE_WINDOW, { source: 'api' });
      if (existing.maximized) WM.maximize(PRACTICE_WINDOW, { on: false, source: 'api' });
    },
    maintain(ctx) {
      if (practiceWindow() || !ctx.step || ctx.step.index === ctx.step.total - 1) return;
      ctx.report('error', {
        reason: 'window-closed-early',
        message: 'The practice window was closed before the last step, so it was reopened.',
      });
      openPractice(false, ctx.step.id);
    },
    teardown() {
      if (practiceWindow()) WM.close(PRACTICE_WINDOW, { source: 'api' });
    },
  });

  /* Task panel --------------------------------------------------------------
     A strip above the desktop. With no task running it offers the tasks and a
     Start button. While one runs it shows the step to do now, the clock, and
     Pause, Restart and Stop, with the full list of steps a button away. When a
     task is finished it shows the result.

     The panel is built once and updated in place, so a button the user is on
     keeps its focus when its label changes. When the focused control goes away
     (Start after starting, Stop after stopping) focus moves to the control that
     comes next, and is never left on nothing. Changes are announced through a
     polite live region; the clock itself is not, because it would talk all the
     time. Restart and Stop ask first, because they end the attempt. */
  const TaskPanel = (() => {
    const ui = {};
    let root = null;
    let view = { state: 'idle', active: null, finished: null };
    let selected = '';    // the task chosen in the picker
    let resultRun = '';   // the run whose result is on show
    let stepsOpen = false;
    let confirming = '';  // '' | 'stop' | 'restart'
    let opener = null;    // the button that asked for the confirmation

    const pad = (n) => String(n).padStart(2, '0');
    function formatTime(ms) {
      const total = Math.floor(Math.max(0, ms) / 1000);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      return h ? `${h}:${pad(m)}:${pad(total % 60)}` : `${m}:${pad(total % 60)}`;
    }

    // The task to offer first: the first one that has not been finished yet.
    function suggest() {
      const list = Tasks.list();
      const finished = new Set(Tasks.runs().filter((run) => run.status === 'complete').map((run) => run.task));
      return (list.find((item) => !finished.has(item.id)) || list[0] || { id: '' }).id;
    }

    function button(action, label, glyph, extra) {
      return el(
        'button',
        { class: `tasks__btn ${extra || ''}`.trim(), type: 'button', 'data-task-action': action },
        glyph ? icon(glyph) : null,
        el('span', { text: label }),
      );
    }

    function build() {
      ui.title = el('h2', { class: 'tasks__title', id: 'tasks-title' });
      ui.count = el('span', { class: 'tasks__count' });
      ui.badge = el('span', { class: 'tasks__badge', text: 'Paused', hidden: true });
      ui.sub = el('p', { class: 'tasks__sub', id: 'tasks-sub', tabindex: '-1' });
      ui.time = el('span', { class: 'tasks__time', id: 'tasks-time', role: 'timer', 'aria-labelledby': 'tasks-clock-label', text: '0:00' });
      ui.clock = el('div', { class: 'tasks__clock', hidden: true }, el('span', { class: 'sr-only', id: 'tasks-clock-label', text: 'Elapsed time' }), ui.time);

      ui.seg = el('div', { class: 'seg tasks__seg' });
      ui.start = el('button', { class: 'btn btn--primary tasks__start', type: 'button', 'data-task-action': 'start', 'aria-describedby': 'tasks-sub' }, icon('i-play'), el('span', { text: 'Start' }));
      ui.pick = el('fieldset', { class: 'tasks__pick' }, el('legend', { class: 'sr-only', text: 'Choose a task' }), ui.seg);
      ui.idle = el('div', { class: 'tasks__group' }, ui.pick, ui.start);

      ui.toggle = button('toggle', 'Pause', 'i-pause');
      ui.restart = button('restart', 'Restart', 'i-restart');
      ui.stop = button('stop', 'Stop task');
      ui.stepsBtn = el(
        'button',
        { class: 'tasks__btn tasks__btn--quiet', type: 'button', 'data-task-action': 'steps', 'aria-expanded': 'false', 'aria-controls': 'tasks-steps' },
        el('span', { text: 'Show steps' }),
        icon('i-chevron'),
      );
      ui.controls = el('div', { class: 'tasks__row' }, ui.toggle, ui.restart, ui.stop, ui.stepsBtn);
      ui.confirmText = el('p', { id: 'tasks-confirm-text' });
      ui.keep = button('keep', 'Keep going');
      ui.sure = button('sure', 'Stop task', null, 'tasks__btn--danger');
      ui.confirm = el(
        'div',
        { class: 'tasks__confirm', role: 'group', 'aria-labelledby': 'tasks-confirm-text', hidden: true },
        ui.confirmText,
        el('div', { class: 'tasks__row' }, ui.keep, ui.sure),
      );
      ui.live = el('div', { class: 'tasks__group', hidden: true }, ui.controls, ui.confirm);

      ui.again = button('again', 'Do it again', 'i-restart');
      ui.another = button('another', 'Choose another task');
      ui.done = el('div', { class: 'tasks__group', hidden: true }, ui.again, ui.another);

      ui.segs = el('div', { class: 'tasks__segs', 'aria-hidden': 'true', hidden: true });
      ui.steps = el('ol', { class: 'tasks__steps', id: 'tasks-steps', role: 'list', 'aria-label': 'Steps', hidden: true });
      ui.status = el('p', { class: 'sr-only', role: 'status' });

      root = el(
        'section',
        { class: 'panel tasks', id: 'tasks', 'aria-labelledby': 'tasks-title', 'data-state': 'idle' },
        el(
          'div',
          { class: 'tasks__top' },
          el('span', { class: 'tile tasks__tile' }, icon('i-task')),
          el('div', { class: 'tasks__text' }, el('div', { class: 'tasks__line' }, ui.title, ui.count, ui.badge), ui.sub),
          el('div', { class: 'tasks__actions' }, ui.clock, ui.idle, ui.live, ui.done),
        ),
        ui.segs,
        ui.steps,
        ui.status,
      );
      return root;
    }

    // The same words twice in a row would not be read out again, so the second
    // copy gets an invisible trailing character.
    const say = (text) => {
      ui.status.textContent = text && ui.status.textContent === text ? `${text} ` : text;
    };

    function focusable(node) {
      return Boolean(node) && node !== document.body && node.isConnected && !node.disabled && !node.closest('[hidden]');
    }

    // Focus goes to the control that comes next, never to nothing.
    function rescueFocus() {
      const target = view.state === 'idle' ? ui.start : view.state === 'done' ? ui.sub : ui.toggle;
      target.focus({ preventScroll: true });
    }

    function pauseNote(run) {
      if (run.pausedFor === 'away') return 'Paused because you left the Workspace. Press Resume when you are ready.';
      if (run.pausedFor === 'reload') return 'Paused because the page was reloaded. Press Resume when you are ready.';
      return 'Paused. The timer is stopped. Press Resume when you are ready.';
    }

    function aboutText(item) {
      const n = item.steps.length;
      const last = item.last;
      let tail = 'Not run yet.';
      if (last) {
        tail = last.status === 'complete'
          ? `Last run: finished in ${formatTime(last.elapsedMs)}.`
          : `Last run: stopped at step ${Math.min(last.step + 1, last.total)} of ${last.total}.`;
      }
      return [item.summary, `${n} ${n === 1 ? 'step' : 'steps'}.`, tail].filter(Boolean).join(' ');
    }

    function renderPicker(list) {
      const key = list.map((item) => item.id).join('|');
      if (ui.seg.dataset.key !== key) {
        const had = ui.seg.contains(document.activeElement) ? document.activeElement.value : null;
        ui.seg.replaceChildren(...list.map((item) => el(
          'label',
          { class: 'seg__opt' },
          el('input', { class: 'seg__input', type: 'radio', name: 'task-pick', value: item.id }),
          el('span', { class: 'seg__text', text: item.label }),
        )));
        ui.seg.dataset.key = key;
        if (had) Array.from(ui.seg.querySelectorAll('input')).find((input) => input.value === had)?.focus({ preventScroll: true });
      }
      ui.seg.querySelectorAll('input').forEach((input) => { input.checked = input.value === selected; });
    }

    function renderIdle() {
      const list = Tasks.list();
      if (!list.some((item) => item.id === selected)) selected = suggest();
      const item = list.find((entry) => entry.id === selected);
      // One task needs no picker: it is named in the title.
      const single = list.length === 1;
      ui.title.textContent = single && item ? item.title : 'Choose a task';
      ui.count.textContent = '';
      ui.pick.hidden = single;
      renderPicker(list);
      ui.sub.textContent = item ? aboutText(item) : 'No tasks are available yet.';
      ui.start.disabled = !item;
    }

    function renderSegments(total, done) {
      ui.segs.replaceChildren(...Array.from({ length: total }, (_, i) => el('span', {
        class: 'tasks__seg-i',
        'data-status': i < done ? 'done' : i === done ? 'current' : 'todo',
      })));
    }

    function renderSteps(item, done) {
      ui.steps.replaceChildren(...item.steps.map((step, i) => {
        const status = i < done ? 'done' : i === done ? 'current' : 'todo';
        const spoken = { done: 'done', current: 'current step', todo: 'to do' }[status];
        return el(
          'li',
          { 'data-status': status, 'aria-current': status === 'current' ? 'step' : null },
          el('span', { class: 'tasks__mark', 'aria-hidden': 'true' }, status === 'done' ? icon('i-check') : null),
          el('span', { class: 'tasks__label' }, step.title, el('span', { class: 'sr-only', text: `, ${spoken}` })),
        );
      }));
    }

    function renderLive(run) {
      const paused = run.status === 'paused';
      const item = Tasks.get(run.task);
      ui.title.textContent = run.title;
      ui.count.textContent = `Step ${Math.min(run.step + 1, run.total)} of ${run.total}`;
      const side = paused ? pauseNote(run) : run.note || (run.current && run.current.hint) || '';
      ui.sub.replaceChildren(
        ...[
          el('strong', { class: 'tasks__now', text: run.current ? run.current.title : 'All steps are done' }),
          side ? ' ' : null,
          side ? el('span', { class: 'tasks__hint', text: side }) : null,
        ].filter(Boolean),
      );
      ui.toggle.querySelector('span').textContent = paused ? 'Resume' : 'Pause';
      ui.toggle.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
      ui.controls.hidden = Boolean(confirming);
      ui.confirm.hidden = !confirming;
      if (confirming === 'restart') {
        ui.confirmText.textContent = 'Start over? This attempt is saved as unfinished and the timer begins again at zero.';
        ui.sure.querySelector('span').textContent = 'Restart';
      } else if (confirming === 'stop') {
        ui.confirmText.textContent = 'Stop this task? The attempt is saved as unfinished, and you can start it again later.';
        ui.sure.querySelector('span').textContent = 'Stop task';
      }
      renderSegments(run.total, run.step);
      if (item) renderSteps(item, run.step);
    }

    function renderDone(run) {
      ui.title.textContent = run.title;
      ui.count.textContent = 'Complete';
      ui.sub.textContent = `Finished in ${formatTime(run.elapsedMs)}. All ${run.total} ${run.total === 1 ? 'step' : 'steps'} done.`;
      ui.again.dataset.task = run.task;
      renderSegments(run.total, run.total);
    }

    function renderClock() {
      if (!root) return;
      const text = view.state === 'done' ? formatTime(view.finished.elapsedMs) : view.state === 'idle' ? '' : formatTime(Tasks.elapsed());
      if (text && ui.time.textContent !== text) ui.time.textContent = text;
    }

    function render() {
      if (!root) return;
      const hadFocus = root.contains(document.activeElement);
      const active = Tasks.active();
      let state = 'idle';
      let finished = null;
      if (active) {
        state = active.status === 'paused' ? 'paused' : 'running';
      } else if (resultRun) {
        finished = Tasks.runs().find((run) => run.id === resultRun && run.status === 'complete') || null;
        if (finished) state = 'done';
        else resultRun = '';
      }
      view = { state, active, finished };
      const live = state === 'running' || state === 'paused';
      root.dataset.state = state;
      ui.idle.hidden = state !== 'idle';
      ui.live.hidden = !live;
      ui.done.hidden = state !== 'done';
      ui.clock.hidden = state === 'idle';
      ui.segs.hidden = state === 'idle';
      ui.badge.hidden = state !== 'paused';
      ui.steps.hidden = !(live && stepsOpen);
      // Kept true to the choice even while hidden, so it is never stale when the button comes back.
      ui.stepsBtn.querySelector('span').textContent = stepsOpen ? 'Hide steps' : 'Show steps';
      ui.stepsBtn.setAttribute('aria-expanded', String(stepsOpen));
      ui.stepsBtn.classList.toggle('is-open', stepsOpen);
      if (live) renderLive(active);
      else if (state === 'done') renderDone(finished);
      else renderIdle();
      renderClock();
      if (hadFocus && !focusable(document.activeElement)) rescueFocus();
    }

    function onTaskEvent(event) {
      const d = event.detail;
      const item = d && d.task ? Tasks.get(d.task) : null;
      switch (event.type) {
        case 'task:start':
          resultRun = '';
          confirming = '';
          say(`Started: ${d.title}. Step 1 of ${d.total}: ${item ? item.steps[0].title : ''}.`);
          break;
        case 'task:step': {
          const next = item && item.steps[d.index + 1];
          say(`Step ${d.index + 1} done: ${d.title}.${next ? ` Next, step ${d.index + 2} of ${d.total}: ${next.title}.` : ''}`);
          break;
        }
        case 'task:pause': say(`Paused at ${formatTime(d.elapsedMs)}.`); break;
        case 'task:resume': say('Resumed.'); break;
        case 'task:verify': say(/^Not finished/.test(d.message) ? d.message : `Not finished yet. ${d.message}`); break;
        case 'task:report': // a task may attach a sentence to say aloud
          if (d.detail && typeof d.detail.message === 'string') say(d.detail.message);
          break;
        case 'task:complete':
          resultRun = d.run;
          confirming = '';
          selected = suggest();
          say(`${item ? item.title : 'The task'} is complete. Time: ${formatTime(d.elapsedMs)}.`);
          break;
        case 'task:abandon':
          resultRun = '';
          confirming = '';
          if (d.reason !== 'restart') say('Task stopped.');
          break;
        case 'tasks:cleared':
          resultRun = '';
          confirming = '';
          stepsOpen = false;
          selected = suggest();
          say('');
          break;
        default:
      }
      render();
    }

    function cancelConfirm() {
      confirming = '';
      render();
      if (focusable(opener)) opener.focus({ preventScroll: true });
    }

    function onClick(event) {
      const control = event.target.closest('[data-task-action]');
      if (!control || !root.contains(control)) return;
      const source = event.detail === 0 ? 'keyboard' : 'pointer';
      switch (control.dataset.taskAction) {
        case 'start':
          if (selected) Tasks.start(selected, { source });
          break;
        case 'toggle': {
          const run = Tasks.active();
          if (run) (run.status === 'paused' ? Tasks.resume({ source }) : Tasks.pause({ source }));
          break;
        }
        case 'restart':
        case 'stop':
          confirming = control.dataset.taskAction;
          opener = control;
          render();
          ui.keep.focus({ preventScroll: true });
          break;
        case 'keep': cancelConfirm(); break;
        case 'sure': {
          const kind = confirming;
          confirming = '';
          if (kind === 'restart') Tasks.restart({ source });
          else Tasks.abandon({ reason: 'user', source });
          break;
        }
        case 'steps':
          stepsOpen = !stepsOpen;
          render();
          break;
        case 'again':
          if (control.dataset.task) Tasks.start(control.dataset.task, { source });
          break;
        case 'another':
          resultRun = '';
          render();
          (ui.seg.querySelector('input:checked') || ui.start).focus({ preventScroll: true });
          break;
        default:
      }
    }

    function init(desktop) {
      desktop.before(build());
      selected = suggest();
      root.addEventListener('click', onClick);
      root.addEventListener('change', (event) => {
        const input = event.target.closest('.seg__input');
        if (!input) return;
        selected = input.value;
        render();
      });
      root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && confirming) {
          event.preventDefault();
          cancelConfirm();
        }
      });
      ['task:start', 'task:step', 'task:pause', 'task:resume', 'task:verify', 'task:report', 'task:complete', 'task:abandon', 'tasks:registered', 'tasks:restored', 'tasks:cleared']
        .forEach((type) => Bus.on(type, onTaskEvent));
      Tasks.onTick(renderClock);
      render();
    }

    return { init, render };
  })();

  function initTasks() {
    const desktop = $('#desktop');
    if (!desktop) return;
    Tasks.init();
    TaskPanel.init(desktop);
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
        el('p', { id: 'a11y-confirm-text', text: 'This removes your display settings, open windows and task progress from this browser. It cannot be undone.' }),
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
    initTasks();
    A11y.init();
  }

  App.router = Router;
  App.bus = Bus;
  App.motion = Motion;
  App.store = Store;
  App.prefs = Prefs;
  App.wm = WM;
  App.workspace = Workspace;
  App.tasks = Tasks;
  App.taskPanel = TaskPanel;
  App.a11y = A11y;
  window.MultimodalDesktop = App;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
