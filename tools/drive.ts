/**
 * W0 discovery driver.
 *
 * Reuses the logged-in profile from `npm run capture`, then drives the shopping list to
 * provoke the mutations we still need (add / update quantity / remove).
 *
 *   npx tsx tools/drive.ts inspect          # dump the page's interactive elements
 *   npx tsx tools/drive.ts add "oat milk"   # search for a product and add it to the list
 *
 * Scope guard: this touches shopping *lists* only. It must never interact with the cart,
 * checkout, or payment — see plan §2.5.
 */

import type { Page } from 'playwright';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { attachCapture, launchBrowser, saveCapture, type Capture } from './lib/browser.js';

/** What `add` last put on the list, so the mutating commands can refuse anything else. */
const THROWAWAY_PATH = resolve('captures/.drive-throwaway.json');

/** How long a marker proves anything. Yesterday's says nothing about today's list. */
const MARKER_TTL_MS = 60 * 60 * 1_000;

/**
 * Is the first list line the item this exercise created?
 *
 * Both mutating commands end up removing that line — `remove` directly, `mutate` by
 * decrementing to zero — so neither may run on a line it cannot account for. A count or a
 * quantity is not proof: a household list with one grocery at quantity one satisfies both.
 */
/**
 * Strip HEB's surrounding words so two labels for the same product compare equal.
 *
 * HEB phrases them differently — "Add X to list" versus "Select X" — so the wrapper words
 * come off and the product itself has to match exactly. Word overlap is deliberately not
 * enough: a marker for "Organic Whole Milk" must not accept "Organic Chocolate Milk".
 */
function productOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\s*(add|select)\s+/, '')
    .replace(/\s+to\s+(shopping\s+)?list\s*$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Every product currently on the list, as normalised labels.
 *
 * Taken *before* anything is clicked. Adding a product that is already on the list does
 * not create a new line — HEB merges it into the existing one and increments its quantity
 * (verified against the live API for written lines, and the same is true here). Without
 * this snapshot the run would mark a household grocery as its own throwaway, and `remove`
 * would then delete somebody's actual shopping.
 */
async function listedProducts(page: Page): Promise<Set<string>> {
  const labels = await page
    .locator('input[type="checkbox"][aria-label^="Select "]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') ?? ''));
  return new Set(labels.map(productOf).filter((label) => label !== ''));
}

async function isThrowawayLine(page: Page): Promise<boolean> {
  const marker = await readFile(THROWAWAY_PATH, 'utf8').catch(() => null);
  if (marker === null) return false;

  const { label = '', at = 0 } = JSON.parse(marker) as { label?: string; at?: number };
  if (label === '') return false;

  // Markers expire. One left over from yesterday says nothing about what is on the list
  // today, and the whole claim being made is that *this* exercise created the line.
  if (Date.now() - at > MARKER_TTL_MS) {
    console.error('⛔ The throwaway marker is stale. Run `drive.ts add` again.');
    return false;
  }

  const selectLabel =
    (await page
      .locator('input[type="checkbox"][aria-label^="Select "]')
      .first()
      .getAttribute('aria-label')) ?? '';

  const seen = productOf(selectLabel);
  return seen !== '' && seen === productOf(label);
}

/** Forget the marker once the line it describes has been consumed. */
async function clearThrowawayMarker(): Promise<void> {
  await rm(THROWAWAY_PATH, { force: true });
}

const LIST_URL = 'https://www.heb.com/shopping-list';

interface ElementInfo {
  tag: string;
  role: string | null;
  name: string;
  testId: string | null;
  type: string | null;
  placeholder: string | null;
  visible: boolean;
}

async function inspectPage(page: Page): Promise<ElementInfo[]> {
  return page.evaluate(() => {
    const selector = 'button, a[href], input, select, textarea, [role="button"], [role="link"]';
    const elements = [...document.querySelectorAll(selector)];

    return elements
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const htmlEl = el as HTMLElement;
        const name = (
          el.getAttribute('aria-label') ??
          htmlEl.innerText ??
          el.getAttribute('title') ??
          ''
        )
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 70);

        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          name,
          testId: el.getAttribute('data-testid') ?? el.getAttribute('data-qa'),
          type: el.getAttribute('type'),
          placeholder: el.getAttribute('placeholder'),
          visible: rect.width > 0 && rect.height > 0,
        };
      })
      .filter((info) => info.visible && (info.name !== '' || info.placeholder || info.testId));
  });
}

function printElements(elements: ElementInfo[]): void {
  console.log(`\n=== ${elements.length} visible interactive elements ===`);
  for (const el of elements) {
    const bits = [
      el.tag + (el.type ? `[${el.type}]` : ''),
      el.testId ? `testid=${el.testId}` : null,
      el.placeholder ? `placeholder="${el.placeholder}"` : null,
      el.name ? `"${el.name}"` : null,
    ].filter(Boolean);
    console.log('  ' + bits.join('  '));
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'inspect';
  const argument = process.argv[3] ?? '';

  const context = await launchBrowser();
  const capture = attachCapture(context);
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    console.log(`Navigating to ${LIST_URL} …`);
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4_000); // let the SPA settle and fire its queries

    console.log(`\nLanded on: ${page.url()}`);
    if (page.url().includes('accounts.heb.com')) {
      console.error('\n⛔ Redirected to login — the saved session is no longer valid.');
      console.error('   Log in in this window, then re-run. The profile persists.');
      await page.waitForTimeout(120_000);
      return;
    }

    const buildId = await page.evaluate(
      () => (window as unknown as { __NEXT_DATA__?: { buildId?: string } }).__NEXT_DATA__?.buildId ?? null,
    );
    console.log(`Next.js buildId: ${buildId ?? '(none)'}`);

    if (command === 'inspect') {
      printElements(await inspectPage(page));
      await page.screenshot({ path: 'captures/list-page.png', fullPage: true });
      console.log('\nScreenshot: captures/list-page.png');
    } else if (command === 'add') {
      capture.mark();
      await addItem(page, argument);
      console.log('\n=== calls provoked by the add flow ===');
      for (const call of capture.since()) {
        console.log(`  ${call.operationName}  status=${call.responseStatus}`);
      }
    } else if (command === 'mutate') {
      await exerciseQuantity(page, capture);
    } else if (command === 'remove') {
      await removeItem(page, capture);
    } else {
      console.error(`Unknown command: ${command}`);
    }
  } finally {
    await saveCapture(context, capture, command);
    await context.close().catch(() => {});
  }
}

/**
 * Add an item using the list page's own "Add an item" control.
 *
 * This is the free-text path, which also answers a contract question: whether HEB list
 * items must resolve to a catalog product or can be plain text (`ListItem.product` being
 * nullable depends on the answer).
 *
 * Locators are role/text based rather than CSS: HEB's class names are generated and would
 * rot immediately, whereas accessible names are what a user actually sees.
 *
 * Each step reports what it found, so a partial failure still teaches us the DOM.
 */
async function addItem(page: Page, text: string): Promise<void> {
  if (!text) throw new Error('add requires text, e.g. add "oat milk"');

  // Before anything is clicked: what is already on this list?
  const alreadyListed = await listedProducts(page);
  console.log(`\nList currently holds ${alreadyListed.size} product line(s).`);

  console.log(`\nClicking "Add an item" …`);
  await page.getByRole('button', { name: /add an item/i }).first().click();
  await page.waitForTimeout(1_500);

  console.log('\n--- after opening the add control ---');
  printElements(await inspectPage(page));

  // The control is input[type=search], so match on its placeholder rather than a type.
  const input = page.getByPlaceholder(/add or search for items/i).first();
  if ((await input.count()) === 0) {
    console.error('\n⛔ Search input not found. Structure is dumped above; adjust the locator.');
    await page.screenshot({ path: 'captures/add-no-input.png', fullPage: true });
    return;
  }

  console.log(`\nTyping "${text}" …`);
  await input.fill(text);
  await page.waitForTimeout(2_500);

  console.log('\n--- after typing (autocomplete) ---');
  printElements(await inspectPage(page));
  await page.screenshot({ path: 'captures/add-typed.png', fullPage: true });

  console.log('\nSubmitting search …');
  await input.press('Enter');
  await page.waitForTimeout(3_500);

  console.log('\n--- after submitting (results) ---');
  const afterSubmit = await inspectPage(page);
  printElements(afterSubmit);
  await page.screenshot({ path: 'captures/add-results.png', fullPage: true });

  // Scope to the modal. An unscoped match resolves to a product card on the page *behind*
  // the drawer, whose click the modal overlay then intercepts forever.
  // `data-qe-id` is HEB's own test hook, so it is far more stable than a class name.
  const modal = page.locator('[data-qe-id="miniSearchModal"]');
  const addButton = modal.locator('[data-qe-id="addToList"]').first();

  const buttons = await modal.locator('[data-qe-id="addToList"]').count();
  console.log(`\n"Add to list" buttons inside the modal: ${buttons}`);
  if (buttons === 0) {
    console.error('⛔ No "Add … to list" button in the modal results. Structure dumped above.');
    return;
  }

  const label = await addButton.getAttribute('aria-label');

  // Refuse *before* writing, not after. Adding something already on the list merges into
  // that line and increments it, producing no new line to own — and the ownership marker
  // would then point at a household grocery that `remove` deletes outright. Not clicking
  // is the only version of this that cannot damage the list.
  if (label !== null && alreadyListed.has(productOf(label))) {
    console.error(
      `\n⛔ "${label}" is already on this list.\n` +
        '   Adding it would merge into that line and increment it, leaving nothing this\n' +
        '   run can prove it created. Choose an item the list does not already hold.',
    );
    return;
  }

  console.log(`\nClicking: "${label ?? '(unnamed)'}" …`);
  await addButton.click();
  await page.waitForTimeout(3_500);
  await page.screenshot({ path: 'captures/add-clicked.png', fullPage: true });

  // Prove a genuinely new line appeared before claiming to own one. If the click silently
  // merged anyway — a different-but-equivalent product label, say — there is nothing safe
  // to delete later, and no marker is worth more than a wrong one.
  const nowListed = await listedProducts(page);
  const created = [...nowListed].filter((product) => !alreadyListed.has(product));
  if (label === null || !created.includes(productOf(label))) {
    console.error(
      `\n⛔ No new line matching "${label ?? '(unnamed)'}" appeared (${created.length} new line(s)).\n` +
        '   Not recording an ownership marker: `remove` must never delete a line this run\n' +
        '   cannot prove it created. Check the list by hand.',
    );
    return;
  }

  // Record what this run put on the list, so `remove` can prove the line it is about to
  // delete is a throwaway rather than somebody's actual shopping.
  await mkdir(dirname(THROWAWAY_PATH), { recursive: true });
  await writeFile(THROWAWAY_PATH, JSON.stringify({ label, at: Date.now() }, null, 2));
  console.log(`Recorded throwaway marker at ${THROWAWAY_PATH}`);
}

/**
 * Provoke the update and remove mutations via the list's quantity counter.
 *
 * The counter's decrement control is labelled "Remove product", which suggests stepping
 * down from a quantity of 1 deletes the line rather than setting it to zero. So:
 * increment (update), decrement (update), decrement (remove). Each step is captured
 * separately so operations can be attributed to the action that caused them.
 */
async function exerciseQuantity(page: Page, capture: Capture): Promise<void> {
  const increment = page.getByTestId('quantity-counter-increment').first();
  const decrement = page.getByTestId('quantity-counter-decrement').first();
  const value = page.getByTestId('quantity-counter-value').first();

  if ((await increment.count()) === 0) {
    console.error('⛔ No quantity counter found — is the list empty? Run `add` first.');
    return;
  }

  // These locators take the *first* category-sorted line, which on a real list is somebody's
  // groceries rather than the throwaway item an earlier `add` run created. The final step
  // decrements to zero, which removes it — so "quantity is 1" is not a safety check, it is
  // a description of most groceries. Prove ownership from the marker, exactly as `remove`
  // does, and put the quantity back regardless of what happens.
  if (!(await isThrowawayLine(page))) {
    console.error('⛔ The first line is not the item this run added — refusing to mutate it.');
    console.error('   Run `npx tsx tools/drive.ts add "<something>"` against an empty list first.');
    return;
  }

  const startedAt = Number(await value.inputValue().catch(() => 'NaN'));
  if (!Number.isFinite(startedAt)) {
    console.error('⛔ Could not read the current quantity; refusing to mutate blindly.');
    return;
  }

  const step = async (label: string, action: () => Promise<void>): Promise<void> => {
    capture.mark();
    const before = await value.inputValue().catch(() => '?');
    console.log(`\n── ${label} (quantity before: ${before})`);
    await action();
    await page.waitForTimeout(3_500);
    const after = await value.inputValue().catch(() => '(gone)');
    console.log(`   quantity after: ${after}`);
    for (const call of capture.since()) {
      console.log(`   → ${call.operationName}  status=${call.responseStatus}`);
    }
  };

  try {
    await step('INCREMENT 1 → 2', () => increment.click());
    await step('DECREMENT 2 → 1', () => decrement.click());
    await step('DECREMENT 1 → 0 (expect removal)', () => decrement.click());
  } finally {
    // Whatever happened, do not leave the line above where it started.
    const now = Number(await value.inputValue().catch(() => 'NaN'));
    if (Number.isFinite(now) && now > startedAt) {
      console.log(`\n🧹 restoring quantity ${now} → ${startedAt}`);
      for (let step = now; step > startedAt; step -= 1) {
        await decrement.click().catch(() => undefined);
        await page.waitForTimeout(2_000);
      }
    }
  }

  // The last decrement removes the line, so the marker no longer describes anything.
  await clearThrowawayMarker();
  await page.screenshot({ path: 'captures/after-mutations.png', fullPage: true });
}

/**
 * Provoke the removal mutation.
 *
 * Decrementing quantity below 1 turned out to be a no-op, so removal is not part of the
 * quantity counter. The list exposes a per-item checkbox plus a "More actions" control,
 * which is the bulk-edit affordance; that is the path tried here.
 */
async function removeItem(page: Page, capture: Capture): Promise<void> {
  // This drives a *deletion* against a real household list, and the reproduction
  // instructions advertise the command — so it must prove the line belongs to this
  // exercise rather than to the household. "The list has one item" is not proof: a normal
  // list with one real grocery satisfies it just as well.
  if (!(await isThrowawayLine(page))) {
    console.error('⛔ The first line is not the item this run added — refusing to delete it.');
    console.error('   Run `npx tsx tools/drive.ts add "<something>"` first.');
    return;
  }

  const checkbox = page.locator('input[type="checkbox"][aria-label^="Select "]').first();
  if ((await checkbox.count()) === 0) {
    console.error('⛔ No item checkbox found — is the list empty? Run `add` first.');
    return;
  }

  const label = await checkbox.getAttribute('aria-label');
  console.log(`\nSelecting: "${label ?? '(unnamed)'}"`);
  await checkbox.check();
  await page.waitForTimeout(1_500);

  console.log('\n--- after selecting (a bulk action bar may have appeared) ---');
  printElements(await inspectPage(page));

  const moreActions = page.getByRole('button', { name: /more actions/i }).first();
  if ((await moreActions.count()) > 0) {
    console.log('\nOpening "More actions" …');
    await moreActions.click();
    await page.waitForTimeout(1_500);
    console.log('\n--- menu contents ---');
    printElements(await inspectPage(page));
    await page.screenshot({ path: 'captures/more-actions.png', fullPage: true });
  }

  const deleteButton = page
    .getByRole('button', { name: /^(delete|remove)( selected| item| from list)?/i })
    .filter({ hasNotText: /product amount/i })
    .first();

  if ((await deleteButton.count()) === 0) {
    console.error('\n⛔ No delete control found. Structure dumped above; adjust the locator.');
    return;
  }

  capture.mark();
  const deleteLabel = await deleteButton.getAttribute('aria-label');
  console.log(`\nClicking delete: "${deleteLabel ?? '(unnamed)'}" …`);
  await deleteButton.click();
  await page.waitForTimeout(3_500);

  // HEB gates removal behind a confirmation, which is why the first click provoked no
  // mutation. Confirm it explicitly rather than assuming the first click was enough.
  console.log('\n--- after delete click ---');
  printElements(await inspectPage(page));
  await page.screenshot({ path: 'captures/after-delete.png', fullPage: true });

  const confirm = page.getByRole('button', { name: /^remove items?$/i }).first();
  if ((await confirm.count()) > 0) {
    console.log('\nConfirmation required — clicking "Remove items" …');
    await confirm.click();
    await page.waitForTimeout(3_500);
    await page.screenshot({ path: 'captures/after-confirm.png', fullPage: true });
  } else {
    console.log('\n(no confirmation dialog appeared)');
  }

  // The line is gone; the marker no longer describes anything on the list.
  await clearThrowawayMarker();

  console.log('\n=== calls provoked by removal ===');
  for (const call of capture.since()) {
    console.log(`  ${call.operationName}  status=${call.responseStatus}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
