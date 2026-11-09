// config.js — OWNER SETTINGS. This is the only file you need to edit to start selling.
// Nothing in here is secret: product IDs and checkout links are public by design.
// See SETUP.md for a step-by-step guide.
export const CONFIG = {
  siteName: 'Gridbook Studio',
  siteUrl: 'https://gridbookstudio.com', // your domain (no trailing slash); used in footers and share links
  printDomain: 'gridbookstudio.com',     // the short domain printed in free-edition footers
  supportEmail: 'hello@gridbookstudio.com',

  // Which payment platform validates license keys: 'gumroad' | 'polar'
  provider: 'gumroad',

  gumroad: {
    // Gumroad > Products > (product) > Content > Insert > License key. The block shows the product_id.
    lifetime: { productId: 'PASTE_LIFETIME_PRODUCT_ID', url: 'https://YOURNAME.gumroad.com/l/gridbook-lifetime' },
    pass: { productId: 'PASTE_PASS_PRODUCT_ID', url: 'https://YOURNAME.gumroad.com/l/gridbook-sprint', days: 7 },
    test: { productId: '' }, // optional hidden $0 product, only used when the URL has ?licensetest=1
    maxActivations: 5,       // soft limit on devices per key (uses Gumroad's "uses" counter)
  },

  polar: {
    organizationId: '',      // UUID of your Polar organization
    lifetimeBenefitId: '',
    passBenefitId: '',
    lifetimeCheckoutUrl: '',
    passCheckoutUrl: '',
  },

  // Optional offline unlock codes you can hand to reviewers. Run `node tools/keygen.mjs` and paste the public key here.
  offlineCodes: { publicKey: '' },

  pricing: { lifetime: 29, lifetimeRegular: 39, pass: 9, launchEnds: '2027-01-31', currency: 'USD' },
  license: { revalidateDays: 7, offlineGraceDays: 30, timeoutMs: 8000 },
  free: { printableMaxPuzzles: 10 },
};
