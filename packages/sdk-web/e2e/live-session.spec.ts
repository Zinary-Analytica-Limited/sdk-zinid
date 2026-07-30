import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * The real thing: the built SDK bundle driving an actual hosted verification
 * session over the network.
 *
 * Everything else in this suite talks to a double that encodes our *reading* of
 * the contract, so it can only catch drift between the SDK and that reading.
 * This spec is the only check that can catch a shared misunderstanding.
 *
 * It needs a live session URL in `VITE_SESSION_URL` (see .env, which is
 * gitignored) and skips entirely without one, so CI and other machines are
 * unaffected. The host is never hardcoded — it comes from the URL.
 *
 * Kept deliberately passive: it observes the handshake and never drives the
 * verification itself, so a session is not consumed.
 */

function readSessionUrl(): string | undefined {
  if (process.env.VITE_SESSION_URL) return process.env.VITE_SESSION_URL;
  try {
    const env = readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8');
    return /^VITE_SESSION_URL=(.+)$/m.exec(env)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

const SESSION_URL = readSessionUrl();
const VENDOR_ORIGIN = 'https://vendor.test';

const BUNDLE = readFileSync(
  fileURLToPath(new URL('../dist/zinid.min.js', import.meta.url)),
  'utf8',
);

const parentHtml = (url: string) => `<!doctype html>
<html><body style="margin:0">
<div id="host"></div>
<script>${BUNDLE}</script>
<script>
  window.__events = [];
  const record = (name) => (payload) => window.__events.push({ name, payload });
  window.__flow = ZinID.createFlow({
    url: ${JSON.stringify(url)},
    mode: 'embed',
    container: '#host',
    onReady: record('ready'),
    onStepChange: record('step_change'),
    onComplete: record('complete'),
    onCancel: record('cancel'),
    onError: record('error'),
  });
  window.__flow.mount();
</script>
</body></html>`;

test.describe('live hosted session', () => {
  test.skip(!SESSION_URL, 'Set VITE_SESSION_URL in packages/sdk-web/.env to run this.');
  test.setTimeout(60_000);

  test('completes the handshake with the real hosted page', async ({ page }) => {
    const url = SESSION_URL as string;
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    // Only the vendor page is synthesised; the hosted URL goes to the network.
    let sessionStatus: number | undefined;
    page.on('response', (response) => {
      if (sessionStatus === undefined && response.url().startsWith(url.split('?')[0] as string)) {
        sessionStatus = response.status();
      }
    });
    await page.route(`${VENDOR_ORIGIN}/**`, (route) =>
      route.fulfill({ contentType: 'text/html', body: parentHtml(url) }),
    );
    await page.goto(`${VENDOR_ORIGIN}/`);

    // An expired session serves an "expired link" screen and opens no channel,
    // so it would look exactly like a broken handshake. Distinguish the two:
    // this is a stale fixture, not a product failure.
    await expect.poll(() => sessionStatus !== undefined, { timeout: 20_000 }).toBe(true);
    test.skip(
      sessionStatus !== 200,
      `The session URL returned ${sessionStatus} (410 means expired). ` +
        'Put a fresh one in VITE_SESSION_URL.',
    );

    // 1. The SDK appended the params the hosted page needs to talk back at all.
    const src = await page.locator('#host iframe').getAttribute('src');
    const params = new URL(src as string).searchParams;
    expect(params.get('parent_origin')).toBe(VENDOR_ORIGIN);
    expect(params.get('mode')).toBe('embed');
    expect(new URL(src as string).origin).toBe(new URL(url).origin);

    // 2. The hosted document actually loaded (not blocked by frame-ancestors).
    await expect
      .poll(() => page.frames().some((frame) => frame.url().startsWith(new URL(url).origin)), {
        timeout: 20_000,
        message: 'The hosted page never loaded in the iframe.',
      })
      .toBe(true);

    // 3. The real page's zinid:ready reached the vendor's handler.
    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            (window as never as { __events: { name: string }[] }).__events.map((e) => e.name),
          ),
        { timeout: 30_000, message: `No ready received. Console: ${consoleErrors.join(' | ')}` },
      )
      .toContain('ready');

    // 4. Ready is surfaced once despite the page's re-ping, and no error fired.
    await page.waitForTimeout(4000);
    const events = await page.evaluate(
      () => (window as never as { __events: { name: string; payload: unknown }[] }).__events,
    );
    const readyCount = events.filter((event) => event.name === 'ready').length;
    expect(readyCount, `saw ${readyCount} ready events: ${JSON.stringify(events)}`).toBe(1);
    expect(events.filter((event) => event.name === 'error')).toEqual([]);

    // 5. The frame holds a stable, non-collapsed height. The SDK no longer
    //    resizes per message, so this is whatever the fixed box resolved to.
    const height = await page
      .locator('#host iframe')
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    const settled = await page
      .locator('#host iframe')
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(settled).toBe(height);
  });
});
