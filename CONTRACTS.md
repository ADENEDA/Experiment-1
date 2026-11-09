# Gridbook Studio — engineering contracts

This is the source of truth for how modules fit together. The product spec is `docs/SPEC.md`.
If you need to change a contract, keep it backward compatible and update this file in the same change.

## 0. Ground rules

- **Static site, no build step.** Everything deployable lives in `site/`. Plain HTML/CSS and native ES modules.
  Dev-only scripts and tests live in `tools/` (Node 22, no npm dependencies — use only `node:` built-ins).
- **All URLs are relative** (`../css/tokens.css`, `./js/ui/app.js`, `new URL('../fonts/x.ttf', import.meta.url)`).
  Never start a path with `/`. The site must work at a domain root *and* under a sub-path (e.g. GitHub Pages project URL).
- **Engines are pure.** Files in `site/js/puzzles/`, `site/js/layout/`, `site/js/kdp/`, `site/js/core/` must not touch
  `document`/`window`/`localStorage`, must not use `Math.random()` or `Date.now()` (use the seeded rng; deadlines may use
  `now()` from `puzzles/common.js`). They must import and run in Node 22 for tests. Browser-only helpers are named
  explicitly (e.g. `puzzles/picture-raster.js`, `render/canvas-backend.js`) and are never imported by pure modules.
- **Fonts:** Atkinson Hyperlegible Regular/Bold (OFL), `site/fonts/`. Measure text only with `core/fontmetrics.js`.
  Only glyphs listed in `fontmetrics-data.js` exist: printable ASCII, Latin-1, curly quotes, en/em dash, bullet `•`,
  ellipsis `…`, middle dot `·`, `×`. **There are no arrows, check marks, stars or hearts in the font** — draw those as shapes.
- **Ink:** grayscale only (gray 0 = black, 1 = white). No RGB in any display list. Minimum stroke 0.75pt.
  Non-white fills must be ≤ 0.9 gray (≥ 10% ink). Minimum text size 7pt anywhere in print output.
- **Tests:** `npm test` (= `node --test "tools/test/**/*.test.mjs"`) must pass. Name files `tools/test/<area>.test.mjs`.
- **No external network at runtime** except: Gumroad overlay script + `api.gumroad.com` license verify, Polar validate.
- Wrap every `localStorage` access in try/catch; the app must work without it.

## 1. Units and coordinates

Points (1/72 in) everywhere in layout/render. Origin = top-left of the PDF page, y downward. `kdp/specs.js` works in inches
and exports `inToPt` / `ptToIn`.

## 2. Display list (`site/js/layout/displaylist.js`)

A page is `{ w, h, ops }` (pt). Ops (plain JSON, drawn in order):

```
{t:'text',  x, y, s, size, weight:'regular'|'bold', align:'left'|'center'|'right', gray}   // y = baseline
{t:'line',  x1, y1, x2, y2, w, gray, cap:'butt'|'round'|'square', dash?:[on,off]}
{t:'rect',  x, y, w, h, r?, stroke?:{w, gray, dash?}, fill?:gray}
{t:'poly',  pts:[x0,y0,x1,y1,...], closed, stroke?:{w, gray, cap?, join?}, fill?:gray}
{t:'circle',cx, cy, r, stroke?:{w, gray}, fill?:gray}
```

Use the constructors (`text`, `line`, `rect`, `poly`, `circle`, `textInBox`) and helpers (`bbox`, `unionBox`, `transform`).
Both backends (canvas preview, PDF) must render every op type identically. Text alignment is resolved by the backends
using `fontmetrics.measure` (not the PDF library's own align), so preview == print.

## 3. Puzzle engine contract (`site/js/puzzles/<type>.js`)

Registered in `puzzles/registry.js` (`TYPES`, `TYPE_ORDER`, `getType(id)`). Each module exports:

```js
export const meta = {
  id: 'sudoku',                 // registry key
  name: 'Sudoku',               // singular display name
  plural: 'Sudoku',             // for section titles / menus
  blurb: 'Classic number placement, graded by logic.',
  howTo: ['Paragraph…', '…'],   // "How to solve" page text. Supported glyphs only.
  perPage: [1, 2, 4],           // allowed puzzles-per-page values for this type
  defaultPerPage: 1,
  answerPerPage: [4, 6, 9],     // allowed mini-solutions per answer page
};

// UI-renderable option schema. The Studio inspector renders these generically.
// kind: 'select' {options:[{value,label}]} | 'range' {min,max,step} | 'toggle' | 'text'
//       | 'words' (word list editor; value = string[] or {themeId}) | 'picture' (nonogram source; custom panel)
// `when` (optional): (opts) => boolean — show control only if true.
export const controls = [ { key:'size', label:'Grid size', kind:'select', options:[…] }, … ];

export function defaults(themeId /* 'standard'|'large'|'kids' */) { return { /* section opts */ }; }

// Pure + deterministic for a given (opts, rng.seed, ctx.index). ctx = { deadline, index, count }:
//   deadline = absolute now() ms (throw GenTimeout past it); index = 0-based puzzle number within the section
//   (used to rotate word-search themes / nonogram pictures); count = section size.
export function generate(opts, rng, ctx = {}) {
  return {
    type: 'sudoku', v: 1,
    title: 'optional puzzle subtitle shown on the puzzle page (e.g. word-search theme)',
    answerTitle: 'optional; shown only in the answer key (e.g. nonogram picture name)',
    data: {/* what the solver sees */}, solution: {/* answer */},
    stats: { grade: 'Medium', ms: 12, notes: [] },
  };
}

export function verify(puzzle) { return { ok: true } /* or { ok:false, reason:'…' } */; }

// Draw into `box` ({x,y,w,h} pt). MUST keep every op inside box. Center the content in the box.
// mode: 'puzzle' (page), 'answer' (full-size solution), 'mini' (answer-key thumbnail; may omit word lists).
// style = theme object from layout/themes.js (sizes, min/pref font sizes, line weights, gray levels).
// Return warnings (e.g. 'Letters are 9pt; Large Print needs ≥18pt — use fewer puzzles per page or a smaller grid').
export function draw(puzzle, box, style, mode) { return { ops: [], warnings: [] }; }
```

Shared helpers: `puzzles/common.js` (`GenTimeout`, `now`, `deadlineChecker`, `bitsToB64`, `b64ToBits`).
Seeded RNG: `core/rng.js` (`makeRng(seed)` → `{next,int,range,pick,shuffle,chance,fork}`; `puzzleSeed(bookSeed, section, i)`).

## 4. Project model (JSON, `v: 1`) — saved to localStorage and `.gridbook.json`

```json
{
  "v": 1, "id": "b_k3j2h1x", "seed": "7f3k2qa",
  "title": "Large Print Word Search", "subtitle": "100 Puzzles for Adults", "author": "Your Name", "year": 2026,
  "trim": "8.5x11", "paper": "white", "bleed": false, "theme": "large",
  "front": { "title": true, "copyright": true, "belongs": true, "howto": true, "contents": false },
  "sections": [
    { "id": "s1", "type": "wordsearch", "title": "Animals", "count": 30, "perPage": 1, "divider": false,
      "opts": { }, "salt": 0, "seeds": { "7": "user-regen-x81" }, "locked": { "7": true } }
  ],
  "answers": { "perPage": 6, "position": "end" },
  "back": { "thanks": true, "notes": true },
  "pageNumbers": true, "header": "", "credit": false,
  "copyrightText": null,
  "createdAt": "2026-11-09T10:00:00Z", "updatedAt": "2026-11-09T10:00:00Z"
}
```

- `answers.position`: `"end"` | `"after-section"` | `"none"`.
- Puzzle *i* of a section uses seed `puzzleSeed(project.seed, section, i)`.
- `section.opts` is the engine's option object (from `defaults()` + user edits). Nonogram pictures are stored inside opts as bitsets.

## 5. Generation (`site/js/puzzles/generate.js`)

```js
// Generates (or returns cached) puzzles for a section. Uses a module-worker pool (workers/gen.worker.js) when available,
// falling back to the main thread in yielding chunks. Cache key = type + JSON(opts) + seed.
export async function generateSection(project, section, { onProgress, signal, deadlineMs = 3000 } = {}) → Array<puzzle|{error}>
export async function generateOne(type, opts, seed, { deadlineMs }) → puzzle
export function clearCache()
```

## 6. Layout (`site/js/layout/book.js`)

```js
// puzzles: { [sectionId]: Array<puzzle|null|{error}> } (null = not generated yet → placeholder box)
// target: 'kdp' (trim/gutter/page count rules) or 'printable' (Letter/A4, 1 puzzle per page, answers at the end, no front matter
//         except an optional title page; free edition limited to CONFIG.free.printableMaxPuzzles puzzles).
export function layoutBook(project, puzzles, { pro = false, target = 'kdp', printableSize = 'letter', limit } = {}) → {
  pages: [{ w, h, ops, side:'R'|'L', num, kind, label, contentBox:{x,y,w,h},
            refs:[{ sectionId, index, box, mode:'puzzle'|'answer'|'mini' }] }],
  meta: { target, pageCount, trim, pageW, pageH, gutterIn, margins:{top,bottom,outside,inside} /* in */, spineIn, maxPages,
          watermarked, warnings: [] }
}
```

- Page 1 is a right-hand (recto) page. Odd = R (inside margin on the left), even = L.
- Gutter = `gutterFor(finalPageCount)` + 0.125 in safety; iterate layout at most twice if the tier changes.
- Pad to ≥ 24 pages and an even count using lined Notes pages (never long runs of blank pages).
- **Free edition (`pro:false`) watermark:** every page gets `FREE PROOF · made with Gridbook Studio · <printDomain>` in the
  bottom margin and `Proof copy · not for sale` in the top margin (8pt, gray 0.55), outside the content box. Printables get
  `Free printable from <printDomain> · make your own puzzle book` instead. `meta.watermarked = true`.
- Kinds: `title`, `copyright`, `belongs`, `howto`, `contents`, `divider`, `puzzle`, `answers`, `thanks`, `notes`, `blank`.

Text helpers in `layout/text.js`: `wrap(text, width, size, weight)` → lines, `paragraph(...)` → ops + height, `fitText(...)`.

## 7. KDP helpers

- `kdp/specs.js` — trims, gutter tiers, spine, cover size (already written; tests assert its values).
- `kdp/preflight.js` — `preflight(project, book, puzzles, { pro }) → { ok, errors:[{code,msg,page?}], warnings:[…] }`.
  Checks: page count ≥ 24 & even & ≤ max; margins ≥ tier; every op bbox inside page safe area (≥ 0.25 in from trim, or
  0.375 in with bleed; watermark text excepted only if it is itself inside the safe area); font ≥ 7pt; line ≥ 0.75pt;
  fills ≤ 0.9 gray; watermark present (free) → error "Free proof: not publishable"; every puzzle `verify()` ok; every
  puzzle has an answer (unless answers are off — then a warning).
- `kdp/cover.js` — `coverTemplate(project, pageCount, { pro }) → { w, h, ops }` (pt): full-wrap guide with bleed, trim, spine
  (and spine-text-allowed note), safe zones, barcode box, labels, and the book title/author for orientation.

## 8. Rendering & export

- `render/fonts.js` — `ensureFonts()` registers `FontFace('GBS Atkinson', …)` regular/bold for canvas (resolves when loaded);
  `fontBase64()` → `{ regular, bold }` base64 TTF strings for the PDF.
- `render/canvas-backend.js` — `drawOps(ctx, ops, { scale = 1 })`, `renderPageToCanvas(canvas, page, { cssWidth, dpr })`.
  Uses `ctx.fontKerning = 'none'`; text alignment via fontmetrics.
- `render/pdf-backend.js` — **classic-script compatible** (no `import`/`export`): defines
  `globalThis.GBSPdfBackend = { buildPdf(jsPDF, pages, fonts, { title, author, onProgress }) → ArrayBuffer }`.
  Must be loadable via `importScripts()` in a classic worker, `import './pdf-backend.js'` in modules, and in Node tests.
  Creates `new jsPDF({ unit:'pt', format:[w,h], putOnlyUsedFonts:true, compress:true })`; grayscale via single-number colors.
- `render/export-pdf.js` — `exportPdf(pages, { title, author, onProgress, signal }) → Promise<Blob>` (worker
  `workers/pdf.worker.js` with main-thread fallback that loads `vendor/jspdf-4.2.1.umd.min.js` via a script tag);
  `exportPng(page, { dpi = 300 }) → Promise<Blob>`; `downloadBlob(blob, filename)`; `safeFilename(...)` (ASCII only).
- `site/vendor/package.json` is `{"type":"commonjs"}` so Node tests can `createRequire` the UMD jsPDF.

## 9. License (`site/js/license/license.js`)

```js
export async function initLicense()            // read cache, unlock instantly if cached Pro, background re-check if stale
export function getLicense()                   // { status, tier:'free'|'lifetime'|'pass', expiresAt, keyHint, message }
export function isPro()                        // true for pro-lifetime, pro-pass (unexpired), pro-offline-grace
export async function activate(key)            // Gumroad: try lifetime product, then pass product; or Polar
export async function activateOfflineCode(code)
export function deactivate()
export function onLicenseChange(cb)            // returns unsubscribe
```
Statuses: `free | checking | pro-lifetime | pro-pass | pass-expired | invalid | revoked | pro-offline-grace | too-many-devices`.
UI: `ui/unlock-dialog.js` → `openUnlockDialog({ reason })`; `ui/buy-buttons.js` → `renderBuyButtons(container, { compact })`.
Gating happens **once, at export time** (`isPro()` passed to `layoutBook({ pro })`).

## 10. Design system

`site/css/tokens.css` defines colors, type scale, spacing and base components (`.btn`, `.btn-primary`, `.btn-highlight`,
`.btn-ghost`, `.btn-sm/lg/icon`, `.field`, `.input`, `.select`, `.textarea`, `.seg`, `.switch`, `.card`, `.badge`,
`.badge-pro`, `.pill-ok/warn/err`, `kbd`, `dialog.gbs-dialog` with `.dialog-head/body/foot`, `.toasts/.toast`).
Light + dark themes via `prefers-color-scheme` and `:root[data-theme]`. Page previews are always white paper.
Use these tokens; don't hard-code colors elsewhere. Icons: inline SVG (stroke `currentColor`, 1.75px, 24 viewBox).

## 11. Phase-1 amendments (as built; these override the sections above where they differ)

**§3 engines**
- Word search `wordSource` (control kind `words`): `{mode:'themes', themes:'all'|string[]}` or `{mode:'custom', words:string[]|string, title?}`. Older forms (plain `string[]`, `{themeId}`) are still accepted. Word data is `site/data/wordlists.js` (`THEMES`, `CATEGORIES`, `THEME_BY_ID`) and `site/data/blocklist.js`; shapes are `MASK_LIST` in `puzzles/masks.js`. The word-list panel uses `validateWords`, `parseWordList`, `aiPrompt` from `puzzles/wordsearch.js`; issues carry `{word, problem, code, severity}` (codes include `blocked`, shown as info). Theme preview for puzzle *i* must call `themeForIndex(wordSource, i, section.opts)`.
- Nonogram opts: `{size, source:'library'|'random'|'custom', library:{pictures:string[]|'all', category}, custom:{pictures:[{id,name,w,h,bits}]}, density, showGivens}`. The real grid is `data.w × data.h`. `title` is `''`, `answerTitle` is the picture name. Picture data: `site/data/pictures.js` (`PICTURES`, `PICTURE_CATEGORIES`, `PICTURE_SIZES`). Picture panel: `listPictures(opts)`, `CUSTOM_MAX` (40), `pictureName()`, and from `picture-raster.js` `imageToBits / thresholdCells / loadImage / pathToBits / bitsToDataURL`. Badge text comes from `puzzle.stats.notes`.
  A seed ending in `#pic=<picture id>` makes a library or custom puzzle show that picture (when it is in the section's list) instead of picture *i*; other seeds keep the list order. Helpers: `seedPick(seed)`, `pictureChoices(opts)` (ids in order, `[]` for random shapes), `pictureIdAt(opts, seed, index)`.
- Sudoku `size` values are numbers (9/6/4). The inspector must keep option values in their declared type, or cache keys will differ. Mazes: `fitPreset(presetId, boxW, boxH)`. Suggest `corners-sides` openings for 2 per page.
- Engines may throw a plain `Error` with a readable message (for example, a custom word list where no word fits). generate.js passes it on as `{error}`.

**§5 generate.js**
- The cache key is type + sorted-key JSON opts + seed + index (ctx.count is excluded). Each job gets its own copy of opts.
- `generateOne(type, opts, seed, {index, count, deadlineMs, signal})` rejects on failure (with a `GenTimeout` when it times out). `generateSection` rejects only on abort. Failures come back as error entries `{error, seed, index, timeout?}`, and progress as `onProgress(done, total, index?, entry?)`.
- Other exports: `cachedSection(project, section)` (a synchronous cache peek, for instant previews), `configureGeneration`, `generationInfo`, `terminateWorkers`, `runJob`.
- Deadlines are computed inside the worker, so performance.now() origins never mix. Treat cached puzzles as read-only.

**§6 layoutBook**
- Options: `types` (for test injection), `answersOnly`, `limit`. A null, undefined or '' limit means no limit. Free printables are also capped at `CONFIG.free.printableMaxPuzzles`.
- `meta.warnings` entries are objects `{code, msg, page?, pages?, sectionId?}`. pageW and pageH are in pt; margins are in inches from the page edge and include the bleed.
- Extra meta fields: `trimLabel, pageSizeIn, bleed, safe, theme, paper, answersOnly, paddedPages, puzzleCount, totalPuzzles, sections[]`.
- Extra page fields: `safeBox, trimBox, sectionId`. Each `refs[]` entry has `num`, the book-wide puzzle number. Answer refs use mode `'mini'`.
- Project fields read: `pageNumbers` (true|'outside'|'center'|false|'none'), `back.notes` (true or a page count), `thanksText`, `spineText`. `year` falls back to `createdAt`.
- Other exports: `watermarkText()` and `isWatermarkOp()`; from text.js, `normalizeText()` and `unprintableChars()`.
- Paper is `white` or `cream` only: the UI must not offer groundwood.

**§7 preflight / cover**
- preflight takes extra options `types` and `fileName`, and returns extra fields `info` and `stats`. `safeArea()` is exported.
- Large Print: text inside a puzzle box may go down to `themes.large.min.clue` (14pt). Text elsewhere needs 16pt. Answer pages get a single info note.

**§8 render**
- `fontBase64()` is async. Other exports: `fontBytes()`, `fontsReady()`, `FONT_FAMILY`. Await `ensureFonts()` before the first canvas render.
- `renderPageToCanvas` returns `{scale, width, height}`. Also exported: `drawPageThumb(canvas, page, {cssWidth=120, dpr, greekBelowPx=3})` and `renderPageAtDpi(page, dpi)`.
- `buildPdf` opts accept `metrics` (FONT_DATA) or `measure`, plus `subject` and `keywords`. jsPDF needs an explicit `orientation`. A single-number jsPDF colour means gray×255. Unknown op types throw in the PDF backend; the canvas backend skips them. Pages over 14400pt are rejected. Soft hyphens are dropped everywhere.
- `exportPdf` opts: `subject, keywords, useWorker` (default true). Also exported: `lastPdfExportPath()`, `disposePdfWorker()`, `setPngDpi()`. `safeFilename(base, '.pdf')`.

**§9 license**
- `getLicense()` also returns `pro, badge, provider, graceEndsAt, validatedAt, reason`. Gate on `isPro()` or `license.pro` only, never on status or badge strings: status is `'checking'` while a cached Pro license is being re-verified.
- `activate()` and `activateOfflineCode()` resolve `{ok, status, reason, message, license}`. `reason:'kept-current'` means a longer Pro license is already active.
- `onLicenseChange(cb)` calls `cb(license, {cause, prev, notice})`. Show `notice` as a toast when it is set.
- Possible reasons include `reconnect` (offline grace ended; show `getLicense().message` in the export dialog) and `test-ended`.
- `openUnlockDialog({reason})` returns `Promise<{pro, license}>`, with reason `'badge'|'export'|'printable'|'png'|'zip'|'credit'`. `renderBuyButtons(el, {compact})`. `closeUnlockDialog()`.
- Extra localStorage key: `gbs.license.counted`. If a CSP is ever added, it must allow `https://assets.gumroad.com` (script and style).

## 12. Studio UI (`site/app/`, `site/js/ui/`)

Plain DOM + ES modules, no framework. UI code may use `document`, `localStorage` (wrapped) and `Math.random` (for new seeds/ids).
Every interactive element: real `<button>`/`<input>`/`<select>`, visible focus ring, `aria-*` where needed, ≥ 44px targets on
`(pointer: coarse)`. All colours from `tokens.css`. Each UI module owns one CSS file, linked from `site/app/index.html`.

### 12.1 Files and owners
| Owner | Files |
|---|---|
| shell | `site/app/index.html`, `site/css/app.css`, `js/core/{store.js, bus.js, project.js}`, `js/ui/{app.js, dom.js, persist.js, pipeline.js, topbar.js, outline.js, statusbar.js, toasts.js, shortcuts.js}` |
| preview | `js/ui/preview.js` (+ helpers `js/ui/preview-*.js`), `site/css/preview.css` |
| inspector | `js/ui/{inspector.js, controls.js, wordlist-panel.js, picture-panel.js, pixel-editor.js}`, `site/css/inspector.css` |
| export | `js/ui/export-dialog.js` (+ `js/ui/export-*.js`), `site/css/export.css` |
| templates | `js/ui/templates.js`, `site/css/templates.css`, `site/img/templates/*` (optional) |
| license (done) | `js/ui/{unlock-dialog.js, buy-buttons.js}`, `site/css/license.css` |

### 12.2 `js/core/store.js` (pure)
```js
createStore(initial, { history = 100, coalesceMs = 1000 } = {}) → {
  get(),                                  // current state — treat as read-only
  update(mutator, { label, coalesce }),   // mutator(draft): mutate a structuredClone; one undo step.
                                          // Same `coalesce` key within coalesceMs merges into the previous step (sliders, typing).
  set(next, { label }),                   // replace whole state as one undo step
  reset(state),                           // replace and clear history (open project / template)
  undo(), redo(), canUndo(), canRedo(), undoLabel(), redoLabel(),
  subscribe(fn) → unsubscribe,            // fn(state, prev, { source:'update'|'set'|'undo'|'redo'|'reset', label })
}
```
`history: 0` gives a plain observable store (used for UI state).

### 12.3 `js/core/project.js` (pure; `newId` from rng.js is the only randomness)
`newProject(overrides)`, `newSection(type, themeId, overrides)` (opts from `getType(type).defaults(themeId)`, perPage =
`meta.defaultPerPage`, title = `meta.plural`), `normalizeProject(raw)` (fills every §4 default, clamps `count` to 1..500,
snaps `perPage`/`answers.perPage` to allowed values, keeps unknown fields), `parseProjectFile(text)` (→ project, or throws
an Error with a human message), `serializeProject(p)` (pretty JSON), `projectFileName(p)` (ASCII,
`<title-slug>.gridbook.json`), `pinSeed(section, index, bookSeed)` and `freshSeed()` helpers for regenerate/lock.
Picture-list nonograms (library or custom pictures): a new seed alone brings the same picture back, so Regenerate uses
`usesPictureList(section)` (number of pictures, 0 otherwise), `regeneratePicture(section, index, bookSeed, rand, avoid?)`
and `regenerateSectionPictures(section, bookSeed, rand, avoid?)`, which write `<freshSeed>#pic=<id>` seeds choosing
pictures no other puzzle shows (`rand` is passed in, so the module stays pure; `avoid` = `otherSectionPictures(project,
sectionId)`, the pictures of the book's other picture sections). `sectionPictures(section, bookSeed)` lists the picture
each puzzle shows. `app.actions.regenerate` / `regenerateSection` use them (a one-picture section gets an explanatory
toast instead), and `addSection` / `duplicateSection` give a new picture section pictures the other sections don't show.

### 12.4 The `app` context (created by `js/ui/app.js`, passed to every mount function)
```js
app = {
  config,                 // CONFIG
  store,                  // undoable project store (project model §4)
  ui,                     // UI-state store, history 0 — shape below
  bus,                    // js/core/bus.js: on(evt, fn) → off, off(evt, fn), emit(evt, payload)
  getBook(),              // latest pipeline result (below); never null after boot
  actions: {
    addSection(type) → id, removeSection(id), duplicateSection(id), moveSection(id, delta),
    updateSection(id, mutator, { label, coalesce }),   // store.update scoped to one section
    updateProject(mutator, { label, coalesce }),
    select(selection),                                 // sets ui.selection (+ inspectorTab)
    selectPuzzle(sectionId, index),                    // selection + inspectorTab 'puzzle' + goToPage(page of that puzzle)
    goToPage(pageIndex), pageOfPuzzle(sectionId, index) → pageIndex | -1,
    regenerate(sectionId, index),                      // new seed in section.seeds[index] unless locked
    regenerateSection(sectionId),                      // pin locked seeds, bump salt
    toggleLock(sectionId, index),                      // lock pins the current seed into seeds[index]
    openExport(), openUnlock(reason), openTemplates({ firstRun }), openShortcutHelp(),
    saveProjectFile(), openProjectFile(file), newProject(templateId?),
    toast(message, { kind:'info'|'ok'|'warn'|'err', action:{ label, run }, timeout }),
  },
};
```
UI state (`app.ui.get()`):
```js
{ selection: { kind:'book'|'front'|'section'|'answers'|'back', id?, index? },  // id = section id or front/back item key
  page: 0,                        // 0-based index of the current page (left page of a spread is derived by preview)
  view: 'spread'|'single', zoom: 'fit' | 0.5..4,
  overlays: { margins:false, answers:false },
  inspectorTab: 'section'|'puzzle'|'book', mobileTab: 'book'|'preview'|'settings'|'export',
  generating: { active:false, done:0, total:0 } }
```
Book (`app.getBook()`, also emitted as bus event `'book'` after every relayout):
```js
{ pages, meta,                    // layoutBook(project, puzzles, { pro: isPro() }) — preview shows exactly what exports
  puzzles,                        // { [sectionId]: Array<puzzle | null | {error, seed, index, timeout?}> }
  preflight,                      // preflight(...) result, or null while generating
  generating: { active, done, total }, project }   // the project snapshot this book was laid out from
```
Other bus events: `'license'` (license, info), `'flash'` ({ page }) to briefly highlight a page, `'gen-error'` ({sectionId, index, error}).

### 12.5 Mount functions (each module default-exports nothing; named exports only)
- `mountOutline(el, app)`, `mountTopbar(el, app)`, `mountStatusbar(el, app)` (shell)
- `mountPreview(el, app) → { destroy }` (preview). Keyboard handling for pages/zoom lives in `shortcuts.js`, which calls `app.ui.update` / `app.actions`; preview only reacts to `app.ui` and `'book'`.
- `mountInspector(el, app) → { destroy }` (inspector)
- `openExportDialog(app) → Promise<void>` (export)
- `TEMPLATES` (array of `{ id, name, blurb, build(opts) → project }`), `buildFromTemplate(id, { sample=false }) → project`,
  `openTemplatePicker(app, { firstRun }) → Promise<project|null>` (templates)

### 12.6 Pipeline (`js/ui/pipeline.js`, shell)
On project change (debounced ~120 ms) or license change: lay out at once from `cachedSection()` (placeholders for missing
puzzles), emit `'book'`, then `generateSection()` for sections with gaps (one AbortController per run; a new change aborts
the old run — the cache keeps finished puzzles), re-laying out at most every ~300 ms on progress. When every section is
complete: run `preflight()` and emit the final `'book'`. Preview never generates puzzles itself.

### 12.7 Persistence (`js/ui/persist.js`, shell) — SPEC 5.8
Keys `gbs.projects.index`, `gbs.project.<id>`, `gbs.prefs`; autosave 800 ms after the last change; everything in try/catch;
`storageAvailable()` false → toast "Autosave is off in this browser. Use Save project (Ctrl+S) to keep your work."

### 12.8 Deep links into the Studio (used by landing/tool-page CTAs)
`app/?template=<id>[&sample=1]` → new project from a template (template ids: `large-print-wordsearch`, `sudoku-easy-expert`,
`picture-logic`, `brain-games-mix`, `kids-activity`, `blank`). `app/?type=<wordsearch|sudoku|maze|nonogram>` → new book with one
section of that type. Optional with either: `trim=<trim id>`, `theme=<standard|large|kids>`, `count=<n>`. A new project never
overwrites an existing one (it is added to the local project list). After handling, the query string is removed with
`history.replaceState`. Unknown values are ignored.

### 12.9 Studio as built (additions to §12.2–12.8; all backward compatible)
- **store/bus:** `store.breakCoalesce()`, exported `deepEqual`; `bus.once()`, `bus.count()`.
- **project.js** also exports `stampProject`, `normalizeSection`, `sectionName`, `isLocked`, `regeneratePuzzle`,
  `regenerateSectionSeeds`, `toggleLock`, `duplicateSectionData`, `moveSectionIn`, `projectSummary` and constants. It never
  reads the clock: `newProject()` leaves `createdAt/updatedAt/year` null and app.js stamps them when it loads a book.
- **app.actions extras:** `undo()`, `redo()`, `pageOfItem(selection)`, `openMyBooks()`, `switchProject(id)`,
  `deleteProject(id)`, `toggleOutline(open?)`, `closeOutline()`, `announce(msg)`. `newProject(templateId?, {sample})`;
  `openProjectFile()` without a file opens a file picker. `window.gbsApp = app` (debugging and browser tests).
- **app.ui extras:** `outlineOpen` (tablet drawer); `fitZoom` (number, set by the preview; +/− step from it, and − from a
  fit below 50% keeps `'fit'`).
- **Bus event** `'autosave'`: `{state:'saved'|'pending'|'unsaved'|'off'|'error', at, error?}`.
- **Prefs** (inside `gbs.prefs`): `lastProjectId`, `view`, `zoom`, `inspectorTab`, `previewThumbs`, `printableSize`.
- **Mounts:** `mountPreview` returns `{destroy, stats}` (also on `.pv`.gbsPreview); `openTemplatePicker(app, {firstRun:true})`
  resolves a blank project when closed without a choice. Extra module exports: `templates.js` `TEMPLATE_IDS, SAMPLE_PAGES,
  templateById, templateFacts`; `export-plan.js` (pure: checklist, kdpSettings, fileNames, readmeText, …);
  `export-jobs.js` `runExport(kind, {project, puzzles, pro, printableSize, onProgress, signal})`.
- **Shortcuts:** Delete/Backspace remove the selected section only when focus is not in the settings pane, top bar,
  status bar, tab bar or a toast (a stray Backspace on a settings switch must not delete a section).

## 13. Marketing pages (`site/index.html`, tool pages, `pricing/`, `legal/`, `404.html`)

- One stylesheet: `site/css/site.css` (owner: landing). Pages link `tokens.css` then `site.css` with relative paths.
- Shared chrome (head links, header, footer, site.js script) is static HTML, copied **verbatim** from
  `docs/site-chrome.html` into every page, with `{R}` replaced by the relative path to the site root (`./` for
  `index.html`, `../` for `pricing/`, tool pages and `legal/*.html`). `404.html` is served at arbitrary paths, so it
  uses `<base href="/">` with `{R}` = `` (the one page that assumes root hosting).
- `js/site/site.js` (owner: landing) fills `[data-cfg="supportEmail"]` (text + mailto), `[data-cfg-price="lifetime|lifetimeRegular|pass"]`,
  `[data-cfg-link="lifetime|pass"]` (Gumroad URLs) from `config.js`, and marks the current nav link. Static HTML carries
  the default values so pages read correctly without JS.
- Canonical/OG URLs use `https://gridbookstudio.com/…` (SETUP.md explains the one-line domain replace).
