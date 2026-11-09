// Writes the prices that apply today into the static HTML: node tools/sync-prices.mjs [--check] [--date YYYY-MM-DD]
//
// site.js sets every price from site/config.js when a page loads, but crawlers, link previews and visitors without
// JavaScript read the HTML as shipped. This script makes that HTML say what site.js would say today
// (pricingInfo() from site/js/ui/buy-buttons.js, the same function site.js uses):
//   - the text of every data-cfg-price element ("$29" during the launch, "$39" once pricing.launchEnds has passed),
//   - a `hidden` attribute on every data-cfg-launch note once the launch price has ended (none while it applies), and
//     the opposite on data-cfg-after-launch,
//   - the 7-Day Pass and Lifetime offers in the application/ld+json blocks (price, and priceValidUntil = launchEnds
//     only while the launch price applies).
// Run it on February 1, 2027 (SETUP.md 2.2), and after changing a price in config.js. It changes nothing else, and
// running it twice changes nothing more. npm test fails while the static HTML and today's prices disagree.
//
//   --check            list the files that would change and exit 1 if any would, without writing
//   --date YYYY-MM-DD  use that day (noon, local time) instead of today, e.g. to preview February 1
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../site/config.js';
import { pricingInfo, formatPrice } from '../site/js/ui/buy-buttons.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SITE = join(ROOT, 'site');

/** Every .html file under site/ (vendor code excluded). */
export function htmlFiles(dir = SITE) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') out.push(...htmlFiles(p)); } else if (e.name.endsWith('.html')) out.push(p);
  }
  return out.sort();
}

/** Toggle the boolean `hidden` attribute on every opening tag that carries attribute `attr`. */
function setHidden(html, attr, hidden) {
  const has = new RegExp(`\\s${attr}(?=[\\s>=/])`);
  return html.replace(/<[a-z][a-z0-9]*\b[^<>]*>/gi, (tag) => {
    if (!has.test(tag)) return tag;
    const bare = tag.replace(/\shidden(?:="[^"]*")?(?=[\s>/])/g, '');
    return hidden ? bare.replace(/\s*(\/?)>$/, ' hidden$1>') : bare;
  });
}

/** An Offer object's JSON with a new price, and priceValidUntil (after priceCurrency) only when `validUntil`. */
function syncOffer(json, price, validUntil) {
  const o = JSON.parse(json);
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'priceValidUntil') continue;
    out[k] = k === 'price' ? String(price) : v;
    if (k === 'priceCurrency' && validUntil) out.priceValidUntil = validUntil;
  }
  return JSON.stringify(out);
}

/** Today's prices written into one page's HTML (pure). `info` is pricingInfo(config, now). */
export function syncHtml(html, info, config = CONFIG) {
  const prices = { lifetime: info.lifetime, lifetimeRegular: info.lifetimeRegular, pass: info.pass };
  let out = html.replace(/(<([a-z][a-z0-9]*)\b[^<>]*\sdata-cfg-price="(\w+)"[^<>]*>)([^<]*)(<\/\2>)/gi, (m, open, tag, key, text, close) => {
    const s = formatPrice(prices[key], info.currency);
    return s ? `${open}${s}${close}` : m;
  });
  out = setHidden(out, 'data-cfg-launch', !info.launch);
  out = setHidden(out, 'data-cfg-after-launch', info.launch);
  out = out.replace(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g, (m, open, body, close) => open + body
    .replace(/\{[^{}]*"@type":"Offer"[^{}]*"name":"Lifetime"[^{}]*\}/g, (o) => syncOffer(o, info.lifetime, info.launch ? config.pricing?.launchEnds : null))
    .replace(/\{[^{}]*"@type":"Offer"[^{}]*"name":"7-Day Pass"[^{}]*\}/g, (o) => syncOffer(o, info.pass, null)) + close);
  return out;
}

/** Sync every page. Returns the files (relative to the repo) that changed, or would change with `write: false`. */
export function syncPrices({ now = Date.now(), write = true, config = CONFIG, dir = SITE } = {}) {
  const info = pricingInfo(config, now);
  const changed = [];
  for (const file of htmlFiles(dir)) {
    const html = readFileSync(file, 'utf8');
    const next = syncHtml(html, info, config);
    if (next === html) continue;
    changed.push(relative(ROOT, file));
    if (write) writeFileSync(file, next);
  }
  return { changed, info };
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const di = args.indexOf('--date');
  let now = Date.now();
  if (di >= 0) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args[di + 1] || '');
    if (!m) { console.error('--date needs a date like 2027-02-01'); process.exit(2); }
    now = new Date(+m[1], +m[2] - 1, +m[3], 12).getTime();
  }
  const { changed, info } = syncPrices({ now, write: !check });
  const lifetime = formatPrice(info.lifetime, info.currency);
  console.log(`Lifetime ${lifetime}${info.launch ? ` (launch price until ${CONFIG.pricing.launchEnds})` : ''}, 7-Day Pass ${formatPrice(info.pass, info.currency)}.`);
  if (!changed.length) { console.log('The static HTML already shows these prices.'); return; }
  for (const f of changed) console.log(`  ${check ? 'would update' : 'updated'} ${f}`);
  if (check) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
