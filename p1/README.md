# Multimodal Desktop

**A User-Controlled Multimodal Desktop Environment**
*Rethinking How Humans Interact With Computers*

An HCI research prototype: a simulated desktop where people complete three tasks (file organization, application navigation, desktop settings) with the mouse, the keyboard, their voice, or any mix of them. People switch modalities themselves; the system never switches for them. With consent, the prototype records genuine interaction data in the browser and shows it back in an Interaction Mirror.

> **Status: phase 1 of 20 (project skeleton).** The five sections exist and you can move between them. The desktop, tasks, voice and research features arrive in later phases.

## Run it

Open `index.html` in a current Chrome or Edge. There is no build step and nothing to install.

Voice input (phase 11 onward) works best when the folder is served over `localhost` or HTTPS, because the browser can then remember the microphone permission:

```bash
python3 -m http.server 8080   # then open http://localhost:8080
```

GitHub Pages also works, since it serves HTTPS.

## Roadmap

- [x] **1. Skeleton:** three files, dark theme, five-section navigation
- [ ] **2. Window manager:** drag, focus, minimize, close
- [ ] **3. State + accessibility:** store, restore, text size, contrast
- [ ] **4. Task engine:** steps, timer, completion check
- [ ] **5. Task 1, files:** folders, drag-drop, rename
- [ ] **6. Task 2, apps:** dock, open/switch/close
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
| `index.html` | Page structure: top bar, five sections, icon sprite |
| `style.css` | Design tokens, glass surfaces, layout, user-preference media queries |
| `script.js` | Behaviour. One namespace, `window.MultimodalDesktop`, extended each phase |

## Design notes (phase 1)

- **Three signal colours.** Mouse is cyan, keyboard is amber, voice is violet. They are reserved for the modalities and always appear next to an icon or a label, so colour never carries meaning alone.
- **No network requests.** System fonts, an inline icon sprite and an inline favicon. The page works offline and sends nothing anywhere.
- **Navigation.** Sections are addressed by URL hash (`#workspace`), so reload, back and forward work. Choosing a section moves keyboard focus to its heading. A skip link is the first tab stop.
- **Preferences honored.** Reduced motion, reduced transparency and forced-colors modes are respected from the start. Manual controls arrive in phase 3.
- **One orchestrated animation.** The home illustration draws itself in once. Section changes use a short fade. Nothing else moves on its own.

## Constraints

HTML5, CSS3, vanilla JavaScript, the Web Speech API, LocalStorage and optionally Chart.js. No frameworks, backend, database, AI APIs, authentication or 3D rendering.
