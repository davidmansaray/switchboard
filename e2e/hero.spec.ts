import { expect, test, type Page } from '@playwright/test';

/**
 * The 9-beat hero story, clicked through the real UI against the real harness and database:
 * simulator rail → agent scenario runner → services → signals → desk runs → tools → Postgres →
 * NOTIFY → SSE → the page. Beats 5 and 6 are approved from the phone frame, as Gary would.
 */
const errors: string[] = [];

async function beatDone(page: Page, n: number, timeout = 90_000) {
  const pip = page.locator(`.sim__beat >> nth=${n - 1}`);
  await expect(pip).toHaveAttribute('data-state', /done|failed/, { timeout });
  if ((await pip.getAttribute('data-state')) === 'failed') {
    // Say why: the runner stores the error on the beat row.
    const board = await page.request.get('/api/board').then((r) => r.json());
    const row = board.scenario.beats.find((b: { n: number }) => b.n === n);
    throw new Error(`beat ${n} failed: ${row?.error ?? 'unknown'}`);
  }
}

async function next(page: Page) {
  const btn = page.getByTestId('sim-next');
  await expect(btn).toBeEnabled({ timeout: 60_000 });
  await btn.click();
}

test.beforeEach(async ({ page }) => {
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
});

test('the hero story, beat by beat, through the UI', async ({ page }) => {
  await page.goto('/');
  const runtime = await page.request.get('/api/board').then((r) => r.json());
  const backend: string = runtime.runtime.backend;
  const crashEnabled: boolean = runtime.runtime.crashEnabled;
  test.info().annotations.push({ type: 'backend', description: backend });

  // Back to the seeded morning (two clicks: Reset, Confirm reset).
  await page.getByTestId('sim-reset').click();
  await page.getByTestId('sim-reset').click();
  await expect(page.getByTestId('sim-next')).toContainText('Next beat 1', { timeout: 60_000 });
  const hero = page.getByTestId('desk-NH-5520');
  await expect(hero).toHaveAttribute('data-status', 'idle');
  await expect(hero.locator('.tcard__ver')).toHaveText('v3');

  // 1 · Sam's email wakes the idle desk; it records an open ask and drafts nothing.
  await next(page);
  await beatDone(page, 1);
  const drawer = page.getByTestId('desk-drawer');
  await expect(drawer.locator('.loop[data-loop="open"]')).toContainText('asked for a discount');
  await expect(page.getByTestId('stream')).toContainText('Can you knock something off');
  await expect(drawer).toContainText('No drafts on this desk yet');

  // 2 · Leanne's PO on T2 is routine tier: applied and logged, no approval. v4.
  await next(page);
  await beatDone(page, 2);
  await expect(hero.locator('.tcard__ver')).toHaveText('v4');
  await expect(drawer.locator('.facts')).toContainText('HAL-PO-88213');
  await expect(drawer.locator('.ledger__row[data-ledger="recorded"]').first()).toContainText('applyRoutineUpdate');

  // 3 + 4 · Gary's note → D-7 on v4; Jo's edit lands mid-run (queued), v5, D-7 goes stale.
  await next(page);
  await beatDone(page, 3);
  await beatDone(page, 4);
  const d7 = page.getByTestId('signoff').getByTestId('draft-D-7');
  await expect(d7).toHaveAttribute('data-draft-status', 'stale');
  await expect(d7.locator('.stalestrip')).toContainText('Written against v4 · hire is v5');
  await expect(page.locator('.sig[data-type="queued-message"]').first()).toContainText(/queued/);
  await expect(drawer.getByTestId('chain-D-7').locator('.diff')).toContainText('Wed 4 Nov');

  // 5 · Gary approves the stale draft from his phone: the desk regenerates D-8 on v5.
  await next(page);
  const phone = page.getByTestId('phone-sheet');
  await expect(phone).toBeVisible();
  const frame = page.frameLocator('[data-testid="phone-sheet"] iframe');
  await frame.getByTestId('mobile-approve-btn').click();
  await expect(frame.getByTestId('mobile-filed')).toContainText('Sent to the NH-5520 desk as a signal');
  await beatDone(page, 5);
  await expect(frame.getByTestId('mobile-newer')).toContainText('New draft D-8 waiting');
  await expect(drawer.locator('.chain__path')).toContainText('D-7');
  await expect(drawer.getByTestId('chain-D-8')).toHaveAttribute('data-draft-status', 'pending');
  await expect(drawer.getByTestId('chain-D-8')).toContainText('£3,852.00');

  // 6 · Approve D-8 on the phone. The worker dies mid-apply; recovery skips the recorded write; one email.
  await frame.getByTestId('mobile-newer').click();
  await frame.getByTestId('mobile-approve-btn').click();
  await expect(frame.getByTestId('mobile-filed')).toContainText('Sent to the NH-5520 desk as a signal');
  await page.getByRole('button', { name: 'Close the phone' }).click();
  if (crashEnabled) await expect(page.getByTestId('worker-down').or(page.locator('.tcard[data-status="recovering"]')).first()).toBeVisible({ timeout: 30_000 });
  await beatDone(page, 6, 150_000);
  await expect(drawer.getByTestId('chain-D-8')).toHaveAttribute('data-draft-status', 'applied', { timeout: 30_000 });
  await expect(drawer.getByTestId('emails-sent')).toContainText('1 email sent');
  await expect(hero.locator('.tcard__ver')).toHaveText('v6');
  if (crashEnabled && backend === 'harness') {
    await drawer.locator('.desk__trace summary').click();
    await expect(drawer.locator('.chip[data-run="crashed"]')).toBeVisible();
  }

  // 7 · The 07:00 sweep: no signed waiver on file, so a chaser goes to the sign-off slot.
  await next(page);
  await beatDone(page, 7);
  await expect(page.getByTestId('signoff')).toContainText('Waiver chaser');

  // 8 · Sam emails "cancel the telehandler" and Jo cancels the line: one intent, one draft.
  await next(page);
  await beatDone(page, 8);
  const cancel = page.getByTestId('signoff').locator('.dcard', { hasText: 'Partial cancellation' });
  await expect(cancel).toHaveCount(1);
  await expect(cancel).toContainText('£1,548.00');
  await expect(page.locator('.sig[data-merged="true"]')).toContainText('merged into');

  // 9 · The Architecture Overlay labels every region.
  await next(page);
  await beatDone(page, 9);
  await expect(page.getByTestId('overlay-inspector')).toBeVisible();
  await expect(page.locator('[data-mech="signal"] .mechtag').first()).toBeVisible();
  await page.getByRole('button', { name: 'Turn off Architecture Overlay' }).click();

  // And the cancellation itself: approve it; exactly one credit note, still one email per draft.
  await cancel.getByRole('button', { name: 'Approve' }).click();
  await expect(drawer.getByTestId('emails-sent')).toContainText('2 emails sent', { timeout: 60_000 });
  await expect(drawer.getByTestId('emails-sent')).toContainText('1 credit note');
  await expect(drawer.getByTestId('emails-sent')).toContainText('£1,548.00');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('phone: the mobile approval view and the docked simulator', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.locator('.simpill')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.goto('/signals');
  await expect(page.getByTestId('signal-row').first()).toBeVisible();
  await page.goto('/approvals');
  await expect(page.getByTestId('approvals')).toBeVisible();
  await ctx.close();
});
