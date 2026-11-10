# Experiment 3 prompt (Chrome extension)

Paste everything below the line into a new Claude Code session.

---

## Repository
Work in the GitHub repo **ADENEDA/Experiment-3** (already created, may be empty). Call add_repo for owner "ADENEDA", repo "Experiment-3" with push access, clone it and work there. Push to a feature branch. No pull request.

The retrospective from the first run is in the public repo ADENEDA/Experiment-1, file replication-pack/LESSONS.md on branch ccr-1b447325-am4aj3. Read it first (add_repo with read access, or fetch https://raw.githubusercontent.com/ADENEDA/Experiment-1/ccr-1b447325-am4aj3/replication-pack/LESSONS.md).

Build me something I can sell **this week**, with almost no start-up cost, and get it ready to launch. Use your own
judgment and all the tools you have. It doesn't have to be a web app: a digital product, template pack, browser
extension, printable, tool or small SaaS are all fine, as long as it meets the criteria below.

## About me (owner)
- Payment account: I (the owner) will hold the payment accounts myself (Gumroad, Etsy, Lemon Squeezy, Chrome Web Store, etc.). This is settled: do NOT ask me about it.
- Budget: about $15 up front (a domain), $0 a month.
- Time I can give: about 1 hour for setup, then about 30 minutes a day for promotion.
- Platforms I already have: none yet; I can create any of them. One account can sell several products.
- I'm asleep while you work: don't stop to ask questions. Make sensible decisions, note them in the README, and keep going.

## How to pick the product
Research first (web search), then shortlist 3–5 ideas and score them on:
1. **Built-in buyers.** It sells on a marketplace that already has search traffic (Etsy, Gumroad Discover, Chrome Web
   Store, Amazon KDP, Notion/Canva/Framer template galleries) or answers a search people already make. A brand-new site
   with zero visitors is the weakest option.
2. **Time to first sale.** You can build a sellable version in one session, and my setup takes under an hour.
3. **Cost.** No servers, no paid APIs, no paid tools. Free hosting (Cloudflare Pages or GitHub Pages) at most.
4. **Proof of demand.** Real competitors selling at a real price, with evidence (reviews, sales counts, rankings).
5. **Honest and allowed.** No platform rule breaking, no trademark or copyright risk, no spammy mass-publishing.
Pick the winner, tell me why in a few lines, and start building without waiting for me unless a choice is truly mine.

## Scope rules (the last run built far too much)
- Build the **smallest thing someone would pay for**, then stop. One product, one landing or listing page.
- Time box: aim to be launch-ready in about 4 hours of work. Ask yourself at each phase: does this get the first sale
  sooner? If not, list it under "later" in the docs instead of building it.
- Cap multi-agent runs at about 6 agents each. This machine runs only ~2 agents at a time.

## How to build
- Static, no build step, no runtime dependencies unless essential; vendor anything you do use, with exact versions.
- Write a short CONTRACTS.md (module interfaces, file ownership) before building in parallel. Each agent owns a list of
  files and edits nothing else.
- Payments: one-time purchase via Gumroad or Lemon Squeezy (license keys if software, file delivery if a digital good).
  Free version or free sample with a clear limit or watermark, then a paid unlock. No subscriptions to run.
- Keep every owner setting (prices, product IDs, links, domain, email) in one config file.
- Tests with `npm test` (Node built-in test runner). Browser tests pick a free port by default; timing checks must not
  flake under load. Generated files (samples, preview images) get a generator script and a staleness test.
- If the product is a printable or PDF: rasterize it with `pdftoppm` and look at the pages yourself before shipping.
- For a static site use `Cache-Control: public, max-age=0, must-revalidate` for HTML/JS/CSS (no fingerprinting).

## Honesty rules (each one cost a fix cycle last time)
- Every claim on a page must match what the product actually does. No "works offline" unless it does.
- No fake scarcity ("first 100 buyers") unless something enforces it; prefer a dated launch price or none.
- No fake testimonials, user counts or ratings. Competitor facts must be dated and sourced, or left out.
- Placeholder checkout links must not point at a real third-party store (no `YOURNAME.gumroad.com`); use a same-site
  link that goes to the pricing page until configured.
- Never promise platform approval or income; promise meeting the published requirements.
- Label any external fact you could not verify (API formats, fees, policies) as unverified.

## Quality pass
After building, run one adversarial QA round: finders (read-only) for (1) does the core deliverable actually work and
meet the platform's specs, (2) copy honesty and consistency, (3) security of anything that handles user input or
license keys, (4) mobile + accessibility basics. A different agent must reproduce each finding before fixing it. Then
run the full test suite and a final check of everything changed.

## Deliverables
1. The product, working, with tests passing.
2. The listing or landing page copy, ready to paste (title, description, tags, images or image specs if a marketplace).
3. `SETUP.md`: every step I must do myself, in order, with exact clicks, under 1 hour: payment account, product
   listings, config values, domain, deploy, legal blanks, a final end-to-end test purchase.
4. `LAUNCH.md`: a 7-day plan, where to post and the rules there, ready-to-paste posts, and honest revenue estimates
   (conservative and base case, with the maths).
5. A short README.
6. Commit with clear messages and push to the branch I'm given. No pull request unless I ask.

## Things that blocked the last run (handle them up front)
- The session's stop hook requires all work committed and pushed at the end of each turn: keep scratch files outside
  the repo, and commit at each phase boundary.
- Some sites (competitors, payment platforms) block automated fetching; say so rather than guess.
- Only ~2 agents run at once here, so prefer fewer, larger, well-briefed agents.

At the end, give me: what you built, the exact steps left for me, the realistic money expectation, and the risks.

## Direction for this experiment: Chrome extension
A small single-purpose Chrome extension sold on the Chrome Web Store, with a free tier and a one-time paid unlock through Gumroad license keys (or another no-server option you verify). Deliver the packaged extension zip, store listing copy, screenshots and the privacy disclosure the store requires.

## Validation and compute rules
- Only build an idea that passes this bar: at least 3 competitors visibly selling it (review counts, user counts or sales ranks you can cite), a price of $5 or more, and a gap you can fill in one session.
- Spend at most 45 minutes on research. If nothing passes the bar, stop and write the shortlist with evidence to the README, commit and push, instead of building.
- It must be instantly deployable: either a file I upload to a marketplace, or a static site on GitHub Pages or Cloudflare Pages. No backend, no paid services.
- Work alone. Use one workflow of at most 4 agents, only for the final QA pass. (This overrides the "about 6 agents" cap above.)
- Other experiments are running in parallel: Experiment 2 is a spreadsheet budget workbook (Holly Ledger); Experiment 3 is a Chrome extension; Experiment 4 is Etsy printables; Experiment 5 is a niche browser tool. Stay in your own lane and don't overlap.

