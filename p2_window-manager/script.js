/* ==========================================================================
   Multimodal Desktop: script.js
   Phase 2 (window manager): router, event bus, windows and dock
   --------------------------------------------------------------------------
   Plain script, no modules, so index.html also works when opened from disk.
   Everything hangs off one namespace (window.MultimodalDesktop) that later
   phases extend.
   ========================================================================== */
(() => {
  'use strict';

  const App = {
    meta: { name: 'Multimodal Desktop', version: '0.2.0', phase: 2, phases: 20 },
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
    const MIN_W = 280;
    const MIN_H = 180;
    const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

    const windows = new Map(); // id -> record
    const stack = [];          // ids, bottom to top
    let ref = null;            // { desktop, layer, dock, dockList, empty }
    let area = { w: 960, h: 560 }; // last measured work area, kept while the view is hidden
    let gesture = null;        // the drag or resize in progress, if any
    let nextId = 0;

    const sourceOf = (opts) => (opts && opts.source) || 'api';
    const sourceOfClick = (event) => (event.detail === 0 ? 'keyboard' : 'pointer');

    /* Geometry ---------------------------------------------------------- */

    function measure() {
      const w = ref.layer.clientWidth;
      const h = ref.layer.clientHeight;
      if (w > 0 && h > 0) area = { w, h };
      return area;
    }

    // Keep a rectangle fully inside the work area, never smaller than the minimum.
    function fit({ x, y, w, h }) {
      const width = clamp(Math.round(w), Math.min(MIN_W, area.w), area.w);
      const height = clamp(Math.round(h), Math.min(MIN_H, area.h), area.h);
      return {
        w: width,
        h: height,
        x: clamp(Math.round(x), 0, area.w - width),
        y: clamp(Math.round(y), 0, area.h - height),
      };
    }

    // Resize from one edge or corner. Each moving edge stops at the work area
    // or at the minimum size, so the opposite edge never slides.
    function solveResize(o, edge, dx, dy) {
      const minW = Math.min(MIN_W, area.w);
      const minH = Math.min(MIN_H, area.h);
      let left = o.x;
      let top = o.y;
      let right = o.x + o.w;
      let bottom = o.y + o.h;
      if (edge.includes('e')) right = clamp(right + dx, left + minW, area.w);
      if (edge.includes('w')) left = clamp(left + dx, 0, right - minW);
      if (edge.includes('s')) bottom = clamp(bottom + dy, top + minH, area.h);
      if (edge.includes('n')) top = clamp(top + dy, 0, bottom - minH);
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

    // The work area changed size (browser resized, or the Workspace just appeared).
    function refit() {
      const { w, h } = area;
      measure();
      if (area.w === w && area.h === h) return;
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

    function open(options = {}) {
      if (!ref) return null;
      const known = options.id && windows.get(options.id);
      if (known) return restore(known.id, options);

      measure();
      const id = options.id || `window-${(nextId += 1)}`;
      const title = options.title || 'Untitled window';
      const iconId = options.icon || 'i-window';

      // New windows cascade down and to the right of the middle of the desktop.
      const size = fit({ x: 0, y: 0, w: options.w ?? Math.min(520, area.w - 32), h: options.h ?? Math.min(400, area.h - 32) });
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
          class: 'window is-opening',
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

      if (typeof options.content === 'function') options.content(body, { id });
      else if (options.content instanceof Node) body.append(options.content);
      else if (options.content != null) body.textContent = String(options.content);

      const rec = {
        id, title, el: node, minBtn, maxBtn, closeBtn, dockBtn, dockLi: el('li', {}, dockBtn), status,
        x: 0, y: 0, w: 0, h: 0, minimized: false, maximized: false, closing: false, token: 0,
      };
      place(rec, bounds);
      windows.set(id, rec);
      stack.push(id);
      ref.layer.append(node);
      ref.dockList.append(rec.dockLi);
      settle();
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
      settle();
    }

    return {
      init,
      open, close, focus, minimize, restore, maximize,
      moveTo, moveBy, resizeTo, resizeBy,
      get: (id) => (windows.has(id) ? snapshot(windows.get(id)) : null),
      list: () => Array.from(windows.values()).map(snapshot),
      focused: () => topId(),
      area: () => ({ ...area }),
    };
  })();

  /* Workspace ------------------------------------------------------------- */

  // Until the real tasks arrive, sample windows let people try the window controls.
  let sampleCount = 0;
  function openSample(opts) {
    sampleCount += 1;
    const content = el(
      'div',
      { class: 'sample' },
      el('p', { text: 'Drag the title bar to move this window. Drag any edge or corner to resize it.' }),
      el(
        'ul',
        { class: 'sample__tips' },
        el('li', { text: 'Double-click the title bar, or use the square button, to maximize and restore.' }),
        el('li', { text: 'Minimize sends the window to the dock. Select it there to bring it back.' }),
        el('li', { text: 'Moving windows by keyboard and by voice arrives in later phases.' }),
      ),
      el('button', { class: 'btn btn--ghost', type: 'button', 'data-open-sample': '', text: 'Open another sample window' }),
    );
    return WM.open({ id: `sample-${sampleCount}`, title: `Sample window ${sampleCount}`, content, ...opts });
  }

  function initWorkspace() {
    const desktop = $('#desktop');
    if (!desktop) return;
    WM.init({ desktop, layer: $('#windows'), dock: $('#dock'), dockList: $('#dock-list'), empty: $('#desktop-empty') });
    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-open-sample]')) openSample({ source: event.detail === 0 ? 'keyboard' : 'pointer' });
    });
  }

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
    initWorkspace();
  }

  App.router = Router;
  App.bus = Bus;
  App.wm = WM;
  App.motion = Motion;
  window.MultimodalDesktop = App;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
