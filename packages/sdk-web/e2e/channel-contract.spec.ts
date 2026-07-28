import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Frame, Page } from '@playwright/test';

/**
 * End-to-end contract check against a hosted-page double.
 *
 * This exists because a unit test cannot catch a wire-format mismatch: if the
 * SDK and the test both use the wrong message type, the test passes while the
 * real channel is dead. Here the double speaks the canonical `zinid:*` types
 * written out by hand, the parent runs the **built** IIFE bundle, and the two
 * sit on genuinely different origins — so the origin guard, the source guard
 * and the type namespacing are all exercised for real.
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
  function send(type, payload) {
    parent.postMessage(payload === undefined ? { source: 'zinid', type } : { source: 'zinid', type, payload }, '*');
  }
  window.__send = send;
  var autoCancel = new URLSearchParams(location.search).get('autocancel') !== '0';
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'zinid-sdk') return;
    window.__received = window.__received || [];
    window.__received.push(data.type);
    // The hosted page owns cancel: a close request is answered, never assumed.
    if (data.type === 'zinid:close' && autoCancel) send('zinid:cancel');
  });
  send('zinid:ready');
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

  test('applies a settled resize to the embedded iframe', async ({ page }) => {
    await setUp(page);
    await expect.poll(() => eventNames(page)).toContain('ready');
    const iframe = page.locator('#host iframe');
    const before = await iframe.evaluate((el) => el.getBoundingClientRect().height);

    await hostedFrame(page).evaluate(() => {
      (window as never as { __send: (t: string, p?: unknown) => void }).__send('zinid:resize', {
        height: 900,
      });
    });

    // The transition animates, so poll until it settles rather than sampling once.
    await expect
      .poll(() => iframe.evaluate((el) => Math.round(el.getBoundingClientRect().height)))
      .toBe(900);
    expect(before).not.toBe(900);
  });

  test('clamps a collapsing resize to the floor', async ({ page }) => {
    await setUp(page);
    await expect.poll(() => eventNames(page)).toContain('ready');

    await hostedFrame(page).evaluate(() => {
      (window as never as { __send: (t: string, p?: unknown) => void }).__send('zinid:resize', {
        height: 10,
      });
    });

    await expect
      .poll(() =>
        page
          .locator('#host iframe')
          .evaluate((el) => Math.round(el.getBoundingClientRect().height)),
      )
      .toBe(340);
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

  test('ignores a message from a foreign origin', async ({ page }) => {
    await setUp(page);
    await expect.poll(() => eventNames(page)).toContain('ready');

    await page.evaluate(() => {
      window.postMessage(
        {
          source: 'zinid',
          type: 'zinid:complete',
          payload: { session: { sessionId: 'forged', status: 'Approved' }, type: 'identity' },
        },
        '*',
      );
    });

    await page.waitForTimeout(200);
    expect(await eventNames(page)).not.toContain('complete');
  });
});
