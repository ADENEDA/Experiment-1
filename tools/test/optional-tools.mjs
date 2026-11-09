// Optional tools for the tests: Playwright with its Chromium (browser suites) and poppler-utils (PDF checks).
// By default a missing tool skips the checks that need it, so `npm test` runs on a bare machine, and every such
// check is reported as a SKIP with the reason. GBS_REQUIRE_TOOLS=1 turns each of those skips into a failure, for a
// CI job that must run the browser and PDF checks rather than pass without them.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

export const REQUIRE_TOOLS = /^(1|true|yes)$/i.test(process.env.GBS_REQUIRE_TOOLS ?? '');

/** A skip reason (false = run), or with GBS_REQUIRE_TOOLS=1 an error instead of a skip. */
export function optional(reason) {
  if (reason && REQUIRE_TOOLS) throw new Error(`${reason}, and GBS_REQUIRE_TOOLS=1 says these checks must run`);
  return reason || false;
}

/** True when the command exists (poppler tools print their version for -v, some with a non-zero status). */
export function hasTool(cmd) {
  try { execFileSync(cmd, ['-v'], { stdio: 'ignore' }); return true; } catch (e) { return e.code !== 'ENOENT'; }
}

/** false when every poppler tool named is installed, else the skip reason (an error with GBS_REQUIRE_TOOLS=1). */
export function popplerSkip(...tools) {
  const missing = tools.filter((t) => !hasTool(t));
  return optional(missing.length ? `poppler-utils not installed (${missing.join(', ')} missing)` : false);
}

/** Playwright's chromium, or null when Playwright is not installed (an error with GBS_REQUIRE_TOOLS=1). */
export function loadChromium(fromUrl) {
  try { return createRequire(fromUrl)('playwright').chromium; } catch { optional('playwright not installed'); return null; }
}
