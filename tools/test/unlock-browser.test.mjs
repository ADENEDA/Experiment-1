// The paying customer's path in the real Studio (js/ui/unlock-dialog.js + license/*): the topbar badge opens the
// unlock dialog; a wrong key is refused with a helpful message; a key pasted from an e-mail (spaces, line breaks)
// activates Lifetime, the proof watermark goes away and the badge turns Pro; Deactivate takes two clicks and brings
// the free edition back; and a purchase refunded later is found by the background re-check after revalidateDays.
// Gumroad's API is answered by a Playwright route (nothing leaves the machine); config.js gets test product IDs.
// Serves site/ in-process on a free loopback port (or UNLOCK_TEST_PORT). Skipped when Playwright or Chromium is missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { optional, loadChromium } from './optional-tools.mjs';
import { fileURLToPath } from 'node:url';
import { startServer } from '../serve.mjs';

const SITE = fileURLToPath(new URL('../../site/', import.meta.url));
const PORT = Number(process.env.UNLOCK_TEST_PORT) || 0;
const KEY = 'AAAA1111-BBBB2222-CCCC3333-DDDD4444';
const DAY = 86_400_000;

const chromium = loadChromium(import.meta.url);
let skip = chromium ? false : 'playwright not installed';
let server, browser, BASE;

before(async () => {
  if (skip) return;
  try { browser = await chromium.launch(); } catch (e) { skip = optional(`chromium unavailable: ${e.message.split('\n')[0]}`); return; }
  let origin;
  ({ server, origin } = await startServer(SITE, { port: PORT }));
  BASE = `${origin}/app/`;
});

after(async () => {
  await browser?.close();
  server?.close();
});

/** A fake api.gumroad.com that knows one Lifetime key; `refunded` flips what it says about that purchase. */
function fakeGumroad() {
  const g = { calls: [], refunded: false };
  g.handle = async (route) => {
    const form = Object.fromEntries(new URLSearchParams(route.request().postData() || ''));
    g.calls.push(form);
    const ok = form.product_id === 'LIFE_ID' && form.license_key === KEY;
    await route.fulfill({
      status: ok ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(ok
        ? { success: true, uses: 1, purchase: { product_id: 'LIFE_ID', email: 'buyer@example.org', sale_timestamp: '2026-11-08T10:00:00Z',
          refunded: g.refunded, disputed: false, dispute_won: false, chargebacked: false, license_key: KEY } }
        : { success: false, message: 'That license does not exist for the provided product.' }),
    });
  };
  return g;
}

const settledBook = (page) => page.waitForFunction(() => {
  const a = window.gbsApp; const b = a && a.getBook();
  return !!(b && b.preflight && !b.generating.active && b.project === a.store.get());
}, null, { timeout: 30000 });
const watermarked = (page) => page.evaluate(() => window.gbsApp.getBook().meta.watermarked);
const statusText = (page) => page.$eval('.gbs-unlock .unlock-status', (e) => e.textContent.replace(/\s+/g, ' ').trim());
const idleStatus = (page) => page.waitForFunction(() => {
  const s = document.querySelector('.gbs-unlock .unlock-status');
  return s && s.dataset.tone !== 'busy' && !/Checking/.test(s.textContent);
}, null, { timeout: 15000 });

test('unlock: wrong key, a pasted key with line breaks unlocks Pro, Deactivate, and a later refund is caught on re-check', { timeout: 90000 }, async (t) => {
  if (skip) return t.skip(skip);
  const gum = fakeGumroad();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/config.js', async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace('PASTE_LIFETIME_PRODUCT_ID', 'LIFE_ID').replace('PASTE_PASS_PRODUCT_ID', 'PASS_ID');
    await route.fulfill({ response: res, body });
  });
  await ctx.route('https://gumroad.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '/* overlay stub */' }));
  await ctx.route('https://api.gumroad.com/**', gum.handle);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.stack || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  try {
    await page.goto(`${BASE}?type=sudoku&count=2`);
    await settledBook(page);
    assert.equal(await watermarked(page), true, 'free edition: proof marks');
    assert.equal(await page.$eval('.tb-badge', (b) => b.classList.contains('badge-pro')), false);

    // The badge opens the dialog, focus in the key field.
    await page.click('.tb-badge');
    await page.waitForSelector('.gbs-unlock[open] .unlock-key');
    await page.waitForFunction(() => document.activeElement?.classList.contains('unlock-key'));
    assert.match(await page.textContent('.gbs-unlock h2'), /Unlock Gridbook Studio Pro/);

    // Empty, then a wrong key.
    await page.click('.gbs-unlock .unlock-activate');
    assert.match(await statusText(page), /Paste your license key first/);
    await page.fill('.gbs-unlock .unlock-key', 'WRONG-KEY');
    await page.keyboard.press('Enter');
    await idleStatus(page);
    assert.match(await statusText(page), /That key isn't valid for Gridbook Studio\. Check for typos\./);
    assert.equal(await page.getAttribute('.gbs-unlock .unlock-key', 'aria-invalid'), 'true');
    assert.equal(await watermarked(page), true);
    assert.ok(gum.calls.length >= 1 && gum.calls.every((c) => c.license_key === 'WRONG-KEY'));

    // The right key as it comes out of an e-mail: leading space, a line break, trailing space.
    gum.calls.length = 0;
    await page.fill('.gbs-unlock .unlock-key', ` ${KEY.slice(0, 18)}\n${KEY.slice(18)} `);
    await page.click('.gbs-unlock .unlock-activate');
    await idleStatus(page);
    assert.match(await statusText(page), /Activated! Pro Lifetime is unlocked on this device/);
    const used = gum.calls.find((c) => c.product_id === 'LIFE_ID');
    assert.deepEqual(used, { product_id: 'LIFE_ID', license_key: KEY, increment_uses_count: 'true' }, 'whitespace stripped, one use counted');
    assert.match(await page.textContent('.gbs-unlock .unlock-current'), /Key \S*4444/, 'only the end of the key is shown');
    assert.doesNotMatch(await page.textContent('.gbs-unlock .unlock-current'), /AAAA1111/);
    assert.equal(await page.inputValue('.gbs-unlock .unlock-key'), '', 'the field is cleared');
    await page.waitForFunction(() => !window.gbsApp.getBook().meta.watermarked, null, { timeout: 20000 });
    assert.equal(await page.$eval('.tb-badge', (b) => b.classList.contains('badge-pro')), true);
    assert.equal(await page.isHidden('.gbs-unlock .unlock-plans'), true, 'no buy buttons for a Lifetime owner');

    // Deactivate: the first click only asks.
    await page.click('.gbs-unlock .unlock-deactivate');
    assert.equal((await page.textContent('.gbs-unlock .unlock-deactivate')).trim(), 'Click again to confirm');
    assert.equal(await page.$eval('.tb-badge', (b) => b.classList.contains('badge-pro')), true, 'still Pro after one click');
    await page.click('.gbs-unlock .unlock-deactivate');
    assert.match(await statusText(page), /The key was removed from this browser/);
    await page.waitForFunction(() => window.gbsApp.getBook().meta.watermarked, null, { timeout: 20000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('gbs.license')), null);

    // Activate again and close; then Gumroad refunds the purchase.
    await page.fill('.gbs-unlock .unlock-key', KEY);
    await page.click('.gbs-unlock .unlock-activate');
    await idleStatus(page);
    await page.waitForFunction(() => !window.gbsApp.getBook().meta.watermarked, null, { timeout: 20000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.gbs-unlock'));
    gum.refunded = true;
    gum.calls.length = 0;

    // Within revalidateDays a reload trusts the cached license (no network at all).
    await page.reload();
    await settledBook(page);
    assert.equal(await watermarked(page), false);
    assert.equal(gum.calls.length, 0, 'no re-check before revalidateDays');

    // Eight days later the background re-check finds the refund.
    await page.clock.setSystemTime(new Date(Date.now() + 8 * DAY));
    await page.reload();
    await page.waitForFunction(() => window.gbsApp?.getBook()?.meta.watermarked === true, null, { timeout: 30000 });
    assert.deepEqual(gum.calls.map((c) => [c.product_id, c.increment_uses_count]), [['LIFE_ID', 'false']], 'a re-check never counts a use');
    assert.equal(await page.$eval('.tb-badge', (b) => b.classList.contains('badge-pro')), false);
    await page.click('.tb-badge');
    await page.waitForSelector('.gbs-unlock[open]');
    assert.match(await statusText(page), /Refunded.*This key was refunded, so it no longer unlocks Pro/);
    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
  }
});
