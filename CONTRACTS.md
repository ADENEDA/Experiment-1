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
