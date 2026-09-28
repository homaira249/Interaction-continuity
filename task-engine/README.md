# Multimodal Desktop

**A User-Controlled Multimodal Desktop Environment**
*Rethinking How Humans Interact With Computers*

An HCI research prototype: a simulated desktop where people complete three tasks (file organization, application navigation, desktop settings) with the mouse, the keyboard, their voice, or any mix of them. People switch modalities themselves; the system never switches for them. With consent, the prototype records genuine interaction data in the browser and shows it back in an Interaction Mirror.

> **Status: phase 4 of 20 (task engine and practice task).** The five sections exist. The Workspace desktop has floating windows that come back after a reload, an Accessibility panel changes text size, contrast, motion and transparency, and a task panel runs a timed practice task step by step. The three real tasks, voice and the research features arrive in later phases.

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
- [x] **4. Task engine:** steps, timer, completion check
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
| `index.html` | Page structure: top bar with the Accessibility button, five sections, the desktop with its window layer and dock, icon sprite, and a small script that applies saved display settings before the first paint. The task panel is built by `script.js` and placed just above the desktop. |
| `style.css` | Design tokens, glass surfaces, layout, windows and dock, the task panel, the Accessibility panel, user-preference rules |
| `script.js` | Behaviour. One namespace, `window.MultimodalDesktop`, extended each phase. Phase 4 added the task engine, the practice task and the task panel. |

## Tasks and the practice run (phase 4)

The strip above the desktop in the Workspace is the **task panel**. It offers a task, runs it and shows the result. The three real tasks arrive in phases 5 to 7. Until then there is one **practice task**: five steps that teach the window controls in about a minute. It does not count as one of the three tasks. It is flagged `practice` in its definition, so the analysis in later phases can leave it out.

**Using the panel**

| State | What the panel shows | Buttons |
| --- | --- | --- |
| Not started | The task's name, what it involves, how many steps it has and how the last run went. With several tasks, a choice between them. | Start |
| Running | The step to do now with a hint, "Step 2 of 5", the clock, and one bar segment per step | Pause, Restart, Stop task, Show steps |
| Paused | The same, with a "Paused" badge and a note on why | Resume, Restart, Stop task, Show steps |
| Finished | The time it took | Do it again, Choose another task |

- **Show steps** lists every step: a check for the finished ones, a dot for the current one. The list is part of the page, not a layer over it, so the desktop moves down while it is open. The choice is remembered for the next run.
- **Restart** and **Stop task** ask first, because they end the attempt. The attempt is kept as unfinished. Focus lands on "Keep going", so pressing Enter by accident does nothing, and Escape cancels the question.
- Everything works with the mouse or the keyboard. Each change (a step done, paused, resumed, finished) is announced to screen readers through a polite live region. The clock is not announced, because it would talk all the time.
- The panel is 7.5 rem tall (120 pixels at 100% text) when idle, running, paused and finished, so the desktop does not move when a task starts, pauses or ends. The Stop question makes it a little taller while it is open.
- It reflows with the text size like the rest of the page. From 320 to 1280 pixels wide, at every text size, nothing leaves the panel and every button stays at least 44 pixels tall and wide. In the narrowest case (a 320 pixel screen at 200% text) the buttons give up their icons and some padding to make room.

**The practice task** has five steps: maximize its window, return it to its normal size, minimize it, bring it back from the dock, and close it. Its window opens when you press Start, and each step can be done with the mouse or the keyboard (see Window manager). If the window is closed before the last step, it comes back in the state the current step expects, the slip is counted as an `error` on the run, and the panel says what happened. A window left over from an earlier run is reset when a new run starts.

**How a run behaves**

- Steps go in order. Only the first unfinished step is checked, and a finished step stays finished even if the person undoes it. Work that is already done when a run starts, or that was done during a pause, is credited when the next check runs: at the start, or the moment the run resumes.
- The clock counts only while the run is running. Pausing stops it.
- **Leaving the Workspace pauses the run** (reason `away`), because the panel is out of sight there. Coming back does not resume it. Nothing starts or resumes without the person pressing the button.
- **Reloading the page** brings a run back paused (reason `reload`) with its progress and its time as they were. The reload is counted on the run as an interruption, and the time the page was closed is not task time. A run that was already paused keeps its own reason, and that reload is not counted.
- The clock is written to storage every 5 seconds while the run is running, and when the page is hidden or closed. A tab in the background keeps running: switching tabs does not pause. If the computer sleeps in the middle of a run, whether the sleeping time is counted depends on the browser and the system, so pause before leaving a run unattended.
- Finished runs are kept, complete or not (the latest 1,000), with the time of each step on the run's own clock, the number of pauses and interruptions, and anything the task reported, such as errors.
- **Use one tab at a time.** There is no live sync between tabs (see Saved state), so two tabs running tasks overwrite each other's progress: the last one to save wins.
- **Clear saved data** ends a task in progress and forgets every run.

**A run, as it is saved**

```json
{
  "id": "run-2", "task": "practice", "status": "complete",
  "startedAt": 1764030000000, "finishedAt": 1764030061000, "elapsedMs": 58200,
  "step": 5, "total": 5,
  "steps": {
    "maximize":   { "at": 1764030009000, "atMs": 8100,  "trigger": "window:maximize",   "source": "pointer" },
    "unmaximize": { "at": 1764030015000, "atMs": 14000, "trigger": "window:unmaximize", "source": "pointer" }
  },
  "counts": { "error": 1 },
  "pauses": 1, "interruptions": 0, "pausedFor": "", "reason": "", "meta": {}
}
```

| Field | Meaning |
| --- | --- |
| `status` | `running`, `paused`, `complete` or `abandoned` |
| `elapsedMs` | Time on the run's own clock, with paused time left out |
| `step` | How many steps are done. `total` is how many there are. |
| `steps` | One entry per finished step. `atMs` is the run's clock when the step was found complete and `at` the time of day (milliseconds since 1970). `trigger` is what the engine was reading: a bus event such as `window:maximize`, or `start`, `resume` or `check`. `source` is where that event came from. |
| `counts` | Things the task reported during the run, such as `error` |
| `pauses`, `interruptions` | Times paused, and page reloads during the run |
| `pausedFor` | Why a paused run is paused: `user`, `away` or `reload` |
| `reason` | Why an unfinished run ended: `user`, `restart`, `unavailable` (its task no longer exists), or a short word the caller gave |
| `meta` | Whatever the caller passed to `start`, for the study condition later |

Everything read back from storage is checked like the rest of the saved state: a bad field gets its default, a bad record is skipped, and a run whose task no longer exists is kept as an unfinished run with the reason `unavailable`.

## Accessibility settings (phase 3)

Select **Accessibility** in the top bar. The panel is a dialog that does not block the page, so you can keep working with it open. Escape, the button, a press outside it, moving focus out of it with Tab, or going to another section closes it. Changes apply at once and are remembered in this browser.

| Setting | Options | What it does |
| --- | --- | --- |
| Text size | 100%, 115%, 130%, 150%, 200% | Scales text and everything measured in it: buttons, spacing, window sizes. The layout reflows instead of scrolling sideways, from 320 to 1280 pixels wide at every size. |
| Contrast | Standard, High | High gives a black background, white text, solid panels, stronger outlines and a thicker focus ring. Text and signal colours reach at least 7:1 on every surface. |
| Motion | Follow device, Reduce | Reduce turns off every animation and transition, and nothing waits for one. Follow device uses the operating system's reduced-motion setting. When the device already asks for it, the panel says so. |
| Transparency | Follow device, Solid | Solid swaps frosted glass for plain opaque panels. Follow device uses the operating system's setting. |

Each setting is a group of radio buttons: Tab moves between groups and the arrow keys choose within one.

**Reset display settings** puts the four settings back to their defaults and leaves your windows alone. **Clear saved data** removes everything this prototype has stored in the browser (for now display settings, open windows and task progress; later phases add research data), closes the windows and ends any task in progress. It asks first, in two steps. Focus lands on Cancel, so pressing Enter by accident does nothing, and the question never times out.

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
  },
  "tasks": {
    "counter": 2,
    "runs": [
      { "id": "run-1", "task": "practice", "status": "complete", "elapsedMs": 58200, "step": 5, "total": 5 }
    ],
    "active": { "id": "run-2", "task": "practice", "status": "paused", "elapsedMs": 21400, "step": 2, "total": 5 }
  }
}
```

The run records are trimmed here. Every field is listed under Tasks and the practice run. `active` exists only while a run is in progress, and `counter` is how many runs have been started, so a run id is never used twice. Later phases add their own sections (consent, the research log) to the same entry.

**Rules for reading and writing**

- Stored data is never trusted. Each setting is checked on its own: a value that is not on its list falls back to the default and the others are kept. Corrupt JSON or the wrong kind of data counts as empty and is replaced the next time something is saved.
- Every write re-reads the stored entry and changes only its own part. A section this version does not know, or a second tab's change, is not wiped by a tab that never saw it. Only **Clear saved data** removes the whole entry.
- A version number higher than this one is kept, never lowered.
- There is no live sync between tabs. A tab shows what it loaded plus what you change in it; another tab's changes appear the next time a page loads.
- If the browser blocks LocalStorage, or it is full, the prototype carries on from memory for that visit. The panel then says that changes will not be kept. Scripts can read the same thing from `store.status()`, and `state:storage` is sent if saving fails partway through a visit.

**Windows come back**

Open windows are saved with their position, size, minimized or maximized state and stacking order, and return after a reload. They return quietly: no window takes keyboard focus and no `window:*` events are sent, so a restore is never mistaken for something a person did. One `workspace:restored` event reports how many came back.

- Only windows made from a registered kind are saved. For now that is the sample window and the practice window; the tasks in phases 5 to 7 register their own kinds. A window opened with its own content is not saved.
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
| `open({ id, title, content, w, h, x, y, icon, kind, props, minimized, maximized, quiet, source })` | Opens a window, or focuses it if that `id` is already open. `content` is a DOM node or a function that fills the body. Give a registered `kind` (and plain-data `props` if it needs them) to have the window saved and restored. `minimized: true` or `maximized: true` opens it already in that state. `quiet: true` skips the opening animation, the focus move and the `window:open` event. `source` says which device asked, for the event. |
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
| `taskPanel.render()` | Redraws the task panel from the engine's state. It already redraws on every task event, so this is rarely needed. |

### `tasks`: the task engine

A task is a short, fixed list of steps. The engine looks after what every task shares: starting a run, judging its steps, the clock, pausing, stopping, saving and the history. It knows nothing about windows, files or settings. A task says what each step means with a check function that reads the app's state and answers yes or no.

| Call on `tasks` | What it does |
| --- | --- |
| `define(task)` | Registers a task. Returns `true`, or `false` with a console warning that says why (an unusable or repeated id, no title, no steps, a step without a check). |
| `start(id, { meta, source })` | Starts a run. Returns the run, or `null` when the task is unknown or a run is already going. `meta` holds up to 8 short keys of text, numbers or booleans and is kept on the run. |
| `pause({ reason, source })`, `resume({ source })` | Return the run, or `null` when there is nothing to pause or resume. `reason` is `user` (the default), `away` or `reload`; anything else counts as `user`. The engine itself uses `away` when you leave the Workspace and `reload` for a run that comes back after a reload. |
| `abandon({ reason, source })` | Ends the run as unfinished and returns it. `reason` is a short word, `user` by default. |
| `restart({ source })` | Ends the run as unfinished (reason `restart`) and starts the same task again from step 1 with the same `meta`. Returns the new run, or `null` when nothing was running. |
| `report(kind, detail, { source })` | Counts one thing that happened in the run, such as `error`. `kind` is lower-case letters, digits and dashes, starting with a letter, 24 at most. Returns `true` when counted. Only a running run takes reports, and a run keeps at most 12 kinds. |
| `check()` | Runs the checks now. Returns how many steps were newly completed. |
| `list()`, `get(id)` | The tasks as `{ id, title, label, summary, practice, steps: [{ id, title, hint }], last }`, where `last` is the latest finished run of that task, or `null` |
| `active()` | The run in progress, with `title`, `practice`, `current: { id, title, hint }` (or `null` after the last step), `note` (why the last check said "not yet") and a live `elapsedMs`; or `null` |
| `runs(taskId)` | Finished runs, complete or not, oldest first (the latest 1,000), optionally for one task. Each is a copy of the saved record with `title` and `practice` added. |
| `elapsed()` | Milliseconds on the current run's clock, or 0 when there is no run |
| `flush()` | Writes a running clock to storage now. This also happens when the page is hidden or closed. |
| `onTick(fn)` | Calls `fn` about four times a second while a run is running. Returns a function that unsubscribes. |

```js
MultimodalDesktop.tasks.define({
  id: 'practice',               // lower-case letters, digits and dashes, starting with a letter, 32 at most
  title: 'Practice: window controls',
  label: 'Practice',            // the short name in the picker
  summary: 'Learn the window controls in about a minute.',
  practice: true,               // a rehearsal, not one of the study tasks
  steps: [                      // 1 to 24 steps
    {
      id: 'maximize',
      title: 'Maximize the practice window',
      hint: 'Use the square button in its title bar.',
      events: ['window:maximize'],   // optional: only look when one of these has just happened
      check: (ctx) => Boolean(ctx.app.wm.get('practice')?.maximized),
    },
  ],
  setup(ctx) {},                // all four hooks are optional
  maintain(ctx) {},
  verify(ctx) { return true; },
  teardown(ctx) {},
});
```

- **Steps go in order.** A step is checked when a run starts, resumes or checks, and just after the bus announces something it listens for (steps without `events` listen to everything except task and storage news). A burst of events costs one check. When one step is found complete the next is checked at once.
- **Checks only read.** A check that throws is logged and counts as "not yet". `ctx` is `{ app, task, run, step, event, restoring, report }`: the whole app, the task id, a copy of the run, the step the run is on (`{ id, index, total }`; `null` inside `setup`, `verify` and `teardown`), the bus event that prompted this pass (`null` when the pass is based on state alone), `true` only inside `setup` for a restored run, and `report(kind, detail)`, which counts something on the run.
- `maintain(ctx)` is where a task may repair its surroundings, for example reopening a window that was closed too early. It runs before the checks.
- `setup(ctx)` runs after a run starts, and when a saved run comes back after a reload (then `ctx.restoring` is true).
- `verify(ctx)` runs after the last step. Only `true` finishes the run. Return a sentence (160 characters at most) to tell the person what is still missing; any other answer shows "Not finished yet.", and a `verify` that throws shows "The final check could not run." The run waits, and `verify` runs again after the next event on the bus, when `check()` is called and when the run resumes.
- `teardown(ctx)` runs after a run has ended, whichever way it ended.
- Text is trimmed to 80 (title), 24 (label), 200 (summary), 100 (step title) and 160 (hint) characters. A hook that throws is logged and skipped.

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
| `task:start` | `task, run, title, practice, total, meta, source` |
| `task:step` | `task, run, step, title, index, total, atMs, trigger, source` |
| `task:pause` | `task, run, reason` (`user`, `away` or `reload`), `elapsedMs, source` |
| `task:resume` | `task, run, elapsedMs, source` |
| `task:verify` | `task, run, ok: false, message`: the last check said "not yet". Sent once for each different message. |
| `task:report` | `task, run, kind, detail, count, source`. The practice task reports `error` with `detail.message`, which the panel announces. |
| `task:complete` | `task, run, elapsedMs, step, total, source, steps, counts, pauses, interruptions` |
| `task:abandon` | `task, run, elapsedMs, step, total, source, reason` |
| `tasks:registered` | `id` |
| `tasks:restored` | `active` (whether a run came back), `runs` (how many finished runs were found) |
| `tasks:cleared` | none (sent after Clear saved data) |
| `prefs:change` | `key, value, previous, source` |
| `prefs:reset` | `previous` (all four old values), `source` |
| `a11y:open`, `a11y:close` | `source` |
| `state:change` | `path, value, previous` (`value` is `undefined` after a removal) |
| `state:clear` | none |
| `state:storage` | `persistent: false, reason`, sent once if saving stops working partway through a visit |

A drag or a resize by pointer sends one event when it finishes, not one per pixel. `source` is `pointer`, `keyboard`, `voice` or `api`: the device the action came from (task events take anything else to mean `api`). It is not the modality the user chose; that arrives with the modality switcher in phase 10. A restore after a reload sends no `window:*` events at all, and a run that comes back after a reload sends only `tasks:restored`, not `task:pause`.

## Design notes

- **Three signal colours.** Mouse is cyan, keyboard is amber, voice is violet. They are reserved for the modalities and always appear next to an icon or a label, so colour never carries meaning alone.
- **Nothing resumes by itself.** A task paused by leaving the Workspace or by a reload waits for the person to press Resume, so the clock never runs while nobody is looking.
- **No network requests.** System fonts, an inline icon sprite and an inline favicon. The page works offline and sends nothing anywhere.
- **Navigation.** Sections are addressed by URL hash (`#workspace`), so reload, back and forward work. Choosing a section moves keyboard focus to its heading. A skip link is the first tab stop.
- **Preferences honored.** Reduced motion, reduced transparency and forced-colors modes are respected, including for windows and the dock, and the Accessibility panel adds manual controls for text size, contrast, motion and transparency.
- **One orchestrated animation.** The home illustration draws itself in once. Section changes use a short fade. Windows animate only in response to what the person does: opening, minimizing, maximizing and closing.

## Constraints

HTML5, CSS3, vanilla JavaScript, the Web Speech API, LocalStorage and optionally Chart.js. No frameworks, backend, database, AI APIs, authentication or 3D rendering.
