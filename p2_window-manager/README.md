# Multimodal Desktop

**A User-Controlled Multimodal Desktop Environment**
*Rethinking How Humans Interact With Computers*

An HCI research prototype: a simulated desktop where people complete three tasks (file organization, application navigation, desktop settings) with the mouse, the keyboard, their voice, or any mix of them. People switch modalities themselves; the system never switches for them. With consent, the prototype records genuine interaction data in the browser and shows it back in an Interaction Mirror.

> **Status: phase 2 of 20 (window manager).** The five sections exist, and the Workspace desktop has floating windows you can move, resize, maximize, minimize to a dock and close. The tasks, voice and research features arrive in later phases.

## Run it

Open `index.html` in a current Chrome or Edge. There is no build step and nothing to install.

Voice input (phase 11 onward) works best when the folder is served over `localhost` or HTTPS, because the browser can then remember the microphone permission:

```bash
python3 -m http.server 8080   # then open http://localhost:8080
```

GitHub Pages also works, since it serves HTTPS.

## Roadmap

- [x] **1. Skeleton:** three files, dark theme, five-section navigation
- [x] **2. Window manager:** drag, resize, focus, minimize, maximize, close
- [ ] **3. State + accessibility:** store, restore, text size, contrast
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
| `index.html` | Page structure: top bar, five sections, the desktop with its window layer and dock, icon sprite |
| `style.css` | Design tokens, glass surfaces, layout, windows and dock, user-preference media queries |
| `script.js` | Behaviour. One namespace, `window.MultimodalDesktop`, extended each phase |

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

- Windows stay inside the work area, which ends above the dock. Resizing stops at 280 by 180 pixels and at the edge of the work area. If the browser window shrinks, windows are pulled back inside.
- Minimizing and maximizing never forget a window's normal size and position. Restoring puts it back exactly where it was.
- Windows stay in the page when you open another section, so nothing is lost when you leave the Workspace and come back. (They are not yet kept across a page reload; that arrives with the state store in phase 3.)
- Keyboard focus is always somewhere sensible. A new or restored window takes focus. After minimizing, focus goes to the window's dock item. After closing, it goes to the next window, or to the Open button when none are left.
- Each window is a non-modal dialog named by its title. The dock item says "minimized" to screen readers when a window is minimized.
- With reduced motion on, nothing animates and nothing waits for an animation.
- On touch screens the window controls grow to 44 pixels.

**For later phases: the JavaScript API**

Everything the mouse does is also available as a function, so keyboard and voice can drive the same windows. Methods return a snapshot of the window (`id`, `title`, `x`, `y`, `w`, `h`, `minimized`, `maximized`, `focused`, `z`), or `null` when the id is unknown.

| Call on `window.MultimodalDesktop.wm` | What it does |
| --- | --- |
| `open({ id, title, content, w, h, x, y, icon })` | Opens a window, or focuses it if that `id` is already open. `content` is a DOM node or a function that fills the body. |
| `close(id)`, `focus(id)` | Closes or activates a window |
| `minimize(id)`, `restore(id)` | Sends a window to the dock, or brings it back |
| `maximize(id, { on })` | Toggles, or sets maximized with `on: true` or `on: false` |
| `moveTo(id, x, y)`, `moveBy(id, dx, dy)` | Moves the window, clamped to the work area |
| `resizeTo(id, w, h)`, `resizeBy(id, dw, dh)` | Resizes from the bottom-right corner, clamped |
| `get(id)`, `list()`, `focused()`, `area()` | Reads the current state |

Moving and resizing change a window's normal bounds. For a maximized window they take effect when it is restored.

**For later phases: the event bus**

Windows announce what happened on `window.MultimodalDesktop.bus`. Listen with `bus.on('window:move', (event) => ...)`, or `bus.on('*', ...)` for everything. `bus.on` returns a function that unsubscribes. Each event is `{ type, detail, at }`, with `at` in milliseconds since 1970.

| Event | Detail |
| --- | --- |
| `window:open` | `id, title, x, y, w, h, source` |
| `window:focus` | `id, title, source` |
| `window:move` | `id, title, x, y, from: { x, y }, source` |
| `window:resize` | `id, title, x, y, w, h, from: { x, y, w, h }, edge, source` |
| `window:minimize`, `window:restore`, `window:maximize`, `window:unmaximize`, `window:close` | `id, title, source` |

A drag or a resize by pointer sends one event when it finishes, not one per pixel. `source` is `pointer`, `keyboard` or `api`: the device the action came from. It is not the modality the user chose; that arrives with the modality switcher in phase 10.

## Design notes

- **Three signal colours.** Mouse is cyan, keyboard is amber, voice is violet. They are reserved for the modalities and always appear next to an icon or a label, so colour never carries meaning alone.
- **No network requests.** System fonts, an inline icon sprite and an inline favicon. The page works offline and sends nothing anywhere.
- **Navigation.** Sections are addressed by URL hash (`#workspace`), so reload, back and forward work. Choosing a section moves keyboard focus to its heading. A skip link is the first tab stop.
- **Preferences honored.** Reduced motion, reduced transparency and forced-colors modes are respected, including for windows and the dock. Manual controls arrive in phase 3.
- **One orchestrated animation.** The home illustration draws itself in once. Section changes use a short fade. Windows animate only in response to what the person does: opening, minimizing, maximizing and closing.

## Constraints

HTML5, CSS3, vanilla JavaScript, the Web Speech API, LocalStorage and optionally Chart.js. No frameworks, backend, database, AI APIs, authentication or 3D rendering.
