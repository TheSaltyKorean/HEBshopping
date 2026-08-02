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
import { attachCapture, launchBrowser, saveCapture, type Capture } from './lib/browser.js';

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
  console.log(`\nClicking: "${label ?? '(unnamed)'}" …`);
  await addButton.click();
  await page.waitForTimeout(3_500);
  await page.screenshot({ path: 'captures/add-clicked.png', fullPage: true });
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

  await step('INCREMENT 1 → 2', () => increment.click());
  await step('DECREMENT 2 → 1', () => decrement.click());
  await step('DECREMENT 1 → 0 (expect removal)', () => decrement.click());

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

  console.log('\n=== calls provoked by removal ===');
  for (const call of capture.since()) {
    console.log(`  ${call.operationName}  status=${call.responseStatus}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
