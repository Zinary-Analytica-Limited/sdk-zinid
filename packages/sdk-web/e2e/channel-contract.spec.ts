import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Frame, Page } from '@playwright/test';

/**
 * End-to-end contract check against a hosted-page double.
 *
 * This exists because a unit test cannot catch a wire-format mismatch: if the
 * SDK and the test both use the wrong shape, the test passes while the real
 * channel is dead. Here the double mirrors the hosted page's actual behaviour —
 * the `{ type, payload, v }` envelope with no source tag, the ready re-ping, and
 * going inert without `parent_origin` — the parent runs the **built** IIFE
 * bundle, and the two sit on genuinely different origins.
 *
 * Verified to catch both known ways the channel dies silently: requiring a
 * source tag fails 9 of these 10 tests, and omitting `parent_origin` fails all
 * 10.
 */

const VENDOR_ORIGIN = 'https://vendor.test';
const HOSTED_ORIGIN = 'https://verify.zinid.test';
const SESSION_URL = `${HOSTED_ORIGIN}/s/abc123`;

const BUNDLE = readFileSync(
  fileURLToPath(new URL('../dist/zinid.min.js', import.meta.url)),
  'utf8',
);

/**
 * The hosted-page double. Message types are spelled out as literals on purpose:
 * they are the canonical wire contract, not a shared constant that could drift
 * with the SDK.
 */
const HOSTED_HTML = `<!doctype html>
<html><body style="margin:0">
<div id="content" style="height:900px">hosted flow</div>
<script>
  var params = new URLSearchParams(location.search);
  var parentOrigin = params.get('parent_origin');
  var autoCancel = params.get('autocancel') !== '0';
  window.__received = [];

  // Mirrors the real page: without parent_origin it builds an inert channel and
  // never posts anything. This is what makes a missing param a caught failure
  // rather than a silent one.
  function send(type, payload) {
    if (!parentOrigin) return;
    parent.postMessage({ type: type, payload: payload === undefined ? null : payload, v: 1 }, parentOrigin);
  }
  window.__send = send;
  window.__inert = !parentOrigin;

  window.addEventListener('message', (event) => {
    if (!parentOrigin || event.origin !== parentOrigin) return;
    var data = event.data;
    if (!data || typeof data.type !== 'string') return;
    window.__received.push(data.type);
    clearInterval(window.__reping);
    // The hosted page owns cancel: a close request is answered, never assumed.
    if (data.type === 'zinid:close' && autoCancel) send('zinid:cancel');
  });

  send('zinid:ready');
  // The real page re-pings ready until it hears something valid back.
  window.__reping = setInterval(function () { send('zinid:ready'); }, 150);
</script>
</body></html>`;

const PARENT_HTML = `<!doctype html>
<html><body style="margin:0">
<div id="host"></div>
<script>${BUNDLE}</script>
<script>
  window.__events = [];
  const record = (name) => (payload) => window.__events.push({ name, payload });
  window.__flow = ZinID.createFlow({
    url: ${JSON.stringify(SESSION_URL)},
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

async function setUp(page: Page, parentHtml = PARENT_HTML) {
  await page.route(`${HOSTED_ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: HOSTED_HTML }),
  );
  await page.route(`${VENDOR_ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: parentHtml }),
  );
  await page.goto(`${VENDOR_ORIGIN}/`);
}

function hostedFrame(page: Page): Frame {
  const frame = page.frames().find((candidate) => candidate.url().startsWith(HOSTED_ORIGIN));
  if (!frame) throw new Error('The hosted double never loaded.');
  return frame;
}

async function eventNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as never as { __events: { name: string }[] }).__events.map((e) => e.name),
  );
}

test.describe('SDK ↔ hosted page wire contract', () => {
  test('receives the ready event the hosted page actually sends', async ({ page }) => {
    await setUp(page);

    await expect.poll(() => eventNames(page)).toContain('ready');
  });

  test('delivers a complete payload verbatim', async ({ page }) => {
    await setUp(page);
    await expect.poll(() => eventNames(page)).toContain('ready');

    await hostedFrame(page).evaluate(() => {
      (window as never as { __send: (t: string, p?: unknown) => void }).__send('zinid:complete', {
        session: { sessionId: 'sess_e2e', status: 'Approved' },
        type: 'identity',
      });
    });

    const payload = await page.evaluate(
      () =>
        (window as never as { __events: { name: string; payload: unknown }[] }).__events.find(
          (e) => e.name === 'complete',
        )?.payload,
    );
    expect(payload).toEqual({
      session: { sessionId: 'sess_e2e', status: 'Approved' },
      type: 'identity',
    });
  });

  test('delivers step_change', async ({ page }) => {
    await setUp(page);
    await expect.poll(() => eventNames(page)).toContain('ready');

    await hostedFrame(page).evaluate(() => {
      (window as never as { __send: (t: string, p?: unknown) => void }).__send(
        'zinid:step_change',
        {
          step: 'document',
          index: 1,
          total: 3,
        },
      );
    });

    await expect.poll(() => eventNames(page)).toContain('step_change');
  });

  test('ignores a stale resize instead of resizing the frame', async ({ page }) => {
    // The hosted page no longer broadcasts zinid:resize. A stale deploy still
    // sending it must be a silent no-op rather than an error or a jumping frame.
    await setUp(page);
    await expect.poll(() => eventNames(page)).toContain('ready');
    const iframe = page.locator('#host iframe');
    const before = await iframe.evaluate((el) => Math.round(el.getBoundingClientRect().height));

    await hostedFrame(page).evaluate(() => {
      (window as never as { __send: (t: string, p?: unknown) => void }).__send('zinid:resize', {
        height: 900,
      });
    });

    await page.waitForTimeout(400);
    const after = await iframe.evaluate((el) => Math.round(el.getBoundingClientRect().height));
    expect(after).toBe(before);
    expect(await eventNames(page)).not.toContain('error');
  });

  test('escape sends the close request under its namespaced type', async ({ page }) => {
    // The double is told not to answer, so the frame survives long enough to
    // inspect exactly what it received.
    const parentHtml = PARENT_HTML.replace("mode: 'embed'", "mode: 'modal'").replace(
      SESSION_URL,
      `${SESSION_URL}?autocancel=0`,
    );
    await setUp(page, parentHtml);
    await expect.poll(() => eventNames(page)).toContain('ready');

    await page.keyboard.press('Escape');

    await expect
      .poll(() =>
        hostedFrame(page).evaluate(
          () => (window as never as { __received?: string[] }).__received ?? [],
        ),
      )
      .toContain('zinid:close');
    // The SDK does not synthesise cancel: nothing was emitted by the press itself.
    expect(await eventNames(page)).not.toContain('cancel');
  });

  test('completes the escape → close → cancel round trip', async ({ page }) => {
    const modalParent = PARENT_HTML.replace("mode: 'embed'", "mode: 'modal'");
    await setUp(page, modalParent);
    await expect.poll(() => eventNames(page)).toContain('ready');

    await page.keyboard.press('Escape');

    // The hosted page answered with cancel, which the SDK surfaced to the
    // vendor and then used to tear the modal down.
    await expect.poll(() => eventNames(page)).toContain('cancel');
    await expect(page.locator('iframe')).toHaveCount(0);
  });

  test('appends parent_origin so the hosted page is not inert', async ({ page }) => {
    // Without this param the real page builds a channel that never sends
    // anything: no ready, no complete, total silence. Assert the SDK adds it.
    await setUp(page);

    const src = await page.locator('#host iframe').getAttribute('src');
    const params = new URL(src as string).searchParams;
    expect(params.get('parent_origin')).toBe(VENDOR_ORIGIN);
    expect(params.get('mode')).toBe('embed');
    expect(
      await hostedFrame(page).evaluate(() => (window as never as { __inert: boolean }).__inert),
    ).toBe(false);
  });

  test('surfaces ready once and stops the re-ping', async ({ page }) => {
    await setUp(page);
    await expect.poll(() => eventNames(page)).toContain('ready');

    // The double re-pings every 150ms until acknowledged; wait past several.
    await page.waitForTimeout(600);

    const readyCount = await page.evaluate(
      () =>
        (window as never as { __events: { name: string }[] }).__events.filter(
          (e) => e.name === 'ready',
        ).length,
    );
    expect(readyCount).toBe(1);
    await expect
      .poll(() =>
        hostedFrame(page).evaluate(() => (window as never as { __received: string[] }).__received),
      )
      .toContain('zinid:ack');
  });

  // jsdom does no layout, so the unit tests can only assert the CSS string.
  // These measure what the box actually resolves to in a real engine.
  test.describe('modal box sizing', () => {
    const modalParent = () => PARENT_HTML.replace("mode: 'embed'", "mode: 'modal'");

    test('uses its full height when the viewport is tall enough', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 1000 });
      await setUp(page, modalParent());
      await expect.poll(() => eventNames(page)).toContain('ready');

      const height = await page
        .locator('iframe')
        .evaluate((el) => Math.round(el.getBoundingClientRect().height));
      expect(height).toBe(720);
    });

    test('falls back to 95vh on a viewport shorter than its full height', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 600 });
      await setUp(page, modalParent());
      await expect.poll(() => eventNames(page)).toContain('ready');

      const height = await page
        .locator('iframe')
        .evaluate((el) => Math.round(el.getBoundingClientRect().height));
      expect(height).toBe(570); // 95% of 600
    });

    test('never overflows a very short viewport', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 420 });
      await setUp(page, modalParent());
      await expect.poll(() => eventNames(page)).toContain('ready');

      const height = await page
        .locator('iframe')
        .evaluate((el) => Math.round(el.getBoundingClientRect().height));
      expect(height).toBe(399); // 95% of 420
      expect(height).toBeLessThan(420);
    });
  });

  test('ignores a message from a foreign origin', async ({ page }) => {
    await setUp(page);
    await expect.poll(() => eventNames(page)).toContain('ready');

    await page.evaluate(() => {
      window.postMessage(
        {
          type: 'zinid:complete',
          payload: { session: { sessionId: 'forged', status: 'Approved' }, type: 'completed' },
          v: 1,
        },
        '*',
      );
    });

    await page.waitForTimeout(200);
    expect(await eventNames(page)).not.toContain('complete');
  });
});
