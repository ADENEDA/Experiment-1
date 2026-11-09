// Buy buttons and plan cards, rendered from CONFIG (SPEC §2 prices, §3 checkout, §4.8).
//
// Gumroad: links get class "gumroad-button" and point at the product's /l/ URL. The overlay script
// (https://gumroad.com/js/gumroad.js, loaded once, lazily) enhances every gumroad.com/l/ link on the page, including
// ones added later (it uses a MutationObserver), and opens checkout in an in-page overlay. If the script is blocked,
// the plain link opens Gumroad's hosted checkout in a new tab. Polar: plain checkout links.
//
// Every button click dispatches a bubbling `gbs:checkout` CustomEvent ({ plan, provider, overlay }) so a host
// (e.g. the modal Unlock dialog) can step aside for Gumroad's overlay, which lives on <body>.
import { CONFIG } from '../../config.js';

export const GUMROAD_SCRIPT_URL = 'https://gumroad.com/js/gumroad.js';
const CSS_HREF = new URL('../../css/license.css', import.meta.url).href;
const SVG_NS = 'http://www.w3.org/2000/svg';

let cssPromise = null;
let gumroadRequested = false;
let uid = 0; // unique ids when plans are rendered more than once on a page

/** Inject css/license.css once. Resolves when it has loaded (or after a short timeout, so UI never waits long). */
export function ensureLicenseCss() {
  if (cssPromise) return cssPromise;
  if (typeof document === 'undefined') return (cssPromise = Promise.resolve());
  const existing = document.querySelector('link[data-gbs-license-css]');
  if (existing) return (cssPromise = Promise.resolve());
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_HREF;
  link.dataset.gbsLicenseCss = '';
  cssPromise = new Promise((resolve) => {
    const done = () => resolve();
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    setTimeout(done, 600);
  });
  document.head.appendChild(link);
  return cssPromise;
}

/** Load Gumroad's overlay script once. Safe to call repeatedly; never throws. */
export function ensureGumroadScript() {
  if (gumroadRequested || typeof document === 'undefined') return;
  gumroadRequested = true;
  if (document.querySelector("script[src*='/js/gumroad.js']")) return;
  const s = document.createElement('script');
  s.src = GUMROAD_SCRIPT_URL; // the script finds itself by this src, so keep the exact URL
  s.async = true;
  s.addEventListener('error', () => { /* blocked or offline: links fall back to opening checkout in a new tab */ });
  document.head.appendChild(s);
}

/** True once Gumroad's overlay has enhanced a link (it appends a <span class="logo-full">). */
export function isOverlayLink(a) {
  return !!(a && a.querySelector && a.querySelector('.logo-full'));
}

export function formatPrice(amount, currency = 'USD') {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: n % 1 ? 2 : 0,
      maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${n} ${currency}`;
  }
}

/** 'YYYY-MM-DD' -> the last millisecond of that day in the visitor's time zone (null if missing/invalid). */
function endOfLocalDay(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999).getTime();
}

/** Current prices: the launch price applies through the end of pricing.launchEnds. Pure; used by tests too. */
export function pricingInfo(config = CONFIG, nowMs = Date.now()) {
  const p = config.pricing || {};
  const currency = p.currency || 'USD';
  const regular = Number.isFinite(p.lifetimeRegular) ? p.lifetimeRegular : p.lifetime;
  const end = endOfLocalDay(p.launchEnds);
  const hasLaunch = Number.isFinite(p.lifetime) && Number.isFinite(regular) && regular > p.lifetime;
  const launch = hasLaunch && (end === null || nowMs <= end);
  return {
    currency,
    launch,
    lifetime: launch ? p.lifetime : regular,
    lifetimeRegular: regular,
    pass: p.pass,
    passDays: (config.gumroad && config.gumroad.pass && config.gumroad.pass.days) || 7,
    launchEnds: launch ? end : null,
    launchEndsLabel: launch && end !== null
      ? new Date(end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
  };
}

const isCheckoutUrl = (u) => typeof u === 'string' && /^https:\/\/\S+$/.test(u) && !/YOURNAME/i.test(u);

/** Affiliate id from the current page (?a= or ?affiliate_id=), passed through to Gumroad. Not stored anywhere. */
function affiliateId() {
  try {
    const q = new URLSearchParams(globalThis.location ? globalThis.location.search : '');
    const id = q.get('affiliate_id') || q.get('a');
    return id && /^[\w-]{1,64}$/.test(id) ? id : null;
  } catch { return null; }
}

/** Checkout targets for the configured provider. Pure apart from reading the page's affiliate parameter. */
export function checkoutLinks(config = CONFIG) {
  const provider = config.provider === 'polar' ? 'polar' : 'gumroad';
  const raw = provider === 'polar'
    ? { lifetime: config.polar && config.polar.lifetimeCheckoutUrl, pass: config.polar && config.polar.passCheckoutUrl }
    : { lifetime: config.gumroad && config.gumroad.lifetime && config.gumroad.lifetime.url,
        pass: config.gumroad && config.gumroad.pass && config.gumroad.pass.url };
  const aff = provider === 'gumroad' ? affiliateId() : null;
  const out = { provider };
  for (const plan of ['lifetime', 'pass']) {
    let url = isCheckoutUrl(raw[plan]) ? raw[plan] : null;
    if (url && aff) {
      try { const u = new URL(url); if (!u.searchParams.has('affiliate_id')) u.searchParams.set('affiliate_id', aff); url = u.href; } catch { /* keep */ }
    }
    out[plan] = { url, configured: !!url };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// DOM helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function checkIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'gbs-plan-check');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.75');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function buyButton(plan, label, link, provider, variant) {
  const cls = `gbs-buy-btn gbs-buy-btn--${variant}`;
  if (!link.configured) {
    return h('button', { type: 'button', class: cls, disabled: true, 'data-plan': plan,
      title: 'Checkout is not set up yet (add the product links to config.js)' }, label);
  }
  const a = h('a', {
    class: provider === 'gumroad' ? `gumroad-button ${cls}` : cls,
    href: link.url, target: '_blank', rel: 'noopener', 'data-plan': plan,
  }, h('span', { class: 'gbs-buy-label' }, label));
  a.addEventListener('click', () => {
    a.dispatchEvent(new CustomEvent('gbs:checkout', { bubbles: true,
      detail: { plan, provider, overlay: provider === 'gumroad' && isOverlayLink(a) } }));
  });
  return a;
}

/**
 * Render the two buy buttons into `container` (its content is replaced). compact: a single row with a one-line
 * price note; otherwise two plan cards with what each includes. Returns the root element.
 */
export function renderBuyButtons(container, { compact = false } = {}) {
  ensureLicenseCss();
  const price = pricingInfo(CONFIG, Date.now());
  const links = checkoutLinks(CONFIG);
  const f = (n) => formatPrice(n, price.currency);
  const lifetimeLabel = `Get Lifetime, ${f(price.lifetime)}`;
  const passName = `${price.passDays}-Day Pass`;
  const passLabel = `Get the ${passName}, ${f(price.pass)}`;
  const lifetimeBtn = buyButton('lifetime', lifetimeLabel, links.lifetime, links.provider, 'primary');
  const passBtn = buyButton('pass', passLabel, links.pass, links.provider, 'secondary');
  const launchNote = price.launch
    ? `Launch price${price.launchEndsLabel ? ` until ${price.launchEndsLabel}` : ''}, then ${f(price.lifetimeRegular)}.`
    : '';
  const anyConfigured = links.lifetime.configured || links.pass.configured;
  const setupNote = anyConfigured ? null
    : h('p', { class: 'gbs-buy-setup', text: 'Checkout is not set up yet: add the product links to config.js.' });
  const via = links.provider === 'polar' ? 'Polar' : 'Gumroad';

  let root;
  if (compact) {
    const bits = [];
    if (price.launch) bits.push(`Lifetime ${f(price.lifetime)} at launch (then ${f(price.lifetimeRegular)})${price.launchEndsLabel ? ` until ${price.launchEndsLabel}` : ''}`);
    bits.push('one-time, no subscription', '30-day refund');
    root = h('div', { class: 'gbs-buy gbs-buy--compact' },
      h('div', { class: 'gbs-buy-row' }, lifetimeBtn, passBtn),
      h('p', { class: 'gbs-buy-note', text: `${bits.join(' · ')}.` }),
      setupNote);
  } else {
    const list = (items) => h('ul', { class: 'gbs-plan-list' }, items.map((t) => h('li', {}, checkIcon(), h('span', { text: t }))));
    // No struck-through "was" price: Lifetime has never sold at its later price, so the launch note says what it
    // will cost instead.
    const priceLine = (amount, unit) => h('p', { class: 'gbs-plan-price' },
      h('span', { class: 'gbs-price', text: f(amount) }),
      h('span', { class: 'gbs-price-unit', text: unit }));
    const n = ++uid;
    const lifetime = h('article', { class: 'gbs-plan gbs-plan--lifetime', 'aria-labelledby': `gbs-plan-lifetime-${n}` },
      h('div', { class: 'gbs-plan-head' },
        h('h3', { class: 'gbs-plan-name', id: `gbs-plan-lifetime-${n}`, text: 'Lifetime' }),
        h('span', { class: 'badge badge-pro', text: 'Best value' })),
      priceLine(price.lifetime, 'once'),
      launchNote ? h('p', { class: 'gbs-plan-note', text: launchNote }) : null,
      list(['Clean interior PDFs for KDP: no proof header or footer',
        'Unlimited clean printables (US Letter and A4)',
        'PNG pages at 300 DPI and a ZIP bundle for KDP',
        'Commercial-use license: KDP, Etsy, Gumroad, newsletters',
        'Every future update included',
        'Priority email support']),
      lifetimeBtn);
    const pass = h('article', { class: 'gbs-plan gbs-plan--pass', 'aria-labelledby': `gbs-plan-pass-${n}` },
      h('div', { class: 'gbs-plan-head' }, h('h3', { class: 'gbs-plan-name', id: `gbs-plan-pass-${n}`, text: passName })),
      priceLine(price.pass, 'one-time'),
      h('p', { class: 'gbs-plan-note', text: `Pro for ${price.passDays} days from purchase. Nothing renews.` }),
      list(['Every Pro feature while the pass runs',
        'Clean exports and the commercial-use license',
        'Made for one seasonal book or a deadline']),
      passBtn);
    // Same order as every plan list on the site: Free (pricing page only), the pass, then Lifetime, the recommended
    // plan, last.
    root = h('div', { class: 'gbs-buy gbs-buy--plans' },
      h('div', { class: 'gbs-plans' }, pass, lifetime),
      setupNote,
      h('p', { class: 'gbs-buy-note', text: `Secure checkout by ${via}. Your key arrives by email right after purchase.` }));
  }
  if (container && typeof container.replaceChildren === 'function') container.replaceChildren(root);
  if (links.provider === 'gumroad' && anyConfigured) ensureGumroadScript();
  return root;
}
