# Gridbook Studio: product and build spec

**Version 1.0, 2026-11-09.** A static site with no build step, hosted on Cloudflare Pages, selling through Gumroad (a Polar adapter is included as an alternative).

---

## 0. Which idea wins, and what changed

**Winner: idea #1, the KDP puzzle-book interior builder.** It is renamed **Gridbook Studio**, and its distinguishing focus shifts to logic and picture puzzles.

**Why #1, despite what the aggregate list shows**

- The aggregate ranking is mis-keyed. The judges labelled #1 two different ways, so its score was split across two rows (102 + 48).
- Summed per idea, the totals are:

| Idea | Total |
|---|---|
| #1 PuzzlePress | **150** (48 / 50 / 52) |
| #2 ShipShots | 128 |
| #5 SeatSketch | 118 |
| #3 RatioPack | 118 |
| #7 CaptionKiln | 116 |
| #8 ShipShots-video | 109 |
| #6 TrimReady | 107 |
| #4 LocalLedger | 106 |
| #9 Carouselsmith | 101 (not 2nd) |

- All three judges picked #1 as their top choice, and none of them found a fatal flaw.

**Two facts I checked today change the plan but not the pick**

1. **There is a direct rival.** PuzzleBindery.com (domain registered 2026-08-09) is an in-browser puzzle-book studio.
   - It offers 9 puzzle types: word search, sudoku, maze, crossword, fill-in, codeword, cryptogram, word scramble and number search.
   - It makes a full-wrap cover and gives a free watermarked proof.
   - It costs **$49 once at launch, then $79**.
   - It has no TrustMRR listing, so its revenue is unknown.
   - Other competitors: Sudoku Maker (puzzlebookmaker.com, desktop software, sudoku only, "Regular Price $197, You Save 71%"), plus free single-puzzle tools LargePrintPuzzleMaker.com and NonogramMaker.com.
   - So "one-time price, whole book, in the browser" is no longer a unique pitch.
2. **KDP now caps new titles.** Each account can create and submit at most 2 new titles per format per week (https://kdp.amazon.com/en_US/help/topic/G202172740). Publishing volume is capped, so what sells is a better book per title, not more titles.

**How the plan responds**

- **Price:** $29 lifetime at launch against the rival's $49/$79, plus a $9 7-day pass.
- **Puzzle types:** own the types PuzzleBindery does not list. These are picture nonograms (from a built-in library, the user's own image or a drawing), kakuro, calcudoku and futoshiki. Every grid is verified to have exactly one solution that can be reached without guessing.
- **Parity:** keep word search, sudoku and maze as good as the rival's, because buyers assemble mixed "brain games" books.

**Why not a runner-up**

- #2, #8 and #7 compete with free, clean, no-signup tools (the judges confirmed these exist).
- #4 and #6 cannot be made reliable in one session.
- #5 is off-season.
- #3 has the weakest distribution.

**Research note.** The shared web-search budget ran out during this step. Every fact marked "checked 2026-11-09" was verified by fetching official pages directly (KDP Help, Gumroad Help, Polar docs, npm registry, cdnjs) or by RDAP domain lookups. Anything unverified is labelled as such.

---

## 1. Name, tagline, buyer, positioning

### Name
**Gridbook Studio** (domain gridbookstudio.com).

**Name checks** (RDAP lookups plus homepage fetches, 2026-11-09)

- gridbookstudio.com had no RDAP record, so it is probably unregistered. Confirm at the registrar.
- Rejected names:
  - PuzzlePress: puzzlepress.com is parked for sale at HugeDomains, and the phrase is generic.
  - PuzzleBindery: it is the direct competitor.
  - Puzzlewright: an existing puzzle-book imprint.
  - NonogramMaker: an existing free tool.
  - Clueprint: .com registered in 2005 and .app on 2026-10-27.
  - Gridloom and PuzzleLoom: registered.
- Remaining risk:
  - gridbook.com is registered (since 2020; no live site seen) and gridbook.studio is registered.
  - "Gridbook" may be in use for graph-paper notebooks.
  - **Before buying the domain**, run knockout searches on USPTO (tmsearch.uspto.gov), EUIPO and WIPO Global Brand Database in classes 9 (software) and 16 (printed matter). I could not run these.
- Backup names (no RDAP record found): **LogicBook Studio** (logicbookstudio.com) and **PuzzleSheaf** (puzzlesheaf.com).
- Hard rules:
  - Never put Amazon, KDP or Kindle, or puzzle trademarks (Picross, KenKen, Griddlers, Pic-a-Pix), in the brand, domain, logo or product titles.
  - "For KDP" is fine in descriptive copy.
  - Say "calcudoku", never KenKen. Say "nonogram" or "picture logic puzzle", never Picross.

### Tagline
- Main: "Print-ready puzzle books, built in your browser."
- Secondary: "Picture puzzles, logic puzzles and large print. Every grid checked for exactly one solution."

### Target buyers
1. **Primary: KDP puzzle and activity-book publishers** making 2–8 titles a month, which is the most KDP's weekly cap allows per format.
   - Niches: large-print books for seniors, adult brain games, seasonal books (January, Valentine's, Easter, Mother's Day).
   - Today they pay for Book Bolt or similar tools, or assemble books by hand in Canva or InDesign.
2. **Secondary (free tier, our spreaders):** teachers, homeschoolers, senior-living activity directors and grandparents who print puzzles.
3. **Tertiary (Pro):** Etsy and Gumroad printable sellers.

### Positioning against named competitors

Prices were taken from competitor pages or from the provided research. "n/v" means not verified.

| | **Gridbook Studio** | Book Bolt | PuzzleBindery | KDP Builder | Sudoku Maker |
|---|---|---|---|---|---|
| Price | Free / $9 7-day pass / $29 lifetime at launch, then $39 | Monthly or yearly subscription; puzzle tools only on the higher plan; prices n/v | $49 at launch, then $79, once | Credit packs from $8.99 for 100, or plans from $16/mo; it estimates 100–150 credits per puzzle book | "Regular Price $197", "You Save 71%" (about $57), desktop |
| Runs | Browser; keep editing if the connection drops; nothing uploaded | Web app (server) | Browser | Web app | Windows/Mac app |
| Picture nonograms | **Yes** (library, upload or draw; no-guess) | n/v | Not among its 9 listed types | Not among its listed puzzle types | No |
| Kakuro / calcudoku / futoshiki | **Yes** (P1) | n/v | Not listed | Not listed | No |
| Word search / sudoku / maze | Yes | Yes | Yes | Yes | Sudoku only |
| KDP gutter by page count, preflight | Yes | n/v | Yes | Lists bleed, trim and safe-zone checks; gutter n/v | Claims "KDP-ready" |

Checked 2026-11-09. Book Bolt's pricing page blocked the check and reviews give different prices, so no Book Bolt price is quoted anywhere on the site; `site/book-bolt-alternative/` is the dated, sourced version of this table and the landing and pricing tables follow it.

**Positioning statement:** "The cheapest one-time puzzle-book studio, and the only one that turns pictures into no-guess nonogram books. Book Bolt rents you a puzzle generator by the month; Gridbook Studio sells it to you once."

---

## 2. Free vs Pro, prices, and why

### Free edition (no account, no time limit)
- All puzzle types, with unlimited generation, editing and on-screen preview of the whole book.
- The full book builder: front matter, sections, answer key, back matter, every trim size, large-print theme, preflight report.
- **Book interior PDF export works, but every page carries a proof footer and header** (Section 7).
  - KDP's paperback guidelines list "PDF creation logos or watermarks" as a common point of failure (https://kdp.amazon.com/en_US/help/topic/G201857950, checked 2026-11-09).
  - So free files are useful for proofing but cannot be published.
- **Printable PDF** (US Letter or A4): up to 10 puzzles plus answers per export, with the "made with" footer. Licensed for personal and classroom use.
- Free cover template (guide PDF/PNG with bleed, spine, safe zones and barcode area).
- Free tools on their own pages: spine width and cover size calculator, margin and gutter calculator.
- Project save/load (local) and `.gridbook.json` export.

### Pro (identical feature set in both forms)
- Clean exports with no footer or header: interior PDF, printables (unlimited puzzles), and PNG at 300 DPI per puzzle (P1).
- A commercial-use license: publish on KDP, sell printables on Etsy or Gumroad, use in paid newsletters. Selling the bundled word lists or quotes as standalone lists is not allowed.
- ZIP bundle (P1): interior, cover guide, separate answers PDF, project JSON, and a README with the exact KDP upload settings.
- An optional credit line on the copyright page (default **off**, see Section 7).
- Priority email support, and the "KDP rejected it" refund promise.

### Prices

| Product | Price | Gumroad net per sale\* |
|---|---|---|
| 7-Day Pass (one-time; Pro for 7 days from purchase) | **$9** | $7.04 |
| Lifetime (launch price until 2027-01-31; by date only, no buyer limit) | **$29** | $24.46 |
| Lifetime (regular price) | **$39** | $33.17 |

\*Gumroad direct sales cost 10% + $0.50, plus card processing of 2.9% + $0.30 (https://gumroad.com/help/article/66-gumroads-fees). Sales through its Discover marketplace cost 30% flat, so a $29 sale nets $20.30. On Polar's Starter plan (5% + 50¢), the same $29 sale would net $27.05.

**Why these prices**
- **$29 and $39 lifetime** are 40–63% below PuzzleBindery and below Sudoku Maker's sale price.
  - That is about the price of one or two months of a typical KDP-tool subscription (Book Bolt's own prices are not verified; don't quote a figure for it).
  - It stays above the under-$10 dead zone: on Gumroad, products under $10 are about 35% of listings but only 0.8% of modeled revenue (InsightRaider).
  - A one-time price suits a buyer whose output KDP now caps at 2 titles per format per week. Per-book credits look worse when you make 8 books a month for years.
- **$9 7-Day Pass** copies the format with the best verified fast first sales: AppLaunchFlow's €9 7-day pass ($27.7k verified) and Captioner's $7 week pass. It catches one-off seasonal publishers who will never buy lifetime.
- **A dated launch price** (until 2027-01-31) gives Facebook-group and YouTube posts a reason to act now. Nothing counts sales, so never claim a buyer limit. Keep the promise: buyers at $29 keep every future update.
- **Tests to run on days 11–12:** $24 vs $29 for lifetime, as a Gumroad discount code with its own end date (not a `config.js` change, which would make the site claim $24 until 2027-01-31). Do not test the pass price before day 30.
- **Refund promise:** "If KDP rejects your interior for a technical-spec reason, email us within 30 days for a full refund."

---

## 3. Monetization plumbing

### Platform choice
- **Primary: Gumroad.**
  - Selling can start on day 1 with no upfront account review (Polar reviews accounts for up to 14 days before the first payout).
  - It has built-in affiliates, which sellers set at 1–75%. This is the main channel to KDP YouTubers.
  - Its Discover marketplace reaches buyers already searching for KDP tools.
  - It issues license keys, and its verify endpoint can be called from a browser. Gumroad's docs say "you can send API requests to api.gumroad.com from the browser", and CORS was confirmed with `access-control-allow-origin: *`.
  - Costs: roughly double Polar's fees, and a **$100 minimum payout**.
- **Secondary: Polar.** The adapter ships so the owner can switch later for lower fees, server-enforced credit packs (`increment_usage`) and native key expiry.
- **Hosting: Cloudflare Pages.** GitHub Pages excludes sites "primarily directed at... facilitating commercial transactions."

### Gumroad setup (owner, about 20 minutes)
1. Create product **"Gridbook Studio Lifetime"** ($29). On the product's content page choose Insert, then License key. Copy the **product_id** shown in that block.
2. Create product **"Gridbook Studio 7-Day Pass"** ($9) the same way, with its own product_id.
3. Create a hidden **$0 test product** with a license key, to test verification end to end. Gumroad's own doc example shows `"price": 0`, so $0 products get keys.
4. Enable affiliates on both paid products at 40%. Create 100%-off discount codes for reviewer keys.
5. Paste the IDs and URLs into `config.js`.

### Checkout integration (Gumroad overlay)
```html
<script src="https://gumroad.com/js/gumroad.js" defer></script>
<a class="gumroad-button" href="https://YOURNAME.gumroad.com/l/gridbook-lifetime">Get Lifetime, $29</a>
<a class="gumroad-button" href="https://YOURNAME.gumroad.com/l/gridbook-sprint">Get the 7-Day Pass, $9</a>
```
- `gumroad.js` returned HTTP 200 on 2026-11-09.
- Buttons are rendered from `CONFIG` by `js/ui/buy-buttons.js`. If the overlay script fails to load, the plain link still opens Gumroad's hosted checkout in a new tab.
- The buyer receives the key in the receipt email and on the Gumroad download page, then pastes it into the Unlock dialog.

### `config.js` (the only file the owner edits)
```js
// config.js: owner settings. Nothing in here is secret.
export const CONFIG = {
  siteName: 'Gridbook Studio',
  siteUrl: 'https://gridbookstudio.com',
  supportEmail: 'hello@gridbookstudio.com',
  provider: 'gumroad',                    // 'gumroad' | 'polar'
  gumroad: {
    lifetime: { productId: 'PASTE_LIFETIME_PRODUCT_ID', url: 'https://YOURNAME.gumroad.com/l/gridbook-lifetime' },
    pass:     { productId: 'PASTE_PASS_PRODUCT_ID',     url: 'https://YOURNAME.gumroad.com/l/gridbook-sprint', days: 7 },
    test:     { productId: '' },          // hidden $0 product, used only when ?licensetest=1
    maxActivations: 5                     // soft limit, using Gumroad's "uses" counter
  },
  polar: {
    organizationId: '',                   // must be a real UUID v4, or Polar returns 422
    lifetimeBenefitId: '', passBenefitId: '',
    lifetimeCheckoutUrl: '', passCheckoutUrl: ''
  },
  offlineCodes: { publicKey: '' },        // Ed25519 raw public key (base64url); '' disables
  pricing: { lifetime: 29, lifetimeRegular: 39, pass: 9, launchEnds: '2027-01-31', currency: 'USD' },
  license: { revalidateDays: 7, offlineGraceDays: 30, timeoutMs: 8000 },
  free: { printableMaxPuzzles: 10 }
};
```

### License validation: exact requests

**Gumroad** (`js/license/gumroad.js`)
- Endpoint: `POST https://api.gumroad.com/v2/licenses/verify`.
- Body (form-encoded): `product_id`, `license_key`, `increment_uses_count`.
- A `URLSearchParams` body is a CORS "simple" request, so the browser sends no preflight.

```js
export async function verifyGumroad({ productId, key, increment = false, timeoutMs = 8000 }) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST', signal: ctrl.signal,
      body: new URLSearchParams({ product_id: productId, license_key: key.trim(),
                                  increment_uses_count: String(increment) })
    });
    const j = await res.json().catch(() => null);
    if (res.status === 404 || (j && j.success === false)) return { status: 'invalid' };
    if (!res.ok || !j) return { status: 'unreachable' };
    const p = j.purchase;
    if (p.refunded || p.chargebacked || (p.disputed && !p.dispute_won)) return { status: 'revoked' };
    return { status: 'valid', uses: j.uses, saleTimestamp: p.sale_timestamp, email: p.email };
  } catch { return { status: 'unreachable' }; } finally { clearTimeout(t); }
}
```
- A successful response is `{ success: true, uses, purchase: { product_id, email, sale_timestamp, refunded, disputed, dispute_won, chargebacked, license_key, variants, ... } }`.
- A failed verify returns **404** (https://gumroad.com/help/article/76-license-keys, checked 2026-11-09).
- **Activation flow:**
  1. Try the lifetime product_id first. On `invalid`, try the pass product_id. That is at most 2 calls.
  2. The first activation in a browser sends `increment=true`. Every later re-check sends `false`.
  3. If `uses > maxActivations`, refuse with: "This key is active on many devices. Email us and we'll reset it." The owner resets Uses in the Gumroad Sales dashboard.
  4. For a pass: `expiresAt = sale_timestamp + 7 days`.

**Polar** (`js/license/polar.js`)
- Endpoint: `POST https://api.polar.sh/v1/customer-portal/license-keys/validate`.
- Polar's docs say this endpoint "doesn't require authentication and can be safely used on a public client" (checked 2026-11-09).

```js
const res = await fetch('https://api.polar.sh/v1/customer-portal/license-keys/validate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key, organization_id: CONFIG.polar.organizationId })
});
// 200 -> { status: 'granted', benefit_id, expires_at, usage, limit_usage, limit_activations, customer: {...}, ... }
// 404 -> key not found, revoked, disabled or expired (or conditions/benefit/customer mismatch)
// 400 -> requested usage increment exceeds the allowance; 422 -> malformed (e.g. organization_id not a UUID v4)
```
- Tier is `'pass'` if `benefit_id === passBenefitId`, otherwise `'lifetime'`.
- `expires_at` comes from Polar's license-key benefit set to expire after 7 days.
- Optional later step (P2): sell a "5 books for $12" credit pack and call validate with `increment_usage: 1` on each clean book export. Polar enforces the quota on its server.

**Offline signed codes** (`js/license/offline-code.js`)
- Purpose: a fallback if Gumroad is down or blocked, and comp keys for reviewers.
- Format: `GBS1.<base64url(payloadJSON)>.<base64url(signature)>`, where the payload is `{"t":"lifetime","n":"reviewer-jane","iat":"2026-11-12","exp":null}`. `exp` is `null` or the ISO date-time the code stops working; `sign-code.mjs --days N` sets it to exactly N × 24 h after signing (or after `--iat`: that moment for a date-time such as a Gumroad `sale_timestamp`, or the start of that UTC day for a date), so a 7-day code reads like a 7-day Gumroad pass. Older codes with a `YYYY-MM-DD` exp work through the end of that UTC day.
- Verification uses WebCrypto Ed25519 (Chrome 137+, Firefox 129+, Safari 17+). If the browser lacks it, show "Use online activation instead":
  ```js
  const pub = await crypto.subtle.importKey('raw', b64uDecode(CONFIG.offlineCodes.publicKey), { name: 'Ed25519' }, false, ['verify']);
  const ok  = await crypto.subtle.verify({ name: 'Ed25519' }, pub, b64uDecode(sigPart), new TextEncoder().encode(payloadPart));
  ```
- `tools/keygen.mjs` creates the key pair with Node's `crypto.generateKeyPairSync('ed25519')`. The raw public key is the last 32 bytes of the SPKI DER.
- `tools/sign-code.mjs` signs payloads. The private key is stored in `tools/.private-key` and listed in `.gitignore`. Never commit it.

### State machine and caching
- The cache lives in `localStorage['gbs.license']` as `{provider, key, tier, validatedAt, expiresAt|null, uses}`. Every read and write is wrapped in try/catch.
- States:

| State | When | Behaviour |
|---|---|---|
| `free` | No key | Free edition |
| `checking` | Key entered or re-check running | Spinner on the badge |
| `pro-lifetime` | Valid lifetime key | Clean exports |
| `pro-pass` | Valid pass key | Clean exports; badge shows "Pass: 5 days left" |
| `pass-expired` | Pass past 7 days | Free edition, with "Get Lifetime" prompt |
| `invalid` or `revoked` | Server says so | Free edition, with explanation |
| `pro-offline-grace` | Server unreachable | Pro continues until grace ends |

- **On load:**
  1. If the cache shows Pro, unlock immediately, with no network call.
  2. If `validatedAt` is older than 7 days, re-check in the background.
  3. A definite `invalid` or `revoked` answer downgrades the account, with a toast.
  4. `unreachable` keeps Pro until `validatedAt + 30 days`. After that, clean exports pause with "Reconnect once to re-verify your license."
- Pass expiry is enforced locally against `Date.now()`, even offline.
- Pro-ness is checked **once, at export time**. The watermark operations are added to the page display lists before they are sent to the PDF worker.

### Honest limits of client-side gating
- Anyone can unlock Pro by editing localStorage or patching `isPro()` in DevTools. The watermark is drawn by code the user downloads.
- Do not obfuscate. It costs time and fools no one.
- What actually sells:
  - convenience (unlimited clean books for one payment, instead of a subscription);
  - the commercial license, which KDP businesses care about;
  - the refund promise;
  - updates.
- The Gumroad "uses" count is a soft deterrent to key sharing, not DRM.
- Polar's `increment_usage` is the only check here that a server enforces.

---

## 4. Full UX

### 4.1 Site map
| Path | Purpose |
|---|---|
| `/` | Landing page (Section 6) with a live mini demo |
| `/app/` | The Studio (single-page app) |
| `/play/` | (P1) Solve a shared nonogram or sudoku online; the puzzle is encoded in the URL hash |
| `/kdp-spine-width-calculator/`, `/kdp-margin-calculator/`, `/nonogram-puzzle-book-maker/`, `/large-print-word-search-maker/`, `/sudoku-book-generator/`, `/book-bolt-alternative/` | SEO tool pages (Section 6) |
| `/pricing/` | Pricing, FAQ and refund promise (also included on the landing page) |
| `/legal/terms.html`, `privacy.html`, `refunds.html`, `license.html`, `credits.html` | Legal pages; `credits.html` lists third-party licenses |
| `/404.html` | Not-found page with links to the tools |

### 4.2 Studio layout (`/app/`)
- **Top bar:**
  - logo;
  - editable book title;
  - autosave indicator ("Saved locally · 2s ago");
  - Undo and Redo;
  - **Preflight pill** (green "KDP-ready", amber "2 warnings", or red "Free proof: not publishable");
  - **Export** button;
  - license badge ("Free" or "Pro"); clicking it opens the Unlock dialog;
  - Help (?) menu.
- **Left: Book outline** (drag to reorder; Alt+Up/Down moves the selected item):
  - **Front matter:** Title page, Copyright page, "This book belongs to", How to solve (auto-generated for each puzzle type in the book, covering only the grid sizes and levels the book contains; short texts share one page), optional Contents.
  - **Sections:** each has a type icon, name, count and a per-page setting. A "+ Add section" menu lists the puzzle types.
  - **Answer key:** automatic, with a layout of 4, 6 or 9 mini solutions per page, placed at the end or after each section. At the end, a section's answers continue on the same page as the previous section's last ones, under a sub-heading.
  - **Back matter:** "Thank you" page (a plain review request; no incentives, per Amazon policy), "More books by…" page (optional), and lined Notes pages used to pad to an even page count.
- **Centre: Preview.**
  - Spread view shows left and right pages as printed. Single-page view is also available.
  - Zoom: Fit, 50–400%.
  - Page navigator and a virtualized thumbnail strip.
  - **Margin overlay** (M): trim edge, inside gutter (shaded), safe area, page side labels (L/R).
  - Answer view (A) shows each puzzle's solution in place.
  - Click a puzzle to select it. The inspector then shows that puzzle and offers Regenerate (R) and Lock (L).
- **Right: Inspector** with three tabs:
  - **Section:** type-specific controls (4.3), count, puzzles per page (1/2/4/6, limited by minimum legible size), section title, divider page on/off.
  - **Puzzle:** seed, Regenerate, Lock, per-type edits (word list, picture, difficulty), and stats (difficulty grade, solve-path depth, generation time).
  - **Book:**
    - trim size (all KDP paperback trims, 4.4);
    - paper (white, cream, groundwood; colour options for printables only);
    - interior bleed toggle (off by default for puzzle books);
    - typography theme: Standard, Large Print (all text at least 16pt) or Kids;
    - page numbers (style and position);
    - running header text;
    - starting side;
    - author name and copyright year;
    - credit line (Pro, off by default).
- **Bottom status bar** (live): page count, the gutter tier in use, interior page size, spine width for the chosen paper, and "Max pages for this trim: 590".

### 4.3 Per-type controls
| Type | Controls | Quality guarantee |
|---|---|---|
| **Word search** (P0) | Grid 10–25; shape mask (square, circle, heart, star, tree, house); directions: Easy (→↓), Medium (+↘↗), Hard (all 8 including backwards); words per puzzle (automatic maximum); theme picker or paste a list; word-list position (automatic: right of the grid on wide pages such as 8.25×6 or 2 per page, otherwise below; or fixed below or right) and sort (A–Z or length); letter case | Every word placed exactly once. Filler letters drawn from the puzzle's own letters. A blocklist scan in all 8 directions re-fills any accidental offensive word |
| **Sudoku** (P0) | Size 4×4, 6×6 (2×3 boxes), 9×9; difficulty Easy, Medium, Hard, Expert; symmetry rotational or none | Exactly one solution (solver counts to 2). Graded by a logical solver |
| **Maze** (P0) | Columns × rows; algorithm Winding (recursive backtracker) or Branchy (Wilson's); wall weight 1–3pt (minimum 0.75pt); start and end markers | Perfect maze: exactly one path. Solution drawn in the answer key |
| **Nonogram** (P0) | Size 5×5 to 30×30 (bold rule every 5 cells); source: Random shapes, Picture library, Upload image, or Draw (pixel editor); threshold slider, invert, crop, fit; "show givens" toggle (only if repair needs them) | **Line-solvable**: solvable row by row with no guessing, which implies a unique solution. The picture name stays hidden until the answer key ("Puzzle 12" on the page, "Puzzle 12: Cat" in the answers) |
| **Kakuro** (P1) | 8×8 to 12×12; difficulty (share of single-combination runs) | Unique solution |
| **Calcudoku** (P1) | n = 4–9; operations (+ only; + and −; all four); maximum cage size 2–4 | Unique solution |
| **Futoshiki** (P1) | n = 4–7; number of givens | Unique solution |
| **Cryptogram** (P1) | Quote category; hint letters 0–3 | No letter maps to itself |
| **Word scramble** (P1) | Theme; first-letter hint | A scramble never equals the word or another word in the list |

### 4.4 Templates (first-run empty state and "New book")
Six template cards, each with a thumbnail and the page count it will produce:
1. **Large Print Word Search for Adults:** 8.5×11, 100 puzzles, Large Print, 1 per page.
2. **Sudoku Easy to Expert:** 6×9, 200 puzzles (4 sections by difficulty), 2 per page.
3. **Picture Logic Puzzles:** 8.5×11, 60 nonograms from the library, 1 per page. This is the hero template.
4. **Brain Games Mix:** 8.5×11, word search, sudoku, maze and nonogram.
5. **Kids Activity Book:** 8.5×11, mazes, 4×4 sudoku, small word searches, Kids theme.
6. **Blank book.**

A "Try the 32-page sample" link builds template 3 at 32 pages.

### 4.5 Picture panel (nonogram source)
- **Library:** about 300 curated silhouettes from Phosphor Icons, "fill" weight (MIT, `@phosphor-icons/core@2.1.1`), grouped as Animals, Food, Holidays, Home, Nature, Travel, Sports. They are rasterized to the grid in the browser.
- **Upload:** drop a JPG, PNG or WebP. The image is downscaled with area averaging, converted to grayscale, thresholded (Otsu by default, adjustable with the slider), then repaired. Side-by-side preview shows the original and the grid. Notice: "Use only images you have rights to. Silhouettes and logos-free shapes work best."
- **Draw:** pixel editor with pencil, eraser, fill, mirror X/Y and clear. Mouse and touch both work.
- **Badge** after repair: "Logic-solvable ✓ (14 cells adjusted)" or "Needs 3 givens".

### 4.6 Word lists
- **Theme library:** P0 ships 60 original family-friendly themes of 25–40 words each; P1 grows to 120. No brand names or proper nouns.
- **Paste box:** one word per line. Validation flags:
  - words longer than the grid;
  - non-letters (stripped);
  - duplicates;
  - substring pairs (e.g. CAT inside CATERPILLAR, a warning only).
- **AI prompt helper:** a copy button with this text:
  > "Give me 30 family-friendly words for a word search themed '{theme}'. Rules: 3 to {max} letters, letters A–Z only, no spaces or hyphens, no brand names, no proper nouns, no duplicates. Reply with only a JSON array of uppercase strings."

  The user pastes the reply back, and the JSON is parsed and validated.
- **Disclosure tip** shown beside the helper: KDP requires you to disclose AI-generated text, and an AI-written word list may count. Algorithmic puzzles themselves are not AI-generated. Source: https://kdp.amazon.com/en_US/help/topic/G200672390.

### 4.7 Export dialog
- **Left side: preflight report** (Section 5.6), as a checklist with links that jump to the offending page.
- **Right side: formats.**

| Format | Free | Pro |
|---|---|---|
| Interior PDF for KDP (vector, fonts embedded, grayscale only) | With proof footer and header | Clean |
| Cover template PDF + 300 DPI PNG guide (bleed, trim, spine, safe zones, barcode area, spine text allowed only above 79 pages) | Yes | Yes |
| Printable PDF (Letter or A4, 1 puzzle per page, answers at the end) | Up to 10 puzzles, with footer | Unlimited, clean |
| Answers-only PDF | With footer | Clean |
| PNG per puzzle, 300 DPI (P1) | No | Yes |
| ZIP bundle (P1, fflate) | No | Yes |
| Project file `.gridbook.json` | Yes | Yes |

- Exports show a progress bar ("Drawing page 143/212") and can be cancelled.
- File names are ASCII only, e.g. `large-print-word-search-v1_interior_8.5x11_212p.pdf`. KDP rejects file names with emoji or special characters.
- The README in the ZIP lists the exact KDP settings to choose: ink and paper, trim, bleed, and "Not low-content". KDP's Low-Content Books page lists puzzle books as "Not generally low-content" (https://kdp.amazon.com/en_US/help/topic/GGE5T76TWKA85DJM).

### 4.8 Unlock dialog
- Two buy buttons (the Gumroad overlay) showing the price and what each includes, plus "30-day refund, including if KDP rejects the file for a spec reason."
- A key input with an Activate button.
- Help text: "Find your key in your Gumroad receipt or library."
- Status line: Activated, Invalid, Refunded, "Couldn't reach Gumroad (are you offline or using a strict blocker?)", or "Active on too many devices."
- A collapsible "Have an offline code?" field.

### 4.9 Keyboard shortcuts (the ? key shows the overlay)
| Keys | Action |
|---|---|
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z | Undo, redo |
| Ctrl/Cmd+S | Save a project file (`.gridbook.json` download; autosave is always on) |
| Ctrl/Cmd+E | Open the Export dialog |
| R / Shift+R | Regenerate selected puzzle / all unlocked puzzles in the section |
| L | Lock or unlock the selected puzzle |
| ← → / PgUp PgDn / Home End | Previous or next page, spread, first or last page |
| + − 0 | Zoom in, zoom out, fit |
| M / A | Toggle margin overlay / answer view |
| Alt+↑ ↓ | Move the selected outline item |
| Delete | Remove the selected section (with an undo toast) |
| ? | Shortcut help |

### 4.10 Empty, error and offline states
- **No sections:** "Add your first section" with six type buttons and the template link.
- **Empty word list:** "Pick a theme, paste words (one per line), or copy the AI prompt."
- **Picture upload area:** "Drop an image. High-contrast silhouettes make the best puzzles."
- **Free edition banner** (dismissible, shown once per session): "Build and preview everything free. Book exports carry a proof header and footer. Remove them, and add PNG and ZIP exports, with a $9 pass or $29 lifetime."
- **Generation timeout:** "Couldn't make a unique 12×12 kakuro in 3s. Try 10×10, or Retry." Partial batches are kept.
- **Over the page limit:** red preflight message: "590 pages is the maximum for 8.5×11 on white paper. Remove 14 pages or choose a smaller trim."
- **Offline:** "You're offline. You can keep editing, but exporting may need the connection. Don't reload the page until you're back online." Once the export tools have loaded (in the background, a moment after the Studio opens): "You're offline. You can keep editing and exporting. Don't reload the page until you're back online." (No service worker: a reload offline fails, so the copy never promises more.)
- **localStorage unavailable** (private mode or blocked): "Autosave is off in this browser. Use Save project (Ctrl+S) to keep your work."

### 4.11 Mobile behaviour
- **Landing, SEO and calculator pages:** fully responsive, single column under 720px, 16px side gutters, no horizontal scroll, touch targets at least 44px.
- **Studio layouts:**
  - 1024px and up: three panes.
  - 768–1023px: two panes, with the outline as a slide-over drawer.
  - Under 768px: bottom tab bar (Book, Preview, Settings, Export); pinch-zoom preview; the pixel editor works with touch.
- **Large exports on iOS:** warn for books over 150 pages ("Large books export more reliably on a computer") but still allow the export.

---

## 5. Technical architecture

### 5.1 Constraints
- Plain HTML, CSS and native ES modules. No bundler and no build step.
- Libraries are vendored into `/vendor/` with the version in the file name, so they can be cached as immutable. Each was copied from cdnjs or jsDelivr at a pinned version:

| Library | Version | Notes |
|---|---|---|
| jsPDF | **4.2.1** (2026-03-17), `jspdf.umd.min.js` | The ES build has bare imports (`fflate`, `fast-png`, `@babel/runtime`), so use the UMD build in a classic worker |
| fflate | **0.8.3** (2026-05-16), `esm/browser.js` | MIT. Not 0.8.2: it has a published advisory (GHSA-px8p-9vwx-vf98, `unzipSync`) |
| lz-string | **1.5.0** | MIT; share links |
| qrcode-generator | **1.4.4** | MIT; P1 printable QR codes |
| Fonts | Atkinson Hyperlegible Regular and Bold TTF (OFL, from google/fonts) | Vendor with `OFL.txt` |

### 5.2 File tree
```
/
├─ index.html                      landing
├─ app/index.html                  Studio
├─ play/index.html                 (P1) shared-puzzle solver
├─ kdp-spine-width-calculator/index.html
├─ kdp-margin-calculator/index.html
├─ nonogram-puzzle-book-maker/index.html
├─ large-print-word-search-maker/index.html
├─ sudoku-book-generator/index.html
├─ book-bolt-alternative/index.html
├─ pricing/index.html
├─ legal/{terms,privacy,refunds,license,credits}.html
├─ 404.html  robots.txt  sitemap.xml  _headers  _redirects  site.webmanifest  favicon.svg
├─ og/{home,spine,margin,nonogram,wordsearch,sudoku,bookbolt}.png      1200×630, made with the tool
├─ samples/{picture-logic-32p.pdf, large-print-word-search-24p.pdf, sudoku-sampler-24p.pdf}
├─ config.js
├─ (no sw.js: the service worker was dropped, §5.9)
├─ css/{tokens.css, site.css, app.css, print-preview.css}
├─ fonts/{AtkinsonHyperlegible-Regular.ttf, AtkinsonHyperlegible-Bold.ttf, OFL.txt}
├─ vendor/{jspdf-4.2.1.umd.min.js, fflate-0.8.3.browser.js, lz-string-1.5.0.min.js, qrcode-1.4.4.js}
├─ data/{wordlists.json, quotes.json, pictures.json, blocklist.json, howto.json}
├─ js/
│  ├─ core/{rng.js, store.js, bus.js, units.js, undo.js, dom.js}
│  ├─ kdp/{specs.js, preflight.js, cover.js}
│  ├─ puzzles/{registry.js, wordsearch.js, sudoku.js, maze.js, nonogram.js, nonogram-solver.js,
│  │          kakuro.js, calcudoku.js, futoshiki.js, cryptogram.js, scramble.js, masks.js}
│  ├─ layout/{book.js, pages.js, text.js, displaylist.js, themes.js}
│  ├─ render/{canvas-backend.js, pdf-backend.js}
│  ├─ workers/{gen.worker.js (module), pdf.worker.js (classic)}
│  ├─ license/{license.js, gumroad.js, polar.js, offline-code.js}
│  ├─ ui/{app.js, outline.js, inspector.js, preview.js, picture-panel.js, wordlist-panel.js,
│  │      export-dialog.js, unlock-dialog.js, buy-buttons.js, templates.js, toasts.js, shortcuts.js}
│  └─ site/{demo.js, spine-calc.js, margin-calc.js, mini-generator.js}
└─ tools/{keygen.mjs, sign-code.mjs, test/*.test.mjs}      dev-only; run with `node --test tools/test`
```

### 5.3 Module contracts
- **`js/core/rng.js`:** `cyrb128(str)` gives 4×32-bit seed words, fed to `sfc32` for a fast seeded PRNG. Each puzzle's seed is `${book.seed}:${section.id}:${index}`, unless that puzzle is locked with its own seed. Books are therefore reproducible from their JSON.
- **`js/puzzles/registry.js`:** every puzzle type exports the same interface:
  ```js
  export const meta = { id: 'sudoku', name: 'Sudoku', minCellPt: { standard: 18, large: 26 } };
  export function defaults(theme) { /* option defaults */ }
  export function generate(opts, rng, { deadlineMs }) { /* returns { data, solution, stats:{grade, ms} } or throws GenTimeout */ }
  export function verify(puzzle) { /* true if unique (or line-solvable); used by tests and preflight */ }
  export function draw(puzzle, box, style, mode) { /* mode 'puzzle' | 'answer' | 'mini'; returns display-list ops */ }
  ```
  Engines are pure functions with no DOM access, so they run in the worker and in Node tests.
- **Display list** (`js/layout/displaylist.js`):
  - Each page is `{ w, h, ops: [...] }`, in points, with the origin at top-left.
  - Ops are:
    - `{t:'text', x, y, s, size, font:'atk', weight:'regular'|'bold', align, gray}`
    - `{t:'line', x1, y1, x2, y2, w, gray, cap}`
    - `{t:'rect', x, y, w, h, stroke, fill}`
    - `{t:'poly', pts, closed, stroke, fill}`
    - `{t:'circle', cx, cy, r, stroke, fill}`
  - Gray values run 0–1. There is **no RGB**, so a black-ink interior uses one colour space. KDP advises against mixing colour spaces.
  - **One layout feeds two backends**: what you see in the preview is what prints.
- **`render/canvas-backend.js`:** draws a page's ops to a canvas at the device pixel ratio. Text uses a `FontFace` loaded from the same TTF bytes, with `ctx.fontKerning = 'none'` so widths match jsPDF, which does not kern.
- **`render/pdf-backend.js`** runs inside `pdf.worker.js`:
  - `importScripts('/vendor/jspdf-4.2.1.umd.min.js')`.
  - Create the document with `new jsPDF({ unit:'pt', format:[w,h], putOnlyUsedFonts:true, compress:true })`.
  - Register fonts with `addFileToVFS` and `addFont`.
  - Map ops to `text`, `line`, `rect` and `lines`, using single-number `setDrawColor` and `setFillColor`, which produce DeviceGray.
  - Call `addPage([w,h])` for each page, post progress after each page, and transfer the result with `output('arraybuffer')`.
  - **`putOnlyUsedFonts: true` is required.** Without it, jsPDF lists all 14 standard fonts (Helvetica and the rest) as unembedded resources. I confirmed this with `pdffonts` on 2026-11-09: with the flag, only the embedded Atkinson CID TrueType font remains. KDP requires all fonts to be embedded.
  - I confirmed jsPDF 4.2.1 UMD runs in a context with no `window` (worker-like) and embeds the TTF.
- **`layout/book.js`:**
  1. Expands the project into a page list: front matter, sections, divider pages, answer key, back matter, padding.
  2. Assigns sides: page 1 is a right-hand page, so odd pages are right-hand pages with the inside margin on the left.
  3. Computes the gutter from the **final** page count. It guesses the tier, lays out, recomputes, and lays out again if the tier changed. At most 2 passes; at a tier boundary it takes the larger tier.
  4. Pads to an even page count with lined Notes pages, not blank pages, because KDP lists "excessive blank pages" as a failure point.
  5. Adds page numbers with even numbers on left pages, as KDP's pagination rule requires.
- **`layout/text.js`:** measures text with an OffscreenCanvas `measureText` (kerning off), handles greedy wrapping and auto-fit within a box (shrinking down to the theme's minimum size), and records the line breaks in the ops so the PDF matches the preview exactly.

### 5.4 KDP rules module (`js/kdp/specs.js`; numbers from KDP Help, checked 2026-11-09)
```js
// Inside (gutter) margin by page count. Outside/top/bottom: >= 0.25" without bleed, >= 0.375" with bleed.
export const GUTTER_TIERS = [[24,150,0.375],[151,300,0.5],[301,500,0.625],[501,700,0.75],[701,828,0.875]];
export const MIN_OUTSIDE = { noBleed: 0.25, bleed: 0.375 };
export const INTERIOR_BLEED = { w: 0.125, h: 0.25 };   // page = (trim W + 0.125) x (trim H + 0.25)
export const SPINE_PER_PAGE = { white: 0.002252, cream: 0.0025, groundwood: 0.00235,
                                standardColor: 0.002252, premiumColor: 0.002347 };
export const COVER_BLEED = 0.125, SPINE_TEXT_MIN_PAGES = 80, SPINE_SAFE = 0.0625, COVER_SAFE = 0.25;
export const MIN_PAGES = 24, MIN_FONT_PT = 7, MIN_LINE_PT = 0.75, MIN_GRAY_FILL = 0.10;
// Paperback trims, max pages for black ink {white, cream, groundwood}:
export const TRIMS = [
  ['5x8',5,8],['5.06x7.81',5.06,7.81],['5.25x8',5.25,8],['5.5x8.5',5.5,8.5],['6x9',6,9],
  ['6.14x9.21',6.14,9.21],['6.69x9.61',6.69,9.61],['7x10',7,10],['7.44x9.69',7.44,9.69],
  ['7.5x9.25',7.5,9.25],['8x10',8,10]                     ].map(t => [...t, {white:828, cream:776, groundwood:812}])
  .concat([['8.25x6',8.25,6,{white:800,cream:750,groundwood:784}], ['8.25x8.25',8.25,8.25,{white:800,cream:750,groundwood:784}],
           ['8.5x8.5',8.5,8.5,{white:590,cream:550,groundwood:578}], ['8.5x11',8.5,11,{white:590,cream:550,groundwood:578}],
           ['8.27x11.69',8.27,11.69,{white:780,cream:730,groundwood:764}]]);
// Cover: width = 0.125 + W + spine + W + 0.125; height = 0.125 + H + 0.125; spine = pages * SPINE_PER_PAGE[paper]
```
- Sources: https://kdp.amazon.com/en_US/help/topic/GVBQ3CMEQW3W2VL6, G201857950 and G201953020.
- The barcode area is drawn as 2.0 × 1.2 in, inset 0.25 in from the back cover's lower-right trim. That size is commonly cited, but I did not see it on the fetched KDP page; confirm it on KDP's Barcodes help page.
- Default margins: top and bottom 0.6 in, outside 0.5 in, **inside = gutter tier + 0.125 in**. The extra 0.125 in keeps grids out of the fold; the user can reduce it, but never below the tier.
- **Large Print theme:**
  - all text at least 16pt;
  - word-search letters at least 18pt;
  - sudoku digits at least 22pt.
  - This follows common industry practice; KDP's pages that I read do not define "large print."

### 5.5 Puzzle algorithms
- **Word search:**
  1. Place words longest first. Each word gets up to 200 random tries at a position and direction. Overlaps are allowed only where letters match (and are preferred on Hard). A word that cannot be placed is dropped and reported.
  2. Fill the empty cells by sampling from the letters of the placed words.
  3. Scan rows, columns and diagonals in both directions for blocklist words of 3 or more letters, and re-fill any hit in non-word cells until clean.
  4. Assert that each placed word occurs exactly once.
  5. Answers are drawn as capsule outlines (1pt).
- **Sudoku:**
  1. Fill a solved grid by randomized backtracking with bitmasks.
  2. Remove givens in symmetric pairs, keeping each removal only if the solver still counts exactly 1 solution (it stops at 2).
  3. Grade with a logical solver:
     - Easy: naked and hidden singles, 36 or more givens.
     - Medium: singles only, 30–35 givens.
     - Hard: needs locked candidates or naked pairs.
     - Expert: needs more than that.
  4. Retry until the target grade is reached within a 1.5s deadline.
- **Maze:**
  1. Carve with an iterative recursive backtracker or with Wilson's algorithm. Entrance is at the top-left, exit at the bottom-right.
  2. Find the solution with BFS.
  3. Merge collinear wall segments before drawing, to keep the PDF small. Walls use round caps at 1.5pt by default.
- **Nonogram** (`nonogram-solver.js`):
  - **Line solver:** a dynamic program over (cell, block) runs forward and backward for each line. A cell becomes filled or empty when every valid placement agrees. Lines are re-queued until nothing changes.
  - If every cell is determined, the puzzle is **unique and solvable without guessing**.
  - **Repair** (pictures and random shapes):
    1. While undetermined cells remain, toggle the undetermined cell closest to a shape edge in the source bitmap, then re-solve.
    2. Allow up to `max(30, 4% of cells)` toggles. Report the number of changed cells.
    3. If repair still fails, add givens (pre-filled cells marked with a dot) until solved, or offer "Try a different threshold."
  - **Random mode:** fill 50% noise, apply 3 cellular-automaton smoothing steps, keep density at 45–60%, then repair.
  - **Clue font:** sized from the longest clue run, never below 7pt (never below 14pt in Large Print). If the grid cannot meet that, preflight suggests a smaller grid.
- **Kakuro** (P1):
  1. Generate a symmetric black-cell pattern where every white run is 2–9 cells and no white cell is isolated.
  2. Fill digits by backtracking with no repeats in a run.
  3. Solve with precomputed tables of digit combinations for each (sum, length), using most-constrained-cell-first search.
  4. If there is more than one solution, re-fill the cells that differ. Deadline 3s; sizes up to 12×12.
  5. Clue cells are drawn as 25% gray with black numbers, not white on black, which prints more reliably.
- **Calcudoku / futoshiki** (P1):
  1. Build a Latin square by shuffling rows, columns and symbols.
  2. Calcudoku: grow cages to 1–4 cells; − and ÷ only on 2-cell cages. Futoshiki: add inequalities and givens, then remove while the solution stays unique.
  3. Check uniqueness with a constraint-propagation solver.
- **Cryptogram** (P1):
  - The cipher is a derangement (no letter maps to itself).
  - Quotes are public domain, each stored with an author and an approximate year. Skip commonly misattributed quotes.

### 5.6 Preflight checks (`js/kdp/preflight.js`)

Errors (red) block "KDP-ready"; warnings (amber) do not.

| Severity | Check |
|---|---|
| Error | Page count of at least 24 and even. Auto-padding is on by default |
| Error | Page count at or below the maximum for the trim and paper |
| Error | Inside margin at least the tier for the **final** page count |
| Error | Outside, top and bottom margins at least 0.25 in (0.375 in with bleed) |
| Error | Every op's bounding box inside the safe area (layout assertion) |
| Error | Every font size at least 7pt. In the Large Print theme, a warning below 16pt |
| Error | Every line width at least 0.75pt (KDP's stated minimum line weight) |
| Error | Gray fills at 10% or more (KDP's minimum recommendation) |
| Error | Watermark present (free edition) |
| Error | Every puzzle passes `verify()` (unique, line-solvable, or single-path) |
| Error | Every puzzle has its answer in the key |
| Warning | Spine text requested at 79 pages or fewer (KDP prints spine text only above 79) |
| Warning | Non-ASCII characters in the file name |
| Warning | More than 2 consecutive blank pages |
| Warning | Word list shorter than the grid can hold |

### 5.7 Workers and performance
- **Generation:** a pool of `min(4, navigator.hardwareConcurrency - 1)` module workers (`gen.worker.js`).
  - Requests are batched per section with progress messages and an AbortController.
  - Results are written to an in-memory cache keyed by seed and option hash.
- **Targets on a 2020-era laptop:**

| Puzzle | Target |
|---|---|
| 15×15 word search | under 20ms |
| 9×9 sudoku at grade | under 150ms median |
| 20×20 nonogram line-solve | under 30ms |
| 200-puzzle mixed section | under 8s |
| 200-page PDF | under 15s, about 1–4 MB |

- **Preview:** virtualized rendering. Only visible pages and spreads are drawn, through `requestIdleCallback` queues. Thumbnails are drawn at low resolution and evicted on an LRU basis.
- **Fonts:** fetch each TTF once as an ArrayBuffer. Create a `FontFace` from it for the canvas, and send a base64 copy to the PDF worker once per session.
- **Memory:** keep no per-page canvases. The PDF is built in the worker and only the final buffer is transferred.
- **Fallback:** if worker creation fails, run on the main thread in chunks, yielding with `await scheduler.yield?.() ?? setTimeout(0)`.

### 5.8 Persistence
- **localStorage** (all calls wrapped in try/catch, with the app working without it):
  - `gbs.projects.index`: list of `{id, title, updatedAt}`.
  - `gbs.project.<id>`: the project JSON. It is small, because puzzles are stored as seeds plus edits; nonogram pictures are stored as bitsets (a 30×30 picture is 113 bytes).
  - `gbs.license`
  - `gbs.prefs`: zoom, last tab, dismissed banners.
- Typical project size: under 50 KB, well inside localStorage's roughly 5 MB.
- **Autosave** runs 800ms after the last change. Undo history holds 100 entries in memory only.
- **Project JSON v1:**
```json
{ "v":1, "id":"b_k3j2h1", "seed":"7f3k2", "title":"Picture Logic Puzzles", "subtitle":"60 Nonograms · Volume 1",
  "author":"Evelyn Hart", "year":2026, "trim":"8.5x11", "paper":"white", "bleed":false, "theme":"large",
  "front":["title","copyright","belongs","howto"],
  "sections":[{"id":"s1","type":"nonogram","title":"Animals","count":30,"perPage":1,
               "opts":{"size":15,"source":"library","pictures":["cat","owl","fox"]},
               "locks":{"7":"seedOverride:9xq"},"edits":{"12":{"bitset":"base64..."}}}],
  "answers":{"perPage":6,"position":"end"}, "back":["thanks","notes"], "credit":false }
```
- **Share links** (P1): `/play/#` followed by an lz-string `compressToEncodedURIComponent` encoding of `{type, opts, seed}` or a bitset.

### 5.9 Hosting files
- **`_headers`** (Cloudflare Pages):
```
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
/vendor/*
  Cache-Control: public, max-age=31536000, immutable
/fonts/*
  Cache-Control: public, max-age=31536000, immutable
/data/*
  Cache-Control: public, max-age=0, must-revalidate
/css/*
  Cache-Control: public, max-age=0, must-revalidate
/js/*
  Cache-Control: public, max-age=0, must-revalidate
```
  `/data/*`, `/css/*` and `/js/*` are ES modules and styles without a version in their names, so they revalidate on
  every visit: a fresh-cached old module next to a new one breaks the module graph after a deploy.
- **CSP:** optional, and only after testing that the Gumroad overlay still works. Use the tested policy that is
  commented in `site/_headers` (it allows `https://assets.gumroad.com` for the overlay's scripts, styles, fonts and
  images, the Studio's inline boot script by hash, and sets `frame-ancestors 'none'`); a shorter policy breaks the
  overlay. Drop it if the overlay breaks.
- **`_redirects`:** `/studio /app/ 301` and `/buy /pricing/ 302`, plus `/buy/lifetime` and `/buy/pass` (the static
  href of the buy buttons before `site.js` runs; `/pricing/` until the owner points them at the products).
- **Analytics:** turn on Cloudflare Web Analytics in the Pages dashboard (free and cookieless, so no banner is needed). Gumroad's product analytics shows views, sales and referrers.
- **Service worker:** dropped. The site ships without one (no `sw.js`, no offline install), so no copy may claim it
  works with Wi-Fi off: the most it says is that you can keep editing if your connection drops (§4.10 offline toast).
  The original P1 plan (a precached app shell, network-first HTML, a "New version available" toast and a "works
  with Wi-Fi off" demo) is not built.

### 5.10 Browser support
- Supported: Chrome and Edge 120+, Firefox 128+, Safari 17+ (OffscreenCanvas and module workers).
- Ed25519 offline codes need Chrome 137+, Firefox 129+ or Safari 17+.
- Every feature is detected at runtime. The interior PDF must work in all four browsers.

### 5.11 Build order and definition of done

**P0: must ship this session**
- Landing page.
- Studio with word search, sudoku (4/6/9), maze, and nonogram (all four sources, with repair).
- Book builder: front and back matter, answer key, KDP layout with gutter iteration, preflight.
- Exports: interior PDF, printable PDF, cover template PDF/PNG.
- License: Gumroad plus offline codes. `config.js`.
- localStorage autosave, JSON import and export.
- 6 SEO pages, legal pages, sitemap, robots, `_headers`.
- Node tests.

**P1: same session if time allows, otherwise days 2–3**
- Kakuro, calcudoku, futoshiki, cryptogram, word scramble.
- `/play/` share pages.
- Service worker: dropped (§5.9), not built.
- ZIP bundle and PNG export.
- QR code on printables.
- Simple cover designer (title, author, pattern made from the book's own grids, CMYK only).

**P2: week 2 onward**
- Polar adapter with credit packs.
- Killer sudoku, skyscrapers.
- Amazon listing-image and 3D mockup generator.
- Series generator (volume 2 with overlap report).
- Showcase gallery.
- Maze shape masks.

**Acceptance checks**
1. `node --test tools/test` passes. It covers:
   - 1,000 seeded sudokus, each unique;
   - 500 nonograms, each line-solvable after repair;
   - word-search placements valid with blocklist scans clean;
   - mazes single-path;
   - `specs.js` values asserted against the table in 5.4;
   - spine width for 100 white pages = 0.2252 in.
2. Exporting the "Large Print Word Search" template (8.5×11, 100 puzzles, about 128 pages including answers) finishes in under 15s.
3. `pdffonts` on that file lists **only** embedded fonts.
4. `pdfinfo` shows 612×792 pt pages with no bleed.
5. The free-mode PDF contains the footer on every page. Pro mode does not.
6. The license flow works against the hidden $0 Gumroad product: valid, invalid, offline grace, and pass expiry (simulated by stubbing `Date.now`).
7. The landing page scores at least 90 on Lighthouse for Performance, Accessibility and SEO on mobile, with no horizontal scroll at 360px.
8. Before marketing starts, the owner uploads one interior and cover to KDP as a draft, passes the KDP previewer, and orders one proof copy. It costs a few dollars plus shipping (not verified) and is optional, but it gives the "real printed proof" photo for the landing page.

---

## 6. SEO and landing page

### 6.1 Landing page sections (`/`)
1. **Hero.**
   - H1: "Make a print-ready puzzle book in your browser."
   - Subhead: "Word search, sudoku, mazes and picture nonograms, with answer keys and the KDP gutter, spine and margins worked out for you. Nothing is uploaded. Free to try; $29 once."
   - A **live mini demo** sits beside the text: tap a picture chip (house, heart, rabbit) to get a 10×10 nonogram, or switch to word search.
   - CTAs: "Open the Studio (free)" and "Download a 32-page sample PDF."
2. **Proof strip** (four checkable claims): "Exactly one solution, verified", "Gutter set from your final page count", "Fonts embedded, grayscale only", "Zero uploads: made on your device."
3. **Puzzle-type gallery:** real SVG miniatures drawn by the engine, each labelled with its guarantee.
4. **Picture puzzles:** "Turn any picture into a no-guess nonogram." Show the original image, the grid, and the solved reveal.
5. **How it works in 3 steps:** pick a template, generate and tweak, export interior plus cover template.
6. **The KDP specs we build to:** the gutter table, bleed sizes and spine formulas, each linked to its KDP help page.
7. **Honest comparison table** (Section 1 table, prices dated "checked 2026-11-09").
8. **Pricing:** Free, 7-Day Pass $9, Lifetime $29 (launch) then $39. Refund promise. A count of launch-price buyers is shown only if the owner updates it by hand; never fake it.
9. **FAQ:**
   - Will KDP accept the files?
   - Are the puzzles AI-generated? (No, they are algorithmic.)
   - Can I sell what I make?
   - Can I sell printables on Etsy?
   - Does it work offline?
   - What does the license check send? (Only your key, to Gumroad.)
   - Refunds?
   - Large print sizes?
10. **Footer:** links to the calculators and guides, legal pages, contact, and "Built by a solo maker."

### 6.2 Head tags (landing page; other pages follow the same pattern)
```html
<title>Gridbook Studio: print-ready puzzle books for KDP, in your browser</title>
<meta name="description" content="Make word search, sudoku, maze and picture nonogram books with answer keys. KDP gutter, margins and spine width done for you. Runs in your browser. Free to try, $29 once.">
<link rel="canonical" href="https://gridbookstudio.com/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Gridbook Studio">
<meta property="og:title" content="Print-ready puzzle books, built in your browser">
<meta property="og:description" content="Picture nonograms, sudoku, word search and mazes. Every grid checked for one solution. No subscription.">
<meta property="og:image" content="https://gridbookstudio.com/og/home.png">
<meta property="og:url" content="https://gridbookstudio.com/">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebApplication","name":"Gridbook Studio",
"url":"https://gridbookstudio.com/","applicationCategory":"DesignApplication","operatingSystem":"Any (web browser)",
"offers":[{"@type":"Offer","price":"0","priceCurrency":"USD","name":"Free edition"},
          {"@type":"Offer","price":"9","priceCurrency":"USD","name":"7-Day Pass"},
          {"@type":"Offer","price":"29","priceCurrency":"USD","name":"Lifetime"}]}</script>
```

### 6.3 SEO tool pages
Each page has a real working tool above the fold, 500–900 words of original help, a sample download, and a CTA into the Studio with settings pre-filled. Keyword volumes for these terms were **not verified** (search budget exhausted). After 3–4 weeks, check Google Search Console impressions and re-target.

| Path | Target queries | What the page does |
|---|---|---|
| `/kdp-spine-width-calculator/` | kdp spine width calculator, kdp cover size calculator, paperback cover dimensions | Inputs: trim, page count, paper. Outputs: spine width, full cover size in inches, mm and pixels at 300 DPI; whether spine text is allowed; a downloadable cover guide (PDF/PNG). Shows the formula with links to KDP |
| `/kdp-margin-calculator/` | kdp margins, kdp gutter size, kdp insufficient gutter, 6x9 margins | Inputs: trim, page count, bleed. Outputs: minimum and recommended margins, a visual page diagram, settings to enter in Word, Affinity and InDesign, and an explanation of the "gutter changes at 151/301/501/701 pages" rule |
| `/nonogram-puzzle-book-maker/` | nonogram generator, nonogram puzzle book, picture logic puzzle maker, printable nonograms | Picture-to-nonogram generator with a solvability badge; a free printable page with footer; how nonograms work; why "no-guess" matters |
| `/large-print-word-search-maker/` | large print word search generator, printable large print word search | A word search with the 18pt preset; free printable; guidance for senior readers (font, contrast, grid size per page); a 24-page sample |
| `/sudoku-book-generator/` | sudoku book generator, sudoku puzzle book maker | Generates graded sudoku; explains the uniqueness check and grading in plain language; sampler PDF |
| `/book-bolt-alternative/` | book bolt alternative, puzzle book software no subscription | A factual, dated comparison (Book Bolt, PuzzleBindery, KDP Builder, Sudoku Maker), 12-month cost of each, and when each one is the better choice. No disparagement, and every claim linked to its source |

Add seasonal hook sections to the relevant pages: January brain games, Valentine's, Easter.

### 6.4 `robots.txt`
```
User-agent: *
Allow: /
Sitemap: https://gridbookstudio.com/sitemap.xml
```

### 6.5 `sitemap.xml`
```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://gridbookstudio.com/</loc><lastmod>2026-11-09</lastmod></url>
  <url><loc>https://gridbookstudio.com/app/</loc><lastmod>2026-11-09</lastmod></url>
  <url><loc>https://gridbookstudio.com/pricing/</loc><lastmod>2026-11-09</lastmod></url>
  <url><loc>https://gridbookstudio.com/kdp-spine-width-calculator/</loc><lastmod>2026-11-09</lastmod></url>
  <url><loc>https://gridbookstudio.com/kdp-margin-calculator/</loc><lastmod>2026-11-09</lastmod></url>
  <url><loc>https://gridbookstudio.com/nonogram-puzzle-book-maker/</loc><lastmod>2026-11-09</lastmod></url>
  <url><loc>https://gridbookstudio.com/large-print-word-search-maker/</loc><lastmod>2026-11-09</lastmod></url>
  <url><loc>https://gridbookstudio.com/sudoku-book-generator/</loc><lastmod>2026-11-09</lastmod></url>
  <url><loc>https://gridbookstudio.com/book-bolt-alternative/</loc><lastmod>2026-11-09</lastmod></url>
  <url><loc>https://gridbookstudio.com/play/</loc><lastmod>2026-11-09</lastmod></url>
</urlset>
```
Update `lastmod` by hand when a page changes.

---

## 7. Viral loop

- **Free printables** (Letter/A4) are the main reach engine. Teachers photocopy them and activity directors hand them out.
  - Footer centred in the bottom margin, 8pt Atkinson at 55% gray: `Free printable from gridbookstudio.com · make your own puzzle book`.
  - P1 adds a 0.5 in QR code in the bottom-right margin linking to `/?ref=print`.
  - The footer never overlaps a grid or the word list; layout reserves its space.
- **Free book proofs** (the gate):
  - Bottom margin, every page: `FREE PROOF · made with Gridbook Studio · gridbookstudio.com`.
  - Top margin: `Proof copy, not for sale`.
  - Both are 8pt at 55% gray, outside the content box. Cover guide PNG/PDF exports also carry `Template by gridbookstudio.com` in the bleed area.
- **Pro credit line:** optional and **off by default**. When on, it prints "Puzzles created with Gridbook Studio (gridbookstudio.com)" in plain text on the copyright page.
  - It is off by default because KDP lists "PDF creation logos or watermarks" as a common failure point, and we should not put a paying customer's approval at risk.
  - Vellum's text credit is the precedent, but I did not verify KDP's treatment of ours.
  - Incentive to opt in: books that keep the line and send us their ASIN get listed on `/showcase/` (P2), which gives the author a backlink and us social proof.
- **Share links** (P1): "Send this puzzle" on any nonogram or sudoku opens `/play/#…` in solve mode, with a "Make a whole book of these" CTA.
  - The solved picture reveal is the shareable moment: "solved it, it's an owl."
- **Affiliates:** 40% through Gumroad's built-in affiliate program. Give every reviewer and YouTuber a free lifetime key (100%-off code) plus their affiliate link.
- **Dogfooding:** every sample PDF, OG image, Product Hunt gallery shot and Pinterest pin is made with the tool and carries the footer.
- **"Request a puzzle type or theme" form** (a `mailto:` link): each request becomes a new engine or theme plus a new SEO page.

---

## 8. Launch plan

### 8.1 Fourteen days (day 1 = Monday 2026-11-09)

| Day | Date | Actions |
|---|---|---|
| D1 | Mon 11/9 | Run the trademark knockout search; buy the domain (about $10–12/yr). Deploy to Cloudflare Pages with Web Analytics on. Set up the two Gumroad products, the hidden $0 test product, and affiliates at 40%. Fill in `config.js`. Run the license end-to-end test. Add Google Search Console and Bing Webmaster Tools and submit the sitemap. Generate the 3 sample PDFs and OG images with the tool. |
| D2 | Tue 11/10 | Finish the 6 SEO pages and request indexing. Create Reddit, HN and Product Hunt accounts and start **genuine** commenting with no links. HN restricts Show HN for new accounts, so you need history. Join 8–10 large Facebook KDP groups (search "KDP low content", "KDP puzzle books", "Amazon KDP publishing"). Read every group's rules and note its promo day. |
| D3 | Wed 11/11 | Free listings: AlternativeTo (as an alternative to Book Bolt), SaaSHub, Peerlist profile, Uneed free queue, BetaList free review, Fazier, Microlaunch. |
| D4 | Thu 11/12 | Record 3 short demos (8.3) and post to TikTok, YouTube Shorts and Reels. Post one a day from now on. Open a Pinterest business account and pin 10 free printable puzzle pages, each linking to its SEO page. |
| D5 | Fri 11/13 | First Facebook value post on each group's promo day. Give away a free 50-puzzle "New Year Large-Print Brain Games" printable pack for personal use, with the Studio link in a comment where rules allow. Post in r/KDPLowContent if its rules allow tool posts; read them first. |
| D6 | Sat 11/14 | r/SideProject: 30-second video demo, link in the first comment, reply to everything. r/webdev "Showoff Saturday" thread only. |
| D7 | Sun 11/15 | Direct replies: find 20 existing threads ("Book Bolt alternative", "puzzle book software", "nonogram generator", "how do I format a puzzle book for KDP") on Reddit, Facebook and the KDP community forum. Answer the question first; mention the free tool only where relevant. |
| D8 | Mon 11/16 | Outreach to 20 small KDP YouTubers (1k–30k subscribers; find them with YouTube searches like "puzzle book KDP 2026") offering a free lifetime key and 40% affiliate commission. Post on Indie Hackers ("I built a puzzle-book studio that runs in the browser", with real numbers). Launch on Peerlist. |
| D9 | Tue 11/17 | Product Hunt launch at 12:01am PT, with a gallery made by the tool. Do not ask for upvotes. Answer comments all day. |
| D10 | Wed 11/18 | Show HN, if the account is eligible. Otherwise keep building comment history and skip it. |
| D11 | Thu 11/19 | Read the funnel: Cloudflare visits by page, Gumroad views to sales, top referrers. Rewrite the hero headline if under 1.5% of visitors reach the Studio. Move the demo higher if needed. |
| D12 | Fri 11/20 | Price test: launch lifetime at $24 for 7 days if visits to sales stays under 0.3%. Ship one P1 engine (kakuro first) plus its SEO section. Second Facebook promo-day post (a Valentine's theme pack). |
| D13 | Sat 11/21 | r/webdev Showoff Saturday #2. Share a free nonogram set in solver communities where sharing puzzles is allowed (r/nonograms, r/puzzles; check rules first). Post in Discord showcase channels. |
| D14 | Sun 11/22 | Publish a transparent numbers recap on Indie Hackers. Pick the best channel and double down. Plan the Black Friday (Fri 11/27) lifetime offer and the "January brain-games" push. |

### 8.2 Where to post, and the rules I know

Confidence is marked. Re-read every rule before posting.

| Place | Rule or norm | Confidence |
|---|---|---|
| r/KDP | Bans low-content keywords and book promotion. **Do not** post the tool; answer questions without links | Medium (teammate research) |
| r/KDPLowContent | The suggested venue. Check whether tool posts are allowed or confined to a thread | Low: verify |
| r/SideProject | Show-and-tell allowed. Video demo with the link in the first comment works best | Medium |
| r/webdev | Projects only in the weekly Showoff Saturday thread. Ad-like posts are removed (9:1 self-promotion guideline) | Medium |
| r/InternetIsBeautiful | Since April 2026, "generic and repetitive" sites are held for manual review. Try at most once, with the picture-to-nonogram angle | Medium |
| r/Teachers, r/homeschool | Strict self-promotion rules. Share free printables only where resource posts are allowed | Low: verify |
| Facebook KDP groups | Most allow promotion only on promo days. Lead with free value | Medium |
| Hacker News (Show HN) | Must be something people can try without signup; no landing pages or "quickly generated one-off projects"; no vote solicitation. New accounts restricted since about March 2026 | High |
| Product Hunt | Launch at 12:01am PT. Results with zero audience are mostly luck (2–4 upvotes is common) | Medium |
| AlternativeTo, SaaSHub | Free listing. AlternativeTo is reported to drive real traffic | Medium |
| Peerlist Launchpad | 11–90 visits per launch reported. Treat it as a backlink | Medium |
| Uneed | Free queue of 30 days to 5 months; fast track about $14.99 (skip it) | Medium |
| BetaList | Free review takes about 2+ months; expedited $99–129 (skip it) | Medium |
| Gumroad Discover | 30% fee, but buyers search there. Eligibility rules apply | Medium |

### 8.3 Launch copy

- **Show HN title:** `Show HN: Turn any picture into a no-guess nonogram puzzle book, in the browser`
- **Product Hunt tagline** (54 characters): `Print-ready puzzle books for KDP, built in your browser`
- **Short-form video hooks** (15–30s, captioned, with the result shown in the first frame):
  1. "I turned my cat into a puzzle." Photo goes in, the 15×15 grid appears, a time-lapse solve, then the cat is revealed. Ends on "Make a whole book of these."
  2. "A 100-page large-print word search book in 60 seconds, with no subscription." Screen recording with an on-screen timer: template to export, then scroll through the PDF.
  3. "KDP rejected my puzzle book for the gutter. Here's the fix." Margin overlay on, page count crosses 150, the gutter steps up automatically, preflight turns green.

---

## 9. Revenue math

**Assumptions**
- Prices as in Section 2, with Gumroad direct fees.
- Net per sale: $24.46 at $29, $33.17 at $39, $7.04 for the $9 pass.
- Affiliate commission of 40% is assumed to be taken on the sale price: $11.60 per $29 sale, $15.60 per $39 sale. Verify how Gumroad calculates it.
- Conversion means paid purchases divided by site visits.
- Reference points:
  - Bank Statement Converter converted about 1.3% of people who uploaded a file (2023, self-reported).
  - Mockupanda earns $1.23 revenue per visitor (TrustMRR).
  - 67.6% of TrustMRR startups have under $1k all-time revenue.
- **The conservative case is the single most likely outcome.** The base case requires the daily distribution work in Section 8.

| Scenario | Visits | Conversion | Sales (lifetime / pass; affiliate-referred) | Net to owner |
|---|---|---|---|---|
| **Month 1, conservative** | 500 (posts removed, few Facebook approvals) | 0.3% | 1 / 1; 0 | **≈ $31**. Below Gumroad's $100 payout minimum, so no payout yet |
| **Month 1, base** | 1,750 (2 Facebook posts land, r/SideProject, Product Hunt a few dozen, directories about 200, 2–3 small YouTube mentions) | 0.8% | 9 / 5; 4 | 9×24.46 + 5×7.04 − 4×11.60 = **≈ $210** |
| **Month 1, optimistic** | 6,000 (one 20k-subscriber KDP YouTuber covers it, or one Facebook post goes viral) | 1.5% | 60 / 30; 25 | 1,467.60 + 211.20 − 290 = **≈ $1,390** |
| **Month 6, conservative** (per month, lifetime at $39) | 1,200 (SEO slow, outreach stopped) | 0.3% | 2 / 2; 0 | **≈ $80/mo** |
| **Month 6, base** | 6,000 (about 15 pages ranking on long-tail terms, calculators bringing most visits, steady affiliates) | 0.6% (calculator traffic converts worse) | 20 / 16; 5 | 663.40 + 112.64 − 78 = **≈ $700/mo** |
| **Month 6, optimistic** | 20,000 | 1.0% | 120 / 80; 40 | 3,980.40 + 563.20 − 624 = **≈ $3,920/mo** |

- The base month-1 case is about $0.12 net per visit, roughly a tenth of Mockupanda's revenue per visitor, so the uncertainty is traffic, not conversion.
- On Polar, each lifetime sale would net about $2.60 more ($27.05 vs $24.46 at $29), before the 1.5% surcharge on non-US cards.
- Startup cost: about $12 (the domain). Optional: about $5–15 for a KDP proof copy (not verified).
- Time cost: about 1–2 hours a day on distribution for 14 days.

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Direct competition.** PuzzleBindery ($49/$79, 3 months older, with SEO pages already up), Sudoku Maker, WordSearchKDP, Book Bolt. A rival could add nonograms quickly | Lead with picture and logic puzzles plus the no-guess guarantee; undercut on price; offer the $9 pass; ship P1 engines in week 1; plant SEO on day 1; compete on visible quality (sample PDFs, the printed proof photo) |
| **KDP's cap of 2 new titles per format per week** shrinks volume publishers; Amazon keeps tightening on low-effort books | Sell on per-book quality and distinctiveness (picture puzzles, graded difficulty, large print), not volume. Seeds guarantee no two books match. Custom themes and word lists |
| **KDP rejects a file** (fonts, margins, line weight, watermark) | `putOnlyUsedFonts:true` and TTF-only fonts; DeviceGray only; 0.75pt minimum lines; 7pt minimum text; gutter from final page count; preflight; owner's draft upload and proof copy before launch; refund promise |
| **License bypass** in DevTools | Accept it. Low price, a license that businesses respect, no DRM time sink. Polar's server-enforced quotas are available later |
| **Gumroad**: fees of about 15.7% on a $29 sale, $100 payout minimum, policy changes, and blockers that stop `api.gumroad.com` | Polar adapter ready (`provider:'polar'`); Ed25519 offline codes; 30-day offline grace; clear "couldn't reach Gumroad" message |
| **Trademarks and naming** | Knockout searches before buying the domain; no Amazon, KDP, Kindle or puzzle brand names in brand, domain or titles; generic puzzle names (calcudoku, nonogram); two backup names ready |
| **Image rights in picture nonograms** | Built-in library from MIT-licensed Phosphor icons (listed on the credits page; whether MIT notice applies to printed derivative grids is low-risk but unverified); upload notice that the user must own the rights |
| **Offensive words appearing in word-search filler** | Blocklist scan in all 8 directions plus re-fill; unit-tested |
| **AI-disclosure confusion** | FAQ: puzzles are algorithmic, not AI-generated. The AI word-list helper shows KDP's disclosure rule beside it |
| **Generation or uniqueness bugs** (kakuro and calcudoku are the hardest) | `verify()` on every puzzle before export; Node tests over thousands of seeds; deadlines with retry; ship those types only after P0 is solid |
| **Browser limits** (Safari memory, old browsers, iOS large exports) | Feature detection; the PDF built in a worker with progress; warning above 150 pages on iOS; a main-thread fallback in chunks |
| **Seasonality.** The Christmas window has mostly passed | Hooks for January brain games, Valentine's, Easter and Mother's Day; Black Friday lifetime offer on 11/27 |
| **Distribution fails** (posts removed, Product Hunt flops) | Lean on channels that work for a nobody: direct replies, Facebook promo days, YouTuber affiliates, Pinterest printables; SEO pages compound from week 4–8 |
| **Refund abuse** (buy, export, refund) | Accept the small loss at this price; Gumroad flags repeat refunders; the refund promise is still worth more than it costs |
| **Account eligibility.** Stripe-based identity checks on Gumroad and Polar usually require an adult account holder | If the owner is under 18, a parent or guardian holds the payment account |

---

## Appendix: sources fetched for this spec (2026-11-09)

- KDP trim sizes, bleed and margins: https://kdp.amazon.com/en_US/help/topic/GVBQ3CMEQW3W2VL6
- KDP paperback submission guidelines (fonts, line width, failure points including "PDF creation logos or watermarks"): https://kdp.amazon.com/en_US/help/topic/G201857950
- KDP paperback cover and spine formulas: https://kdp.amazon.com/en_US/help/topic/G201953020
- KDP weekly title limits: https://kdp.amazon.com/en_US/help/topic/G202172740
- KDP low-content books (puzzle books "not generally low-content"): https://kdp.amazon.com/en_US/help/topic/GGE5T76TWKA85DJM
- KDP content guidelines (AI disclosure): https://kdp.amazon.com/en_US/help/topic/G200672390
- Gumroad license keys and verify API: https://gumroad.com/help/article/76-license-keys
- Gumroad fees: https://gumroad.com/help/article/66-gumroads-fees
- Polar license-key validate (OpenAPI): https://polar.sh/docs/api-reference/customer-portal/license-keys/validate
- Competitor pages read: https://puzzlebindery.com/, https://puzzlebookmaker.com/sudoku, https://largeprintpuzzlemaker.com/, https://nonogrammaker.com/
- Library versions: npm registry (jspdf 4.2.1, fflate, lz-string 1.5.0, qrcode-generator, @phosphor-icons/core 2.1.1) and cdnjs (jspdf 4.2.1 file list)
- Domain checks: https://rdap.org/ lookups for every candidate name listed in Section 1
- Revenue base rates and competitor revenue: the provided TrustMRR, Ahrefs, Starter Story and Indie Hackers research, as cited in the brief