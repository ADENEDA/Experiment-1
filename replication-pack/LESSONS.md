# What we learned building Gridbook Studio

A retrospective of the first run (2026-11-09), so the next run ships faster and cheaper.

## What the run looked like

| Phase | What happened | Wall clock |
|---|---|---|
| Research + spec | Market research, picked the product, wrote docs/SPEC.md | ~1 h |
| Phase 1 build | 4 puzzle engines, layout, KDP preflight, PDF rendering, licensing | ~3 h |
| Phase 2 build | Studio app (5 agents) + 9 marketing/SEO pages, legal, assets, owner docs (5 agents) | ~3.6 h, 10 agents, ~4.5M subagent tokens |
| Phase 3 QA | 7 finders, 12 fixers, regression run, diff review, final fix | ~4.8 h, 20 agents, ~7.1M subagent tokens |
| **Total** | 1,700 files, 696 tests, launch-ready except owner-only steps | **~13 h** |

Expected revenue from LAUNCH.md: about $31 in month 1 (conservative), about $210 (base, with daily posting).
**The build was far bigger than the revenue case needed.**

## The biggest lessons

1. **Scope was the main cost.** Four puzzle engines, a full editor app, two calculators, three generator pages and a
   comparison page. One puzzle type and one page could have taken money in a fraction of the time. Most of the ~100 QA
   findings came from breadth, not from the core idea.
2. **Code was never the bottleneck to revenue.** What blocks the first sale is the payment account (needs an adult
   18+ holder), a domain, deploying, legal blanks and, above all, distribution. Agents can't do those. Plan the human
   steps from minute one and keep them under an hour.
3. **Pick a product that comes with buyers.** A new website starts with zero visitors. Marketplaces with built-in search
   (Etsy, Gumroad Discover, the Chrome Web Store, KDP itself, Notion/Canva template galleries) get you visitors for
   free. Our plan depended on SEO and social posts, which are slow.
4. **Only ~2 agents run at once on a 4-core machine.** The workflow cap is min(16, CPUs − 2). Long chains of agents
   are slow. Fewer, bigger agents with clear file ownership worked better than many small ones.
5. **Contracts first made parallel building work.** Writing CONTRACTS.md (module APIs) and a shared page-chrome file
   before building let agents work in parallel without breaking each other. Give each agent a list of files it owns.
6. **Adversarial QA paid off.** A separate agent that has to reproduce a bug before fixing it found real high-severity
   problems (unreadable answer keys, false claims, a broken offline export, buy links to a stranger's Gumroad). Keep
   one QA pass, but size it to the product.

## Traps to pre-empt (each one cost a fix cycle)

**Honesty**
- Unenforced scarcity ("first 100 buyers") with nothing counting buyers. Use date-based or no scarcity.
- Claims the code doesn't back ("works with Wi-Fi off"). Every claim needs a matching feature or test.
- Competitor prices that weren't checked, or differed between pages. Keep one dated, sourced set, or none.
- Placeholder checkout links like `YOURNAME.gumroad.com` point at a real stranger's store. Use same-site `/buy/...`
  links that redirect until configured.
- Don't promise platform approval (KDP, Etsy, etc.); promise meeting the published file requirements.

**Engineering**
- Browser tests on fixed ports collide when two agents run tests. Default to a free port (port 0) with env overrides.
- Timing assertions ("under 50 ms") flake under parallel load. Make them load-tolerant.
- Unfingerprinted JS/CSS cached for an hour mixes module versions after a deploy. Use
  `Cache-Control: public, max-age=0, must-revalidate` for HTML/JS/CSS on a no-build site.
- Lazily imported code fails offline, and Chromium caches the failed import until reload. Preload what export needs.
- Printed output must be looked at: rasterize PDFs with `pdftoppm` and Read the images. Tests alone missed
  answer keys with no letters and colliding clue numbers.
- Date-dependent prices: keep prices in one config and a `sync-prices` script, or the static pages go stale.

**Process**
- The stop hook wants a clean, pushed tree at the end of each turn. Background agents leave files mid-run, which forced
  a "WIP snapshot" commit. Either accept WIP commits or tell agents to write scratch files only outside the repo.
- External facts (Gumroad API response shapes, affiliate link format, fees) could only partly be verified; some
  sites block bots. Label unverified facts in the docs instead of guessing.
- Generated artifacts (sample PDFs, OG images) go stale when code changes. Commit a generator script and a staleness
  test for each.
- Workflows (multi-agent runs) only start when the prompt says "ultracode" or explicitly asks for a workflow.

## What to keep

- Static site, no build step, no server, client-side license keys (Gumroad or Lemon Squeezy), free hosting on
  Cloudflare Pages. Running cost ≈ a domain.
- Free tier with a visible watermark or limit → one-time paid unlock. Simple and honest.
- SETUP.md for the owner (every step, every click) and a short launch plan with honest estimates.
- Phases: research → pick → spec + contracts → build → adversarial QA → owner docs → push.
