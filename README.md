# Gridbook Studio

Print-ready puzzle books, made in the browser. Word search, sudoku, mazes and picture nonograms, laid out to Amazon
KDP's paperback file requirements (trim, gutter, margins, bleed, spine), with answer keys, front and back matter, a
cover template and printables. Everything runs on the visitor's device; nothing is uploaded.

It is a static site: plain HTML, CSS and ES modules, no build step and no runtime dependencies beyond two vendored
libraries (jsPDF and fflate). It can be hosted for free on Cloudflare Pages.

## How it makes money

| Plan | Price | What you get |
|---|---|---|
| Free | $0 | The whole Studio. Exports carry a "FREE PROOF" header and footer, so they can't be published. |
| 7-Day Pass | $9 once | Clean exports for 7 days, plus PNG and ZIP exports. |
| Lifetime | $29 once until 2027-01-31, then $39 | The same as the pass, forever. |

Checkout and license keys are handled by Gumroad (Polar is supported as an alternative). The keys are checked in the
browser, so there is no server to run. Offline unlock codes for reviewers are signed with your own Ed25519 key.

## Try it locally

You need Node.js 20 or newer.

```sh
node tools/serve.mjs          # serves site/ at http://localhost:8080/
npm test                      # about 700 tests; the browser tests run if Playwright is installed
```

Open <http://localhost:8080/> for the marketing site, or <http://localhost:8080/app/> for the Studio.

## Going live

1. **[SETUP.md](SETUP.md)**: create the two Gumroad products, fill in `site/config.js`, buy a domain and replace
   `gridbookstudio.com`, deploy `site/` to Cloudflare Pages, fill in the legal pages, and work through the pre-launch
   checklist. About 2 hours. Payment accounts need an adult (18+) account holder.
2. **[LAUNCH.md](LAUNCH.md)**: a 14-day launch plan with ready-to-paste posts, pricing experiments and honest revenue
   estimates. The conservative month-1 estimate is about $31; the base case is about $210 and needs daily distribution
   work.

Running costs are about $12 a year for the domain. Gumroad takes a fee per sale.

## What's in the repo

```
site/                    everything that gets deployed
  index.html, pricing/   landing page with a live demo, and pricing
  app/                   the Studio
  *-maker/, *-generator/ free puzzle generator pages (SEO entry points)
  kdp-*-calculator/      KDP spine-width and margin calculators
  book-bolt-alternative/ comparison page
  legal/                 terms, privacy, refunds, license, credits (drafts with owner blanks)
  config.js              owner settings: Gumroad IDs, prices, domain, support email
  js/puzzles/            puzzle engines (pure, deterministic, seeded)
  js/layout/, js/kdp/    book layout, KDP specs and preflight checks
  js/render/             canvas, PDF and SVG renderers
  js/license/            Gumroad, Polar and offline-code licensing
  js/ui/, js/core/       Studio interface, store with undo, project model
  samples/, og/, img/    sample PDFs, social images, icons (generated, see below)
tools/                   dev server, key and code signing, asset generators, tests
docs/SPEC.md             product spec and research
CONTRACTS.md             module interfaces
```

Generated files are committed. If you change the engines, the layout, prices or the domain, re-make them:
`node tools/make-samples.mjs`, `node tools/make-og.mjs`, `node tools/make-gallery.mjs`. The tests fail when they are
stale.

## Known limits

- Licensing is client-side, so a determined user can bypass it. That trade-off keeps hosting free and the app private.
- Exported PDFs meet KDP's technical file requirements. Amazon still reviews every book, and the product doesn't
  promise approval or sales.
- Not yet tested on real iPhones, iPads or Safari; touch was tested in emulation only.
- From 2027-02-01 a test fails on purpose until you run `node tools/sync-prices.mjs` and `node tools/make-og.mjs`.
  This makes sure the static pages stop showing the launch price (SETUP.md, step 2.2).
