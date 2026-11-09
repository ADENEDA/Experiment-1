# Gridbook Studio: owner setup guide

This guide takes you from "the code is on my computer" to "people can buy Pro on my own website". It is written for
someone who is not a developer. Every command below was run on a copy of this repository on 2026-11-09 and works as
shown, except the Git commands in step 5.1 and the Playwright install in step 6, which could not be run here. The
Gumroad and Cloudflare steps happen in their websites; their menu names change from time to time, so look for the
nearest match if a label differs.

**Time needed:** about 2 hours, most of it waiting for accounts and DNS.
**Money needed:** about $10–12 a year for a domain. Gumroad and Cloudflare cost nothing up front; Gumroad takes a fee
from each sale (10% + $0.50, plus 2.9% + $0.30 card processing on direct sales, according to its fees page on
2026-11-09).

> **Payment accounts need an adult (18+) account holder.** Gumroad and Polar verify the identity of the person who gets
> paid (through Stripe). If you are under 18, a parent or guardian must own the payment account.

**Contents**

1. [Run it on your computer and try it](#1-run-it-on-your-computer-and-try-it)
2. [Set up Gumroad and `config.js`](#2-set-up-gumroad-and-configjs)
3. [Optional: offline codes for reviewers](#3-optional-offline-codes-for-reviewers)
4. [Get a domain and put it everywhere](#4-get-a-domain-and-put-it-everywhere)
5. [Put the site online with Cloudflare Pages](#5-put-the-site-online-with-cloudflare-pages)
6. [Re-make the samples and preview images](#6-re-make-the-samples-and-preview-images)
7. [Fill in the legal pages](#7-fill-in-the-legal-pages)
8. [Pre-launch checklist](#8-pre-launch-checklist)
9. [Later: switching to Polar](#9-later-switching-to-polar)
10. [Troubleshooting](#10-troubleshooting)

**How to type commands.** Commands go in a terminal: *Terminal* on a Mac, or *Git Bash* on Windows (it comes with
[Git for Windows](https://git-scm.com/download/win)). First move into the project folder, for example
`cd ~/Experiment-1`. Every command in this guide is run from that folder.

---

## 1. Run it on your computer and try it

1. Install **Node.js** (the LTS version, 20 or newer) from <https://nodejs.org>. Check it worked:

   ```sh
   node --version
   ```

   It prints something like `v22.11.0`.

2. Start the local web server:

   ```sh
   node tools/serve.mjs
   ```

   It prints `Serving …/site at http://localhost:8080/`. Leave this window open; press `Ctrl+C` to stop the server
   later. (If port 8080 is busy, pick another: `node tools/serve.mjs 8090`.)

3. Open <http://localhost:8080/> in your browser and try everything a customer would:
   - the home page demo, the two calculators and the three puzzle tool pages;
   - **Open the Studio** (`/app/`): pick a template, change puzzles, press **Export** and download the interior PDF;
   - open the PDF and check that every page carries the "FREE PROOF" footer and "Proof copy · not for sale" header.
     That is the free edition working as designed.

Nothing needs installing beyond Node. There is no build step: the `site/` folder *is* the website.

---

## 2. Set up Gumroad and `config.js`

`site/config.js` is the file you edit to start selling, plus two lines in `site/_redirects` (step 2.4). Nothing in
them is secret: product IDs and checkout links are public by design. Open them in any text editor (TextEdit in
plain-text mode, Notepad, VS Code).

### 2.1 Create your Gumroad account

Sign up at <https://gumroad.com>. Finish the payout settings (bank account or PayPal) and the tax information before
launch, or you can't be paid. Gumroad's menus change from time to time, so the labels below may differ slightly.

### 2.2 Create the Lifetime product ($29)

1. **New product** → choose a digital product. Name: `Gridbook Studio Lifetime`. Price: **$29**.
2. Set the product's URL (in the product settings) to end in `gridbook-lifetime`. Your link will look like
   `https://YOURNAME.gumroad.com/l/gridbook-lifetime`.
3. Open the product's **Content** page, choose **Insert**, then **License key**. Gumroad will now email every buyer a
   unique key and show it on their receipt page.
4. The license key block shows the product's **product_id** (a short code such as `SDGgCnivv6gTTHfVRfUBxQ==`).
   Copy it.
5. Paste the description and the content-page text from [2.5](#25-copy-for-your-gumroad-pages) below.
6. Publish the product.

**The launch price.** The site shows Lifetime at $29 until the end of `launchEnds` (2027-01-31) and $39 from
February 1, 2027. The switch is by date only: there is no limit on the number of buyers, so never claim one. Gumroad
does not change your price for you, so put a reminder in your calendar for **February 1, 2027**, and that day:

1. In Gumroad, change the Lifetime price to **$39**.
2. Run `node tools/sync-prices.mjs`. It writes the prices from `config.js` that apply that day into the pages
   themselves: every Lifetime price reads $39, the "Launch price until Jan 31, 2027" notes are hidden, and the
   Lifetime offer in `site/index.html`'s structured data says 39 without `priceValidUntil`. Browsers running the
   page script switch by themselves, but search engines, link previews and visitors without JavaScript read the
   pages as you upload them. (`node tools/sync-prices.mjs --check --date 2027-02-01` shows beforehand which files
   it will change.)
3. Re-make the preview images (`node tools/make-og.mjs`, step 6), so `og/pricing.png` stops showing the launch price.
4. Run `npm test`, then commit and push. From February 1, `npm test` fails until steps 2 and 3 are done.

Leave the `pricing` block in `config.js` as it is: every price on the pages and in the Studio comes from it and
switches to $39 by itself. The only other place that names the Lifetime prices in plain text is the pricing FAQ
"Will the Lifetime price go up?" (`site/pricing/index.html`, in the page and in its structured data), and it states
both dates, so it stays true. Page titles and descriptions don't name the Lifetime price. If you ever change a price
itself (not just the date), change it in `config.js`, in Gumroad and in that FAQ, then run
`node tools/sync-prices.mjs` and re-make the preview images.

Buyers at $29 keep every future update. Don't extend the launch price quietly: that turns a real deadline into a fake
one. To test a lower price, use a Gumroad discount code with its own end date (`LAUNCH.md` §4), not `config.js`.

### 2.3 Create the 7-Day Pass ($9)

Same steps: name `Gridbook Studio 7-Day Pass` (the site and the Studio call it the 7-Day Pass), price **$9**, URL ending in `gridbook-sprint`, insert a
**License key**, copy its **product_id**. The pass length is enforced by the Studio (7 days from the purchase time
Gumroad reports), not by Gumroad, so don't set any expiry in Gumroad.

### 2.4 Paste the IDs and links into `config.js`

In `site/config.js`, replace the four placeholders:

```js
  gumroad: {
    lifetime: { productId: 'PASTE_LIFETIME_PRODUCT_ID', url: 'https://YOURNAME.gumroad.com/l/gridbook-lifetime' },
    pass: { productId: 'PASTE_PASS_PRODUCT_ID', url: 'https://YOURNAME.gumroad.com/l/gridbook-sprint', days: 7 },
    test: { productId: '' },
    maxActivations: 5,
    legacyProductIds: [],
  },
```

- `lifetime.productId`: the Lifetime product_id, between the quotes.
- `lifetime.url`: the Lifetime product link.
- `pass.productId` and `pass.url`: the same for the pass. Don't mix the two IDs up: a key's tier comes from the slot
  its product sits in, so swapped IDs turn new and existing Lifetime keys into 7-day passes until you fix them.
- Leave `days: 7`, `maxActivations: 5`, `provider: 'gumroad'` and the `pricing` block as they are
  (`pricing: { lifetime: 29, lifetimeRegular: 39, pass: 9, launchEnds: '2027-01-31', currency: 'USD' }`).
- Leave `legacyProductIds: []` empty. The Studio re-checks keys only against the products named here, so if you ever
  replace a product after launch, put the old product_id in it (`legacyProductIds: ['the_old_id']`) when you paste
  the new one, or the old product's buyers drop to the free edition at their next weekly check.

Until the placeholders are replaced, buy buttons show "Checkout is not set up yet" and keys can't be checked. Reload
the local site: the buy buttons on `/pricing/` now open Gumroad.

Then, in `site/_redirects`, put the same two links in place of `/pricing/` on the `/buy/lifetime` and `/buy/pass`
lines, for example `/buy/lifetime  https://yourshop.gumroad.com/l/gridbook-lifetime  302`. The buy buttons in the
pages link to `/buy/lifetime` and `/buy/pass` until the page script swaps in the links from `config.js`, and for
visitors with JavaScript off. Until you do this, those two addresses open the pricing page, so nothing breaks.

### 2.5 Copy for your Gumroad pages

Plain and honest; edit freely. Replace `gridbookstudio.com` if you use another domain.

**Lifetime: description**

> Make print-ready puzzle book interiors for Amazon KDP, and printable puzzle pages, in your browser.
> One payment, no subscription.
>
> - Clean exports with no proof marks: KDP interior PDFs, unlimited printables (US Letter or A4), 300 DPI PNGs,
>   and a ZIP bundle with the cover template, answer key and a README of the KDP upload settings.
> - A commercial license: sell on KDP, Etsy or Gumroad, or use the puzzles in paid newsletters.
> - Every future update. Works in up to 5 browsers or devices.
> - 30-day refund, including if KDP rejects your interior for a technical-spec reason.
>
> Try it first: the free edition at gridbookstudio.com builds and previews the whole book.

**7-Day Pass: description**

> All of Pro for 7 days from purchase: clean KDP interiors, unlimited printables, PNG and ZIP exports, and a
> commercial license. Books you export during the 7 days stay yours to sell. It doesn't renew and there is nothing
> to cancel. 30-day refund, including if KDP rejects your interior for a technical-spec reason.

**Content page (both products), next to the license key block**

> Thank you! To unlock Pro:
> 1. Open https://gridbookstudio.com/app/
> 2. Click **Free** in the top bar (or try an export and choose Unlock Pro).
> 3. Paste the license key shown here and press **Activate**.
>
> Your key works in up to 5 browsers or devices. Questions or a refund: hello@gridbookstudio.com

### 2.6 Affiliates and reviewer discounts

- Turn on Gumroad's **affiliate** program for both paid products at **40%**. Affiliates get their own Gumroad links,
  and Gumroad tracks and pays their commission.
- Create a **100%-off discount code** (Gumroad's discount settings) for reviewers and YouTubers. A reviewer who "buys"
  Lifetime with it gets a real key. Limit the number of uses, and make a new code for each batch. Let the code apply to
  the 7-Day Pass too, so you can use it for the real-product test in 2.7.

### 2.7 Test the whole license flow with a hidden $0 product

This proves that buying, receiving a key and unlocking Pro all work, without spending money.

1. Create a third product: `Gridbook Studio test key`, price **$0**, and insert a **License key** on its content
   page. Don't add it to your profile and don't share its link. Copy its product_id.
2. In `config.js`, paste it into `test: { productId: '…' }`.
3. Open the product's link, "buy" it for $0 with your own email, and copy the key from the receipt.
4. Open <http://localhost:8080/app/?licensetest=1> (the `?licensetest=1` part matters), click **Free** in the top
   bar, paste the key and press **Activate**. The badge turns to **Pro** and the key hint shows "(test)".
5. Export the interior PDF again: the proof header and footer are gone.
6. Optional: `/app/?licensetest=pass` tests the same key as a 7-day pass (the badge counts down from the $0 purchase).
7. In the Unlock dialog press **Deactivate on this device**.

When you are happy, empty `test.productId` again (`test: { productId: '' }`). Every test key then stops unlocking
Pro, wherever it was activated. If you want to repeat this test on the live site (step 8), keep it until that check
is done, then empty it and push straight away: while it is set, anyone who finds the $0 product's link can get a key
that unlocks Lifetime with `?licensetest=1`.

Then test the **real** products once, after deployment (step 5): use your 100%-off code to "buy" the 7-Day Pass, open
your live site's `/app/` **without** `?licensetest`, and activate that key. The badge should read "Pass: 7 days left"
(or close to it). Deactivate when done.

**What the check sends:** only the key, the product_id and whether to count a new device, straight from the buyer's
browser to `api.gumroad.com`. Book content never leaves the device. The Privacy page says the same.

**If a buyer hits the 5-device limit.** The pricing page and the Studio promise to free up room when a buyer asks.
Each browser counts once, the first time the key is activated in it, so private windows, new browser profiles and
cleared site data each use a slot (your own tests in step 8 use slots too). The Studio refuses a new activation once
Gumroad's count is above 5. Gumroad can't reset the count to zero, but its API can lower it by one per call:

1. In Gumroad, open **Settings → Advanced → Applications**, create an application (any name; the redirect URI can be
   `http://localhost`), then press **Generate access token**. Keep the token private: never put it in `config.js`
   or anywhere in this project.
2. Lower the count by one for each slot to free (the buyer's key and the product_id of the product they bought):

   ```sh
   curl -X PUT https://api.gumroad.com/v2/licenses/decrement_uses_count \
     -d access_token=YOUR_TOKEN -d product_id=PRODUCT_ID -d license_key=THE_BUYERS_KEY
   ```

   The reply shows the new `uses`. A new device can activate while it is 4 or lower. (This endpoint is in Gumroad's
   API documentation; it could not be run while writing this guide, so check the reply the first time.)

If you'd rather not use the API, send an offline code instead (step 3). Match what they bought: a Lifetime code for a
Lifetime buyer, or for a 7-Day Pass buyer a pass code that starts when their purchase did:
`--type pass --iat <sale time>`, with the sale time as Gumroad reports it (`sale_timestamp`, like
`2026-11-09T20:00:00Z`). A pass code runs 7 × 24 hours from that moment, not from when it's used, so it ends when the
pass they bought does. The license check (the same call the Studio makes) shows it as `purchase.sale_timestamp`
without using up a device slot; like the call above, it could not be run against a real key while writing this guide:

```sh
curl https://api.gumroad.com/v2/licenses/verify \
  -d product_id=PASS_PRODUCT_ID -d license_key=THE_BUYERS_KEY -d increment_uses_count=false
```

With only a date (`--iat 2026-11-09`) the code starts at 00:00 UTC that day and can end up to a day before their
pass; if you don't have the time, give the next day's date instead.

---

## 3. Optional: offline codes for reviewers

Offline codes unlock Pro without Gumroad: useful for reviewers, giveaways, or if Gumroad is ever unreachable. They are
signed with a private key that only you have, and checked in the browser with a public key in `config.js`.

1. Create your key pair (once):

   ```sh
   node tools/keygen.mjs
   ```

   It writes the private key to `tools/.private-key` and prints a line like:

   ```
   offlineCodes: { publicKey: 'OkgJZhiA-OiuzSVpdAyUJLcg0VtqvhEMQt2c_xrloZA' },
   ```

   Paste **your** printed line over the `offlineCodes: { publicKey: '' },` line in `site/config.js`.

2. **Keep `tools/.private-key` secret and backed up** (for example in your password manager). Anyone who has it can
   make Pro codes. It is listed in `.gitignore` (`tools/.private-key`), so Git will not upload it, but never copy it
   anywhere public. Running `keygen.mjs` again refuses to overwrite it; `--force` replaces it, and every code signed
   with the old key stops working once the new public key is in `config.js`.

3. Make codes:

   ```sh
   node tools/sign-code.mjs --name reviewer-jane --type lifetime
   node tools/sign-code.mjs --name reviewer-bob --type lifetime --days 30
   node tools/sign-code.mjs --name weekend-promo --type pass
   ```

   Each prints one code (it starts with `GBS1.`). The first never expires, the second works for 30 days, and the third
   is a 7-day pass. Like `--days`, a pass runs for exactly that many days from the moment you sign it (it shows "7 days
   left" and ends at the same time of day, like a pass bought on Gumroad), or from `--iat`: the moment given as a
   UTC date-time (`--iat 2026-11-09T20:00:00Z`) or the start of the UTC day given as a date (`--iat 2026-11-09`). It
   does not wait for the day it is used, so send it straight away. The command prints when the
   code ends. The `--name` is printed in the buyer's Unlock dialog, so use something you will recognise.

   Give every person their own `--name`. A code without `--days` works for anyone who has it, for ever, so keep those
   for one named person you trust, and use `--days` (or a pass) for anything posted publicly or sent to a group.

4. Send the code to the person. In the Studio they click **Free** → **Have an offline code?**, paste it and press
   **Use offline code**. Offline codes need a recent browser (Chrome 137+, Firefox 129+ or Safari 17+); older
   browsers are told to use a license key instead.

5. **If a code leaks**, withdraw just that one: add the `--name` it was signed with to a `revoked` list next to the
   public key in `site/config.js`, then push:

   ```js
   offlineCodes: { publicKey: 'OkgJZhiA-…', revoked: ['reviewer-jane'] },
   ```

   Every code signed with that name stops unlocking Pro the next time it is opened, in every browser; other codes keep
   working. Removing the name brings it back. (To stop **all** codes at once, replace the key pair with
   `keygen.mjs --force`; removing `publicKey` turns offline codes off, and codes already in use stop working too.)

---

## 4. Get a domain and put it everywhere

### 4.1 Check the name, then buy the domain

1. Before buying, search the trademark databases for "Gridbook" in classes 9 (software) and 16 (printed matter):
   [USPTO](https://tmsearch.uspto.gov), [EUIPO](https://euipo.europa.eu/eSearch/) and the
   [WIPO Global Brand Database](https://branddb.wipo.int). The spec notes that `gridbook.com` is already registered and
   that "Gridbook" may be used for graph-paper notebooks. Backup names: LogicBook Studio, PuzzleSheaf.
2. Buy the domain (about $10–12 a year for a `.com`). Buying it at **Cloudflare Registrar** keeps everything in one
   place and makes step 5 automatic, but any registrar works.
3. Never put Amazon, KDP, Kindle or puzzle trademarks (Picross, KenKen …) in the domain or brand.

### 4.2 Replace `gridbookstudio.com` everywhere

The site uses `gridbookstudio.com` in the canonical and social-preview links, the sitemap, `config.js`, the footer
email and the text printed on free exports. One command changes all of them. It edits only text files in `site/`,
`docs/` and `LAUNCH.md` (never the libraries in `site/vendor/`, never PDFs or images).

Type your domain in the first line, then paste both lines:

```sh
export OLD=gridbookstudio.com NEW=mypuzzlebooks.com
grep -rlIF --exclude-dir=vendor "$OLD" site docs LAUNCH.md | xargs perl -pi -e 'BEGIN { for (@ENV{qw(OLD NEW)}) { /^[\w.@-]+\.[a-z]{2,}$/i or die "Set OLD and NEW first, e.g. export OLD=gridbookstudio.com NEW=mypuzzlebooks.com\n" } } s/\Q$ENV{OLD}\E/$ENV{NEW}/g'
```

Check that nothing was missed (this should print nothing):

```sh
grep -rnI --exclude-dir=vendor "gridbookstudio.com" site docs LAUNCH.md
```

The support address becomes `hello@` your domain. To receive it, turn on **Cloudflare Email Routing** (free, under
your domain's *Email* settings) and forward `hello@` to your normal inbox.

To use an address you already have instead, change the email **before** the domain: run this first line, then the
same `grep … | xargs perl …` line as above, and only then the two domain lines.

```sh
export OLD=hello@gridbookstudio.com NEW=you@example.com
```

**If you don't buy a domain yet,** do not leave `gridbookstudio.com` in place: free exports would advertise a domain you
don't own, and search engines would be pointed at it. First change the support email as just shown (`pages.dev`
addresses can't receive mail), then run the domain lines with your Cloudflare address (from step 5), for example
`export OLD=gridbookstudio.com NEW=gridbook-studio.pages.dev`. When you buy a domain later, run them again with
`OLD=gridbook-studio.pages.dev`.

**After changing the domain,** re-make the sample PDFs and preview images (step 6).

**Developer tests (optional).** `npm test` checks the pages against the default domain. If you run the tests, apply
the same change to them (this also fixes the copies of the domain written as `gridbookstudio\.com` inside the tests):

```sh
perl -pi -e 'BEGIN { for (@ENV{qw(OLD NEW)}) { /^[\w.@-]+\.[a-z]{2,}$/i or die "Set OLD and NEW first\n" } ($eo = $ENV{OLD}) =~ s/\./\\./g; ($en = $ENV{NEW}) =~ s/\./\\./g } s/\Q$eo\E/$en/g; s/\Q$ENV{OLD}\E/$ENV{NEW}/g' tools/test/*.mjs
```

---

## 5. Put the site online with Cloudflare Pages

Cloudflare Pages hosts static sites for free, and it reads the `_headers` and `_redirects` files in `site/`.

**Why not GitHub Pages?** GitHub's terms say Pages is not meant for sites "primarily directed at … facilitating
commercial transactions", which a site that sells licenses is. GitHub Pages also ignores `_headers` and `_redirects`.

### 5.1 Put the code on GitHub

This project is a Git repository. If it isn't on GitHub yet, create an empty **private** repository on
<https://github.com/new> (no README), then:

```sh
git remote add origin https://github.com/YOURNAME/gridbook-studio.git
git push -u origin main
```

(Use your repository's address, and your branch name if it isn't `main`. GitHub Desktop can do the same with
buttons.) Commit and push your `config.js` changes too: Cloudflare deploys whatever is on GitHub.

### 5.2 Create the Pages project

1. Sign up at <https://dash.cloudflare.com> (free plan).
2. Go to **Workers & Pages** → **Create** → the **Pages** tab → **Connect to Git**. (If Cloudflare offers to create a
   *Worker*, look for the Pages option instead.) Allow Cloudflare to see your repository and select it.
3. Build settings:

   | Setting | Value |
   |---|---|
   | Production branch | `main` (the branch with the finished site) |
   | Framework preset | **None** |
   | Build command | *leave empty* |
   | Build output directory | `site` |
   | Root directory | *leave empty* |

4. **Save and Deploy.** About a minute later the site is live at `https://<project-name>.pages.dev`. From now on every
   push to the production branch redeploys it automatically.

Check the live site: `/`, `/app/`, `/pricing/`, `/legal/terms` (Cloudflare drops the `.html` from addresses, which
is why the sitemap lists them without it), `/studio` (should jump to the Studio) and a made-up address such as
`/nothing-here` (should show the "Page not found" page).

### 5.3 Connect your domain

In the Pages project open **Custom domains** → **Set up a custom domain**, enter your domain (for example
`mypuzzlebooks.com`) and follow the prompts. If the domain is registered at Cloudflare or uses Cloudflare's DNS,
the records are created for you; otherwise Cloudflare tells you which DNS record to add at your registrar. Add
`www.` as a second custom domain if you like; the pages' canonical links point search engines at the main domain.

### 5.4 Turn on Web Analytics

In the Pages project open **Metrics** → **Web Analytics** → **Enable**. It takes effect on the next deployment
(Cloudflare adds its small script to every page for you). It uses no cookies, so no cookie banner is needed. The
Privacy page already describes it; if you skip this step, delete that part of the Privacy page.

### 5.5 Tell search engines

1. [Google Search Console](https://search.google.com/search-console): add your domain, verify it (a DNS record;
   Cloudflare can add it), then under **Sitemaps** submit `https://yourdomain.com/sitemap.xml`.
2. [Bing Webmaster Tools](https://www.bing.com/webmasters): import your site from Google Search Console.

About `site/_headers`: it adds basic security headers (including one that stops other sites from showing your pages
inside a frame) and caching. Libraries and fonts are kept for a year (their
file names carry a version), and images, samples and preview images for a day. Code, styles and data (`site/js/`,
`site/css/`, `site/data/`) are checked with Cloudflare on every visit, like the HTML pages and `config.js`, so a
deploy is picked up at once: a file that hasn't changed costs a tiny "not modified" reply. Don't give them a longer
cache time: their names carry no version, and a returning visitor with some old and some new files would get a
Studio that never finishes loading. A Content Security
Policy is written there as a comment only; don't enable it without testing the Gumroad checkout (see the comment).

---

## 6. Re-make the samples and preview images

The three sample PDFs (`site/samples/`) carry your domain in their free-proof footer, and the social preview images
(`site/og/`) show it too. After changing the domain (or the prices), re-make them:

```sh
node tools/make-samples.mjs
```

This needs only Node. It rebuilds the three sample PDFs with the Studio's own code. If the `pdfinfo` tools (poppler)
are installed, it also checks them; that part is optional.

```sh
node tools/make-og.mjs
```

This renders the eight 1200×630 preview images with a headless Chromium browser, so it needs **Playwright**. Install
it once, inside the project folder (it goes into `node_modules/`, which Git ignores):

```sh
npm install --no-save playwright
npx playwright install chromium
```

(These two install commands are Playwright's standard ones; they could not be run while writing this guide.)

```sh
node tools/make-icons.mjs
```

Only needed if you change the **name or logo**: it redraws the favicon and app icons from the logo in
`docs/site-chrome.html` and rewrites `site/site.webmanifest`. It also needs Playwright for the PNG icons.

Then commit and push: Cloudflare redeploys. If you run the developer tests, `npm test` should pass again.

---

## 7. Fill in the legal pages

The five pages in `site/legal/` (Terms, Privacy, Refunds, License, Credits) are plain-English drafts that match how
the product really works: nothing uploaded, browser storage only, the license key sent only to Gumroad (or Polar),
Gumroad's script loaded only where you can buy, cookieless analytics, payments by Gumroad.

1. List every blank you need to fill in:

   ```sh
   grep -rn "OWNER:" site/legal
   ```

   Each one is highlighted on the page as `[OWNER: …]`: your legal name or business name, your city and country, a
   postal address, your governing law, your email provider, how long you keep records, and your reply time for
   refunds. Replace each whole `<mark>[OWNER: …]</mark>` with plain text.
2. If you didn't turn on Web Analytics, or host somewhere other than Cloudflare, edit those parts of the Privacy page.
3. **Have the pages reviewed by a qualified professional in your country** before you sell. They are a starting point,
   not legal advice. Consumer law (refunds, digital goods, EU/UK data rules) differs from place to place.
4. Delete the yellow "Site owner: review this page before you sell" box at the top of each page (the
   `<div class="callout callout-warn" role="note">…</div>` block).
5. The refund promise has two parts: a full refund within 30 days for any reason, and the KDP promise (a full refund
   if KDP rejects a Pro interior for a technical-spec reason). If you change it, change it everywhere it appears:
   - the Refunds page (`site/legal/refunds.html`), the Terms (sections 7 and 8) and the License page;
   - the home page (`site/index.html`): the KDP promise box and the FAQ answers "Will KDP accept the files?" and
     "What about refunds?", each in the page **and** in the FAQ structured data in the `<head>`;
   - the pricing page (`site/pricing/index.html`): the KDP promise box and the FAQ answer "What is the refund
     policy?", in the page and in its structured data;
   - the Studio: the Unlock dialog (`site/js/ui/unlock-dialog.js`) and the compact "30-day refund" note of the buy
     buttons (`site/js/ui/buy-buttons.js`);
   - your Gumroad product descriptions and content page (the copy in 2.5).

---

## 8. Pre-launch checklist

**Store**
- [ ] Gumroad payout and tax details are complete (account holder 18+).
- [ ] Lifetime is $29, the pass is $9, both have a License key, both are published.
- [ ] Affiliates on at 40%; a 100%-off reviewer code exists.
- [ ] A calendar reminder exists for February 1, 2027: Lifetime to $39 in Gumroad, plus the steps in 2.2.

**`site/config.js`**
- [ ] No `PASTE_` and no `YOURNAME` left anywhere in the site:
      `grep -rnE "PASTE_|YOURNAME" site --exclude-dir=js` prints nothing (the code in `site/js/` names them on
      purpose, to spot an unfinished `config.js`).
- [ ] `site/_redirects` sends `/buy/lifetime` and `/buy/pass` to your two product links (step 2.4).
- [ ] `siteUrl`, `printDomain` and `supportEmail` use your domain, and an email to `supportEmail` arrives.
- [ ] `offlineCodes.publicKey` is set if you use offline codes, and `tools/.private-key` is backed up.

**Site**
- [ ] `gridbookstudio.com` replaced (step 4.2); samples and preview images re-made (step 6).
- [ ] Legal blanks filled, reviewed, and the owner boxes removed (step 7).
- [ ] Deployed on Cloudflare Pages with your domain, HTTPS works, Web Analytics on.
- [ ] Sitemap submitted to Google Search Console and Bing.

**End to end, on the live site** (use a private/incognito window)
- [ ] `/pricing/`: both buy buttons open Gumroad's checkout.
- [ ] The $0 test key unlocks Pro with `?licensetest=1` (step 2.7), and a 100%-off pass purchase unlocks Pro without it.
- [ ] A free export shows your domain in the footer; a Pro export has no marks.
- [ ] The Studio works on a phone: open a template, preview, export.
- [ ] One real Pro interior uploaded to KDP as a **draft**, accepted by the previewer, and a printed proof copy ordered
      and checked. This is the best protection against a refund-promise surprise.
- [ ] Last: `test.productId` is empty again (`test: { productId: '' }`), pushed and deployed. Reload
      `/app/?licensetest=1` in the window where the $0 test key is active: the badge reads **Free** and the Unlock
      dialog says it was a test key.

**Before you post anywhere**
- [ ] Trademark knockout search done (step 4.1).
- [ ] Read `LAUNCH.md` for the 14-day plan.

---

## 9. Later: switching to Polar

The Studio can also check keys with Polar (lower fees, but Polar reviews new accounts before the first payout). In
`config.js`, set `provider: 'polar'` and fill in the `polar` block: `organizationId` (your organization's UUID; Polar
rejects anything that isn't a UUID), `lifetimeBenefitId` and `passBenefitId` (license-key benefits; set the pass
benefit to expire after 7 days), and `lifetimeCheckoutUrl` / `passCheckoutUrl`. Update the Terms and Privacy pages to
name Polar as the payment provider. Browsers already activated with a Gumroad key keep re-checking it with Gumroad
and stay Pro, but after the switch a Gumroad key can't be activated on a new device: send those buyers a Polar key or
an offline code. Decide before you have many buyers.

---

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| Buy buttons say "Checkout is not set up yet" | `config.js` still has `YOURNAME` in a URL. |
| "Store not configured yet" when activating | A product_id is still `PASTE_…`, or (with `?licensetest=1`) `test.productId` is empty. |
| "That key isn't valid for Gridbook Studio" | The key belongs to another product, it was mistyped, or a product_id in `config.js` has a typo. |
| "This key is active on many devices" | The buyer passed 5 devices. Free up room (end of step 2.7) or send an offline code (step 3). |
| The page loads but the Studio stays blank on your domain, while `*.pages.dev` works | In Cloudflare, under your domain's **Speed** settings, make sure **Rocket Loader** is off. |
| Old version still showing after a deploy | Code, styles and pages are checked on every visit (`site/_headers`), so reload once. Images, samples and preview images are cached for a day: reload with Shift to see new ones at once. If the Studio says it couldn't load, check that `_headers` still gives `/js/*`, `/css/*` and `/data/*` `max-age=0, must-revalidate`. |
| `node tools/make-og.mjs` says Playwright is not available | Run the two install commands in step 6 inside the project folder. |
| The sample PDFs test fails after a domain change | Run `node tools/make-samples.mjs`. |
