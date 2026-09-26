# Multimodal Desktop

**A User-Controlled Multimodal Desktop Environment**
*Rethinking How Humans Interact With Computers*

An HCI research prototype: a simulated desktop where people complete three tasks (file organization, application navigation, desktop settings) with the mouse, the keyboard, their voice, or any mix of them. People switch modalities themselves; the system never switches for them. With consent, the prototype records genuine interaction data in the browser and shows it back in an Interaction Mirror.

> **Status: phase 3 of 20 (saved state and accessibility settings).** The five sections exist. The Workspace desktop has floating windows that come back after a reload, and an Accessibility panel changes text size, contrast, motion and transparency. The tasks, voice and research features arrive in later phases.

## Run it

Open `index.html` in Chrome or Edge 105 or newer. There is no build step and nothing to install. The layout uses CSS container queries, which Safari 16 and Firefox 110 also have, so a browser from before 2023 will not lay the page out correctly. Each phase so far has been tested in Chrome.

Voice input (phase 11 onward) works best when the folder is served over `localhost` or HTTPS, because the browser can then remember the microphone permission:

```bash
python3 -m http.server 8080   # then open http://localhost:8080
```

GitHub Pages also works, since it serves HTTPS.

## Roadmap

- [x] **1. Skeleton:** three files, dark theme, five-section navigation
- [x] **2. Window manager:** drag, resize, focus, minimize, maximize, close
- [x] **3. State + accessibility:** store, restore, text size, contrast
- [ ] **4. Task engine:** steps, timer, completion check
- [ ] **5. Task 1, files:** folders, drag-drop, rename
- [ ] **6. Task 2, apps:** open, switch, close applications
- [ ] **7. Task 3, settings:** theme, volume, brightness, wallpaper
- [ ] **8. Keyboard shortcuts:** every task, help overlay
- [ ] **9. Undo + feedback:** undo/redo, toasts, errors
- [ ] **10. Modality switcher:** manual-only, indicator, Input Studio
- [ ] **11. Voice engine:** mic states, fallback, privacy notice
- [ ] **12. Voice commands:** every task action by voice
- [ ] **13. Consent + logger:** consent gate, event log, reset
- [ ] **14. Mirror, timeline + usage:** chronology, modality usage, transitions
- [ ] **15. Mirror, task analytics:** task times, errors, repeats
- [ ] **16. Conditions A/B:** single vs multimodal run flow
- [ ] **17. Comparison:** neutral A vs B side-by-side
- [ ] **18. Reflection:** ratings, questions, local save
- [ ] **19. Polish:** animations, glass, responsive
- [ ] **20. Final test + README:** full pass, docs

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure: top bar with the Accessibility button, five sections, the desktop with its window layer and dock, icon sprite, and a small script that applies saved display settings before the first paint |
| `style.css` | Design tokens, glass surfaces, layout, windows and dock, the Accessibility panel, user-preference rules |
| `script.js` | Behaviour. One namespace, `window.MultimodalDesktop`, extended each phase |

## Accessibility settings (phase 3)

Select **Accessibility** in the top bar. The panel is a dialog that does not block the page, so you can keep working with it open. Escape, the button, a press outside it, moving focus out of it with Tab, or going to another section closes it. Changes apply at once and are remembered in this browser.

| Setting | Options | What it does |
| --- | --- | --- |
| Text size | 100%, 115%, 130%, 150%, 200% | Scales text and everything measured in it: buttons, spacing, window sizes. The layout reflows instead of scrolling sideways, from 320 to 1280 pixels wide at every size. |
| Contrast | Standard, High | High gives a black background, white text, solid panels, stronger outlines and a thicker focus ring. Text and signal colours reach at least 7:1 on every surface. |
| Motion | Follow device, Reduce | Reduce turns off every animation and transition, and nothing waits for one. Follow device uses the operating system's reduced-motion setting. When the device already asks for it, the panel says so. |
| Transparency | Follow device, Solid | Solid swaps frosted glass for plain opaque panels. Follow device uses the operating system's setting. |

Each setting is a group of radio buttons: Tab moves between groups and the arrow keys choose within one.

**Reset display settings** puts the four settings back to their defaults and leaves your windows alone. **Clear saved data** removes everything this prototype has stored in the browser (for now display settings and open windows; later phases add research data) and closes the windows. It asks first, in two steps. Focus lands on Cancel, so pressing Enter by accident does nothing, and the question never times out.

Other details:

- Contrast has no "follow device" option. Windows high-contrast mode (forced colors) is honored separately: the chosen option is filled with the system highlight colour and the logo is drawn in the system text colour.
- Saved display settings are applied before the page first paints, by a small script in `<head>`, so a saved High contrast page never flashes the standard theme, even when `script.js` is slow to arrive. The script waits for the first animation frame before it reads LocalStorage, which is still ahead of the first paint. In testing, a read made while the page was still starting up sometimes got an empty answer when a `file://` page was reloaded in Chrome, and a read one frame later did not.
- On phones the button shrinks to its icon. It keeps its name for screen readers and a 44 pixel target, and the panel fits the screen and scrolls inside itself.
- Windows grow with the text size. Their smallest size is 17.5 by 11.25 rem, which is 280 by 180 pixels at 100%, and they are refitted when the size changes.

## Saved state (phase 3)

One LocalStorage entry, `multimodal-desktop:v1`, holds everything the prototype keeps. Nothing is sent anywhere. Nothing is written until something changes.

```json
{
  "v": 1,
  "prefs": { "textScale": 150, "contrast": "high", "motion": "system", "transparency": "reduce" },
  "workspace": {
    "windows": [
      { "id": "sample-1", "kind": "sample", "title": "Sample window 1",
        "x": 40, "y": 30, "w": 520, "h": 400, "minimized": false, "maximized": false }
    ],
    "counters": { "sample": 1 }
  }
}
```

Later phases add their own sections (task progress, consent, the research log) to the same entry.

**Rules for reading and writing**

- Stored data is never trusted. Each setting is checked on its own: a value that is not on its list falls back to the default and the others are kept. Corrupt JSON or the wrong kind of data counts as empty and is replaced the next time something is saved.
- Every write re-reads the stored entry and changes only its own part. A section this version does not know, or a second tab's change, is not wiped by a tab that never saw it. Only **Clear saved data** removes the whole entry.
- A version number higher than this one is kept, never lowered.
- There is no live sync between tabs. A tab shows what it loaded plus what you change in it; another tab's changes appear the next time a page loads.
- If the browser blocks LocalStorage, or it is full, the prototype carries on from memory for that visit. The panel then says that changes will not be kept. Scripts can read the same thing from `store.status()`, and `state:storage` is sent if saving fails partway through a visit.

**Windows come back**

Open windows are saved with their position, size, minimized or maximized state and stacking order, and return after a reload. They return quietly: no window takes keyboard focus and no `window:*` events are sent, so a restore is never mistaken for something a person did. One `workspace:restored` event reports how many came back.

- Only windows made from a registered kind are saved. For now that is the sample window; the tasks in phases 5 to 7 register their own kinds. A window opened with its own content is not saved.
- Saved windows are checked like everything else: an entry that makes no sense is skipped, a field that makes no sense gets its default, a title is always shown as text, and at most 24 windows return.
- Positions are pulled back inside the desktop if the screen is smaller than when they were saved. While the Workspace is hidden (for example after opening the page on Home) the desktop has no size yet, so saved positions are kept as they are and fitted the first time it is shown.
- Sample windows keep counting after a reload, so their titles never repeat.

## Window manager (phase 2)

The Workspace holds a desktop. Until the real tasks arrive in phases 5 to 7, the **Open a sample window** button lets you try the window controls.

**Using windows**

| To | With the mouse | With the keyboard |
| --- | --- | --- |
| Move | Drag the title bar | Arrives in phase 8 |
| Resize | Drag any edge or corner | Arrives in phase 8 |
| Maximize or restore | Double-click the title bar, or the square button | The square button (Tab, then Enter or Space) |
| Minimize | The dash button, or its dock item while the window is active | The dash button, or the dock item |
| Bring back a minimized window | Its dock item | Its dock item |
| Close | The cross button | The cross button |
| Bring to the front | Press anywhere on a window | Tab into it, or its dock item |

Moving and resizing by voice arrives in phase 12.

**How windows behave**

- Windows stay inside the work area, which ends above the dock. Resizing stops at the minimum size and at the edge of the work area. If the browser window shrinks, windows are pulled back inside.
- Minimizing and maximizing never forget a window's normal size and position. Restoring puts it back exactly where it was.
- Windows stay in the page when you open another section, so nothing is lost when you leave the Workspace and come back. They also come back after a reload (see Saved state).
- Keyboard focus is always somewhere sensible. A new window takes focus. After minimizing, focus goes to the window's dock item. After closing, it goes to the next window, or to the Open button when none are left.
- Each window is a non-modal dialog named by its title. The dock item says "minimized" to screen readers when a window is minimized.
- With reduced motion on, nothing animates and nothing waits for an animation.
- On touch screens the window controls grow to 44 pixels.

## For later phases: the JavaScript API

Everything the mouse does is also available as a function, so keyboard and voice can drive the same windows and settings. All of it lives on `window.MultimodalDesktop`.

### `wm`: windows

Methods return a snapshot of the window (`id`, `title`, `x`, `y`, `w`, `h`, `minimized`, `maximized`, `focused`, `z`), or `null` when the id is unknown.

| Call on `wm` | What it does |
| --- | --- |
| `open({ id, title, content, w, h, x, y, icon, kind, props })` | Opens a window, or focuses it if that `id` is already open. `content` is a DOM node or a function that fills the body. Give a registered `kind` (and plain-data `props` if it needs them) to have the window saved and restored. |
| `register(kind, build)` | Says how to fill a window of that kind. `build(body, { id, props })` is called whenever such a window is built, whether it is opened new or restored. |
| `close(id)`, `focus(id)` | Closes or activates a window |
| `minimize(id)`, `restore(id)` | Sends a window to the dock, or brings it back |
| `maximize(id, { on })` | Toggles, or sets maximized with `on: true` or `on: false` |
| `moveTo(id, x, y)`, `moveBy(id, dx, dy)` | Moves the window, clamped to the work area |
| `resizeTo(id, w, h)`, `resizeBy(id, dw, dh)` | Resizes from the bottom-right corner, clamped |
| `serialize()` | The saveable windows as plain data, bottom of the stack first |
| `restoreAll(list)` | Quietly brings back windows from `serialize()` data, checking every field. Returns how many came back. |
| `closeAll({ quiet })` | Closes every window. `quiet: true` skips the animation, the events and the focus hand-off. |
| `get(id)`, `list()`, `focused()`, `area()` | Reads the current state |

Moving and resizing change a window's normal bounds. For a maximized window they take effect when it is restored.

### `prefs`: display settings

| Call on `prefs` | What it does |
| --- | --- |
| `get(key)`, `get()` | One setting, or a copy of all four |
| `set(key, value)` | Returns `true` when the value is on the allowed list and changes the setting. Returns `false` for an unknown setting, a value that is not allowed (`'150'` is not `150`), or no change. |
| `reset()` | Puts the four settings back to their defaults and removes them from storage. Anything else under `prefs` is kept. |
| `options(key)`, `fallback(key)`, `keys` | The allowed values, the default, and the four setting names |

Keys and values: `textScale` (100, 115, 130, 150, 200), `contrast` (`'standard'`, `'high'`), `motion` (`'system'`, `'reduce'`), `transparency` (`'system'`, `'reduce'`).

### `store`: saved state

| Call on `store` | What it does |
| --- | --- |
| `get(path, fallback)` | Reads a value by dotted path, such as `'workspace.windows'`. Returns a copy, or `fallback` when nothing is there. |
| `set(path, value)` | Saves anything JSON can hold. Returns `false` for `undefined`, a function, a value JSON cannot hold, or a path that reaches `__proto__`, `constructor` or `prototype`. It returns `true` even when the browser will not save, because the value is still kept in memory for the visit. |
| `remove(path)` | Deletes a value. Returns whether anything was there. |
| `clear()` | Removes the whole entry, including sections this version does not know |
| `persistent()`, `status()` | Whether saving works: `{ persistent, reason }`, where `reason` is `'blocked'` or `'full'` when it does not |
| `key` | The LocalStorage key |

The store does not know what it holds. Whoever owns a section checks it when reading it.

### `workspace` and `a11y`

| Call | What it does |
| --- | --- |
| `workspace.openSample()` | Opens the next numbered sample window |
| `workspace.flush()` | Writes a pending save now (this also happens when the page is hidden or closed) |
| `workspace.clear()` | Closes every window quietly and starts the numbering again |
| `workspace.counter()` | How many sample windows have been opened |
| `a11y.open()`, `a11y.close()`, `a11y.isOpen()` | Controls the Accessibility panel |

### Events

Everything announces itself on `window.MultimodalDesktop.bus`. Listen with `bus.on('window:move', (event) => ...)`, or `bus.on('*', ...)` for everything. `bus.on` returns a function that unsubscribes. Each event is `{ type, detail, at }`, with `at` in milliseconds since 1970.

| Event | Detail |
| --- | --- |
| `window:open` | `id, title, x, y, w, h, source` |
| `window:focus` | `id, title, source` |
| `window:move` | `id, title, x, y, from: { x, y }, source` |
| `window:resize` | `id, title, x, y, w, h, from: { x, y, w, h }, edge, source` |
| `window:minimize`, `window:restore`, `window:maximize`, `window:unmaximize`, `window:close` | `id, title, source` |
| `workspace:restored` | `count` |
| `prefs:change` | `key, value, previous, source` |
| `prefs:reset` | `previous` (all four old values), `source` |
| `a11y:open`, `a11y:close` | `source` |
| `state:change` | `path, value, previous` (`value` is `undefined` after a removal) |
| `state:clear` | none |
| `state:storage` | `persistent: false, reason`, sent once if saving stops working partway through a visit |

A drag or a resize by pointer sends one event when it finishes, not one per pixel. `source` is `pointer`, `keyboard` or `api`: the device the action came from. It is not the modality the user chose; that arrives with the modality switcher in phase 10. A restore after a reload sends no `window:*` events at all.

## Design notes

- **Three signal colours.** Mouse is cyan, keyboard is amber, voice is violet. They are reserved for the modalities and always appear next to an icon or a label, so colour never carries meaning alone.
- **No network requests.** System fonts, an inline icon sprite and an inline favicon. The page works offline and sends nothing anywhere.
- **Navigation.** Sections are addressed by URL hash (`#workspace`), so reload, back and forward work. Choosing a section moves keyboard focus to its heading. A skip link is the first tab stop.
- **Preferences honored.** Reduced motion, reduced transparency and forced-colors modes are respected, including for windows and the dock, and the Accessibility panel adds manual controls for text size, contrast, motion and transparency.
- **One orchestrated animation.** The home illustration draws itself in once. Section changes use a short fade. Windows animate only in response to what the person does: opening, minimizing, maximizing and closing.

## Constraints

HTML5, CSS3, vanilla JavaScript, the Web Speech API, LocalStorage and optionally Chart.js. No frameworks, backend, database, AI APIs, authentication or 3D rendering.
