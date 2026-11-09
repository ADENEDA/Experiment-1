// Site-wide script for the marketing pages (CONTRACTS.md §13). Loaded by the shared chrome on every page:
//   <script type="module" src="{R}js/site/site.js"></script>
// Pages are complete without it: static HTML carries the default config values. This script only refreshes them from
// config.js, wires up the mobile menu and marks the current nav link.
//
// Hooks (all optional; put them on any element of any marketing page):
//   [data-cfg="supportEmail"]      text = CONFIG.supportEmail; on <a> also href = mailto:…
//   [data-cfg="siteName|printDomain|siteUrl"]   text from CONFIG
//   [data-cfg="launchEnds"]        launch-price end date, e.g. "Jan 31, 2027"
//   [data-cfg-price="lifetime"]    current Lifetime price ("$29" during the launch, "$39" after it), from pricingInfo()
//   [data-cfg-price="lifetimeRegular|pass"]      regular Lifetime price / 7-Day Pass price
//   [data-cfg-launch]              shown only while the launch price applies (hidden after pricing.launchEnds)
//   [data-cfg-after-launch]        the opposite: shown only once the launch price has ended (ship it with `hidden`)
//   [data-cfg-link="lifetime|pass"]  href = checkout URL (Gumroad or Polar, + ?affiliate_id from the page URL). If the
//                                  owner has not set the URL yet, the link is marked aria-disabled and explains why.
//                                  Gumroad's overlay script is loaded once such a link is near the viewport.
//   [data-buy-buttons] / [data-buy-buttons="compact"]   replaced by js/ui/buy-buttons.js renderBuyButtons(); put the
//                                  static fallback (plain links with data-cfg-link) inside it.
import { CONFIG } from '../../config.js';
import { checkoutLinks, ensureGumroadScript, formatPrice, pricingInfo, renderBuyButtons } from '../ui/buy-buttons.js';

const NOT_SET_UP = 'Checkout is not set up yet (add the product links to config.js)';

function fillConfig(root = document) {
  const price = pricingInfo(CONFIG, Date.now());
  const values = {
    supportEmail: CONFIG.supportEmail,
    siteName: CONFIG.siteName,
    printDomain: CONFIG.printDomain,
    siteUrl: CONFIG.siteUrl,
    launchEnds: price.launchEndsLabel,
  };
  for (const el of root.querySelectorAll('[data-cfg]')) {
    const key = el.getAttribute('data-cfg');
    const v = values[key];
    if (!v) continue;
    el.textContent = v;
    if (key === 'supportEmail' && el instanceof HTMLAnchorElement) el.href = `mailto:${v}`;
  }

  const prices = { lifetime: price.lifetime, lifetimeRegular: price.lifetimeRegular, pass: price.pass };
  for (const el of root.querySelectorAll('[data-cfg-price]')) {
    const v = prices[el.getAttribute('data-cfg-price')];
    const s = formatPrice(v, price.currency);
    if (s) el.textContent = s;
  }
  for (const el of root.querySelectorAll('[data-cfg-launch]')) el.hidden = !price.launch;
  for (const el of root.querySelectorAll('[data-cfg-after-launch]')) el.hidden = price.launch;

  const links = checkoutLinks(CONFIG);
  const live = [];
  for (const a of root.querySelectorAll('a[data-cfg-link]')) {
    const plan = a.getAttribute('data-cfg-link');
    const link = links[plan];
    if (!link) continue;
    if (link.configured) {
      a.href = link.url;
      a.removeAttribute('aria-disabled');
      if (a.title === NOT_SET_UP) a.removeAttribute('title');
      live.push(a);
    } else {
      a.setAttribute('aria-disabled', 'true');
      a.title = NOT_SET_UP;
      if (!a.dataset.cfgGuard) {
        a.dataset.cfgGuard = '1';
        a.addEventListener('click', (ev) => { if (a.getAttribute('aria-disabled') === 'true') ev.preventDefault(); });
      }
    }
  }
  if (links.provider === 'gumroad' && live.length) loadOverlayWhenNear(live);
}

/** Load Gumroad's overlay script once a checkout link is close to the viewport, hovered or focused. */
function loadOverlayWhenNear(anchors) {
  let done = false;
  const go = () => { if (!done) { done = true; ensureGumroadScript(); } };
  for (const a of anchors) {
    a.addEventListener('pointerenter', go, { once: true });
    a.addEventListener('focus', go, { once: true });
  }
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); go(); }
    }, { rootMargin: '400px 0px' });
    for (const a of anchors) io.observe(a);
  }
}

function mountBuyButtons() {
  for (const el of document.querySelectorAll('[data-buy-buttons]')) {
    try {
      renderBuyButtons(el, { compact: el.getAttribute('data-buy-buttons') === 'compact' });
      el.classList.add('is-enhanced');
    } catch (e) {
      console.warn('Buy buttons could not be rendered; keeping the plain links.', e);
    }
  }
}

function normPath(p) {
  return p.replace(/index\.html?$/, '').replace(/\/+$/, '/') || '/';
}

function markCurrentNav() {
  const here = normPath(location.pathname);
  for (const a of document.querySelectorAll('.site-nav a[href]')) {
    let path;
    try { path = normPath(new URL(a.getAttribute('href'), document.baseURI).pathname); } catch { continue; }
    if (path === here && !a.classList.contains('btn')) a.setAttribute('aria-current', 'page');
    else if (a.getAttribute('aria-current') === 'page' && path !== here) a.removeAttribute('aria-current');
  }
}

function setupNav() {
  const toggle = document.querySelector('.site-header .nav-toggle');
  const nav = toggle && document.getElementById(toggle.getAttribute('aria-controls') || 'site-nav');
  if (!toggle || !nav) return;
  const header = toggle.closest('.site-header');
  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
  const setOpen = (open, { focusToggle = false } = {}) => {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
    nav.classList.toggle('is-open', open);
    if (!open && focusToggle) toggle.focus();
  };
  toggle.addEventListener('click', () => setOpen(!isOpen()));
  nav.addEventListener('click', (ev) => { if (ev.target instanceof Element && ev.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && isOpen()) { ev.preventDefault(); setOpen(false, { focusToggle: true }); }
  });
  document.addEventListener('click', (ev) => {
    if (isOpen() && header && ev.target instanceof Node && !header.contains(ev.target)) setOpen(false);
  });
  // Close when focus moves out of the header (keyboard users tabbing past the last link).
  header?.addEventListener('focusout', (ev) => {
    if (isOpen() && ev.relatedTarget instanceof Node && !header.contains(ev.relatedTarget)) setOpen(false);
  });
  const wide = matchMedia('(min-width: 720px)');
  const onWide = () => { if (wide.matches && isOpen()) setOpen(false); };
  if (wide.addEventListener) wide.addEventListener('change', onWide);
}

function init() {
  mountBuyButtons();
  try { fillConfig(); } catch (e) { console.warn('Config fill-in failed', e); }
  markCurrentNav();
  setupNav();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();

export { fillConfig };
