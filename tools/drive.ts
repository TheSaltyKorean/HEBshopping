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
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  CAPTURE_DIR,
  PROFILE_DIR,
  attachCapture,
  ensureOwnerOnlyDir,
  launchBrowser,
  saveCapture,
  warnIfUntrustedDir,
  writeSecret,
  type Capture,
} from './lib/browser.js';

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

/**
 * Line ids, in list order, from the most recent captured response that carries them.
 *
 * The DOM exposes only product labels, and a label is not an identity: once the throwaway
 * is removed and a household member adds the same product, the replacement carries the
 * same label. HEB's own responses carry the item UUIDs, and the capture already has them.
 */
/**
 * Returns `null` when no list payload was captured at all, and `[]` when one was captured
 * and the list is empty. The distinction is the whole point.
 *
 * Skipping an empty `itemPage` and continuing to search backwards means a successful
 * deletion — whose response legitimately carries zero rows — falls through to an older,
 * pre-deletion response. `isThrowawayLine` then reads the line it just removed as still
 * present, keeps the marker armed and reports failure after a clean cleanup. An empty page
 * is an *answer*; only the absence of any recognised list payload is a missing one.
 */
function linesFromCapture(capture: Capture): Array<{ id: string; quantity: number }> | null {
  for (const call of [...capture.since()].reverse()) {
    const items = (
      call.responseBody as
        | {
            data?: Record<
              string,
              { itemPage?: { items?: Array<{ id?: string; quantity?: number }> } }
            >;
          }
        | undefined
    )?.data;
    if (items === undefined) continue;
    for (const payload of Object.values(items)) {
      const rows = payload?.itemPage?.items;
      if (rows === undefined) continue; // not a list payload — a search, say
      return rows
        .filter((item) => typeof item.id === 'string')
        .map((item) => ({ id: item.id!, quantity: item.quantity ?? 1 }));
    }
  }
  return null;
}

/**
 * How many lines the list holds right now.
 *
 * A name-only diff cannot tell a created line from a merged one: if a household member
 * adds the same product between the snapshot and the click, HEB merges the click into
 * their line and the product name is "new" to this run either way. The line *count* can
 * tell them apart — creation adds a line, a merge does not.
 */
async function lineCount(page: Page): Promise<number> {
  return page.locator('input[type="checkbox"][aria-label^="Select "]').count();
}

async function isThrowawayLine(page: Page, capture?: Capture): Promise<boolean> {
  const marker = await readFile(THROWAWAY_PATH, 'utf8').catch(() => null);
  if (marker === null) return false;

  const {
    label = '',
    at = 0,
    lineId = null,
    quantity = null,
  } = JSON.parse(marker) as {
    label?: string;
    at?: number;
    lineId?: string | null;
    quantity?: number | null;
  };
  if (label === '') return false;

  // Identity, not just a name. A label survives its line: remove the throwaway through the
  // H-E-B app, let a household member add the same product inside the marker's hour, and a
  // label-only check happily authorises deleting *their* replacement. The recorded id
  // cannot be reused that way.
  // A marker without identity cannot authorise anything — see the refusal in `addItem`.
  // Older markers written before that rule still exist, so they are rejected here too.
  if (lineId === null || quantity === null) {
    console.error('⛔ The marker carries no line identity. Refusing to treat any line as ours.');
    return false;
  }

  if (capture !== undefined) {
    const lines = linesFromCapture(capture);
    // No list payload at all is *unverified*, not *verified empty*. A cached page load or a
    // response shape this parser does not recognise both produce nothing — and falling
    // through to the label comparison below then authorises deleting any line whose product
    // name matches, which is exactly the identity-free check the recorded id exists to
    // replace. No rows, no permission.
    if (lines === null) {
      console.error(
        '⛔ This run captured no list rows, so the marked line cannot be identified.\n' +
          '   Refusing to treat any line as ours; reload the list and re-run.',
      );
      return false;
    }
    // A captured *empty* list is a real answer: the marked line is not on it. That is what a
    // successful `remove` looks like, and treating it as unverified there keeps the marker
    // armed and reports failure after a clean cleanup.
    if (lines.length === 0) return false;
    if (lines[0]!.id !== lineId) {
      console.error(
        '⛔ The first list line is not the one this marker describes — the throwaway is\n' +
          '   gone, or something else now sits at the top. Refusing to treat it as ours.',
      );
      return false;
    }
    // Identity is not enough. `remove` deletes the whole line and `mutate` decrements it,
    // so a household member who incremented the throwaway since it was created would have
    // their units consumed by either command. Ownership of a *line* expires the moment
    // somebody else contributes to it.
    if (lines[0]!.quantity !== quantity) {
      console.error(
        `⛔ The marked line now reads ${lines[0]!.quantity}, not the ${quantity} this run\n` +
          '   created. Somebody added to it; refusing to treat it as disposable.',
      );
      return false;
    }
  }

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

/**
 * Is the marked line still on the list, according to the freshest captured payload?
 *
 * A separate question from `isThrowawayLine`, which answers "may this run act on the first
 * row?" and says no for a line that is present but has moved down the category sort, has had
 * its quantity changed, or could not be verified at all. Reading that no as "the line is
 * gone" is what discarded the marker while the test line survived — leaving a throwaway on a
 * real household list with no command authorised to remove it.
 *
 * `unknown` is a third answer on purpose: an unverifiable capture must not license either
 * conclusion.
 */
async function markedLineState(capture: Capture): Promise<'absent' | 'present' | 'unknown'> {
  const marker = await readFile(THROWAWAY_PATH, 'utf8').catch(() => null);
  if (marker === null) return 'absent'; // nothing recorded, so nothing to keep

  let lineId: string | null = null;
  try {
    ({ lineId = null } = JSON.parse(marker) as { lineId?: string | null });
  } catch {
    return 'unknown';
  }
  if (lineId === null) return 'unknown';

  const lines = linesFromCapture(capture);
  if (lines === null) return 'unknown';
  return lines.some((line) => line.id === lineId) ? 'present' : 'absent';
}

/**
 * Drop the marker only once the line it names is demonstrably gone.
 *
 * Anything else keeps it: the marker is what authorises a later cleanup, and discarding it
 * on a surviving line strands test data permanently.
 */
async function releaseMarkerIfConsumed(capture: Capture, what: string): Promise<void> {
  const state = await markedLineState(capture);
  if (state === 'absent') {
    await clearThrowawayMarker();
    return;
  }
  console.error(
    state === 'present'
      ? `\n⛔ The marked line survived ${what} — keeping the ownership marker so it can be\n` +
          '   cleaned up.'
      : `\n⛔ Could not confirm whether the marked line survived ${what} — keeping the\n` +
          '   ownership marker rather than stranding a line nothing may remove.',
  );
  process.exitCode = 1;
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
  await warnIfUntrustedDir(PROFILE_DIR);
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
      // `capture.mark()` moved inside `addItem` — it must not run until the page-load
      // responses have been read for the baseline. See the note there.
      await addItem(page, argument, capture);
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
async function addItem(page: Page, text: string, capture: Capture): Promise<void> {
  if (!text) throw new Error('add requires text, e.g. add "oat milk"');

  // Before anything is clicked: what is already on this list?
  const alreadyListed = await listedProducts(page);
  const linesBefore = await lineCount(page);

  // The baseline comes from the page-load responses, so it must be read BEFORE the capture
  // window is reset. `capture.mark()` makes `since()` empty, so taking the baseline after it
  // saw no rows at all — and `createdLine` below, looking for the first id absent from an
  // empty baseline, then picked the *first row of the list* rather than the new one. On any
  // list whose new product does not sort first, that marks somebody's grocery as disposable.
  const idsBefore = linesFromCapture(capture);
  capture.mark();
  console.log(`\nList currently holds ${linesBefore} product line(s).`);

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
  const linesAfter = await lineCount(page);

  // Both tests, because each catches what the other misses. The name diff proves the new
  // line is the product that was clicked; the count proves a line was *created* rather
  // than merged into one a household member added a moment ago — in which case the name is
  // new to this run but the line belongs to them.
  if (label === null || !created.includes(productOf(label)) || linesAfter !== linesBefore + 1) {
    console.error(
      `\n⛔ Could not prove this run created a line for "${label ?? '(unnamed)'}".\n` +
        `   Lines went ${linesBefore} → ${linesAfter}; new product names: ${created.length}.\n` +
        '   A merge into an existing line looks like this. Not recording an ownership\n' +
        '   marker: `remove` must never delete a line this run cannot prove it created.',
    );
    return;
  }

  // Record what this run put on the list, so `remove` can prove the line it is about to
  // delete is a throwaway rather than somebody's actual shopping.
  // The id of the line that appeared, taken from HEB's own response rather than the DOM.
  // Without it the marker names a product, and products outlive the lines that hold them.
  const linesNow = linesFromCapture(capture);

  // Both sides have to be real readings. An unknown baseline cannot tell a new line from an
  // old one — every id looks unfamiliar — so it would name whichever row happens to sort
  // first, which is exactly the mismarking the id was introduced to prevent.
  if (idsBefore === null || linesNow === null) {
    console.error(
      '\n⛔ The captured responses did not carry the list' +
        `${idsBefore === null ? ' before' : ' after'} the add, so this run cannot tell which\n` +
        '   line it created. No ownership marker written — `remove` and `mutate` will\n' +
        '   refuse. Delete the test item by hand.',
    );
    process.exitCode = 1;
    return;
  }

  const before = new Set(idsBefore.map((line) => line.id));
  const createdLine = linesNow.find((line) => !before.has(line.id)) ?? null;

  // No identity, no marker. A label-only marker is worth less than none: `isThrowawayLine`
  // falls back to comparing product names, so once the throwaway is removed in the H-E-B
  // app and a household member adds the same product inside the marker's hour, `remove`
  // cheerfully authorises deleting their replacement. Refusing to arm leaves the operator
  // to clean up by hand, which is the recoverable failure.
  if (createdLine === null) {
    console.error(
      '\n⛔ The captured responses did not expose the new line, so this run cannot record\n' +
        '   which line it created. No ownership marker written — `remove` and `mutate` will\n' +
        '   refuse. Delete the test item by hand.',
    );
    process.exitCode = 1;
    return;
  }

  // A new line holding more than one unit was never solely this run's. The DOM checks above
  // are sampled *before* the click, so a household member adding this product in that window
  // has H-E-B merge this run's unit into the line they just created: one unfamiliar id, one
  // new product name, one more line — every DOM test passes — and the quantity is 2. Arming
  // the marker there records their line as disposable, and `remove` deletes it outright.
  // The unit count is the only witness that survives the race.
  if (createdLine.quantity !== 1) {
    console.error(
      `\n⛔ The new line reads ${createdLine.quantity}, not 1, so this run merged into a line\n` +
        '   somebody else created in the meantime. No ownership marker written — `remove`\n' +
        '   and `mutate` will refuse. Undo the extra unit by hand.',
    );
    process.exitCode = 1;
    return;
  }

  // Both mutating commands act on the *first* row — `isThrowawayLine` requires
  // `lines[0].id === lineId`, and the counter and checkbox locators take `.first()`. A
  // marker naming a line further down the category sort can therefore only ever produce a
  // refusal later, which strands the test item with a confusing message instead of an
  // immediate one. Say so now, while the operator still knows what was just added.
  if (linesNow[0]?.id !== createdLine.id) {
    console.error(
      '\n⛔ The new line did not sort first, and `mutate` and `remove` both act on the first\n' +
        '   row. A marker for it could only produce a refusal later, so none was written.\n' +
        '   Delete the test item by hand, and run `add` against an empty list to exercise\n' +
        '   the mutating commands.',
    );
    process.exitCode = 1;
    return;
  }

  await ensureOwnerOnlyDir(CAPTURE_DIR);
  await writeSecret(
    THROWAWAY_PATH,
    JSON.stringify(
      { label, lineId: createdLine.id, quantity: createdLine.quantity, at: Date.now() },
      null,
      2,
    ),
  );
  console.log(
    `Recorded throwaway marker at ${THROWAWAY_PATH}` +
      ` (line ${createdLine.id} ×${createdLine.quantity})`,
  );
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
  if (!(await isThrowawayLine(page, capture))) {
    console.error('⛔ The first line is not the item this run added — refusing to mutate it.');
    console.error('   Run `npx tsx tools/drive.ts add "<something>"` against an empty list first.');
    return;
  }

  const startedAt = Number(await value.inputValue().catch(() => 'NaN'));
  if (!Number.isFinite(startedAt)) {
    console.error('⛔ Could not read the current quantity; refusing to mutate blindly.');
    return;
  }

  /**
   * Units this run has put on the line and not yet taken back.
   *
   * Accounted from what each click *observably* did, not from what it was meant to do, and
   * used instead of "restore down to `startedAt`" — that older rule also swallows a unit a
   * household member contributed mid-run, because their increment leaves the line above
   * where this run found it through no fault of this run's.
   */
  let owed = 0;

  /**
   * Set once the line stops being solely this run's.
   *
   * It gates the cleanup as well as the destructive step, because the two are the same
   * decision: the decrement control operates on the line, so neither can act once somebody
   * else's units are mixed in.
   */
  let ownershipLost = false;

  const step = async (
    label: string,
    action: () => Promise<void>,
    intended: number,
  ): Promise<void> => {
    capture.mark();
    const beforeText = await value.inputValue().catch(() => '?');
    console.log(`\n── ${label} (quantity before: ${beforeText})`);
    await action();
    await page.waitForTimeout(3_500);
    const afterText = await value.inputValue().catch(() => '(gone)');
    console.log(`   quantity after: ${afterText}`);

    const before = Number(beforeText);
    const after = Number(afterText);
    if (Number.isFinite(before) && Number.isFinite(after)) {
      owed += after - before;
    } else if (intended < 0 && Number.isFinite(before)) {
      // The counter is gone: the line was removed, so the decrement landed.
      owed += intended;
    }

    for (const call of capture.since()) {
      console.log(`   → ${call.operationName}  status=${call.responseStatus}`);
    }
  };

  try {
    await step('INCREMENT 1 → 2', () => increment.click(), +1);
    await step('DECREMENT 2 → 1', () => decrement.click(), -1);

    // The third click deletes the line, and ownership was last proved before the first one.
    // A household member incrementing this same line since then makes the sequence
    // 1 → 2 (ours) → 3 (theirs) → 2 → 1, so the two decrements consume their unit rather
    // than this run's. The counter re-renders from H-E-B's own mutation responses, so it
    // already reflects their change — check it immediately before the destructive step, and
    // treat an unreadable counter as a mismatch.
    const beforeFinal = Number(await value.inputValue().catch(() => 'NaN'));
    if (beforeFinal !== startedAt) {
      ownershipLost = true;
      console.error(
        `\n⛔ The line reads ${Number.isFinite(beforeFinal) ? beforeFinal : '(unreadable)'}, ` +
          `not the ${startedAt} this run expects before the final\n` +
          '   decrement. Somebody changed it, so decrementing to zero would take their unit\n' +
          '   too. Refusing; the removal mutation goes uncaptured this run.',
      );
      process.exitCode = 1;
    } else {
      await step('DECREMENT 1 → 0 (expect removal)', () => decrement.click(), -1);
    }
  } finally {
    // The cleanup has to respect the same finding that stopped the final decrement.
    //
    // Refusing the destructive step and then running this loop anyway undoes the refusal:
    // the decrement control acts on the whole line, not on "this run's units", so once
    // somebody else has contributed there is no click that takes back only ours. `owed`
    // says how much this run put on; it does not say those units are still separable.
    if (ownershipLost) {
      if (owed > 0) {
        console.error(
          `\n⛔ NOT taking back this run's ${owed} unit(s): the line is no longer solely this\n` +
            '   run\'s, and decrementing would remove somebody else\'s unit instead. Reconcile\n' +
            '   by hand — the line holds one unit this exercise added.',
        );
      }
    } else if (owed > 0) {
      // Take back exactly what this run added, and nothing else.
      console.log(`\n🧹 taking back ${owed} unit(s) this run added`);
      for (let remaining = owed; remaining > 0; remaining -= 1) {
        await decrement.click().catch(() => undefined);
        await page.waitForTimeout(2_000);
      }
    }
  }

  // Ownership was lost mid-run, so neither branch below applies: the line is shared, this
  // run's unit is still on it, and `isThrowawayLine` will now fail the quantity check —
  // which would drop the marker and, with it, the only record that a unit was left behind.
  if (ownershipLost) {
    console.error(
      '\n⛔ Keeping the ownership marker: the line is shared, so nothing here may delete or\n' +
        '   decrement it, and the record of this run\'s unit should not be discarded.\n' +
        '   Reconcile by hand.',
    );
    await page.screenshot({ path: 'captures/after-mutations.png', fullPage: true });
    return;
  }

  // Same rule as `remove`: the documented behaviour of decrementing below one is a no-op,
  // so the line may well still be there. Only a list that no longer shows it justifies
  // dropping the marker that authorizes removing it.
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.waitForTimeout(2_000);
  await releaseMarkerIfConsumed(capture, 'the decrements');
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
  // Reload before proving anything, so the proof is about the list as it is now.
  //
  // The evidence here is a page snapshot, and `main` navigates once at startup — so without
  // this the ownership proof can be arbitrarily old by the time the operator reaches this
  // command. Four interactions and several seconds then separate the proof from the
  // irreversible click. Reloading is what makes that gap seconds rather than open-ended.
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.waitForTimeout(4_000);

  // This drives a *deletion* against a real household list, and the reproduction
  // instructions advertise the command — so it must prove the line belongs to this
  // exercise rather than to the household. "The list has one item" is not proof: a normal
  // list with one real grocery satisfies it just as well.
  if (!(await isThrowawayLine(page, capture))) {
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
    // Re-prove immediately before the irreversible click.
    //
    // Honest about what this does and does not do: it re-reads the freshest captured list
    // payload, which the delete click may itself have provoked, so it catches a change
    // visible in that response. It cannot see a change H-E-B has not told this page about —
    // the dialog fires no read, and reloading here would dismiss it. The residual window is
    // the dialog's lifetime, and closing it needs a read the UI does not make.
    if (!(await isThrowawayLine(page, capture))) {
      console.error(
        '\n⛔ The marked line no longer checks out, and the confirmation deletes the whole\n' +
          '   line. Refusing to confirm. The dialog is left open — close it by hand, and the\n' +
          '   ownership marker is kept so this can be retried.',
      );
      process.exitCode = 1;
      return;
    }

    console.log('\nConfirmation required — clicking "Remove items" …');
    await confirm.click();
    await page.waitForTimeout(3_500);
    await page.screenshot({ path: 'captures/after-confirm.png', fullPage: true });
  } else {
    console.log('\n(no confirmation dialog appeared)');
  }

  // Clear the marker only once the line is demonstrably gone. A refused mutation, or a
  // delete control that produced no confirmation dialog, leaves the throwaway line on a
  // real household list — and clearing the marker there discards the only thing that
  // authorizes a later cleanup, stranding test data nothing is allowed to remove.
  await releaseMarkerIfConsumed(capture, 'the removal');

  console.log('\n=== calls provoked by removal ===');
  for (const call of capture.since()) {
    console.log(`  ${call.operationName}  status=${call.responseStatus}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
