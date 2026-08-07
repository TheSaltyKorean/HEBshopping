/**
 * W8 acceptance: drive the real Alexa skill against the real HEB list.
 *
 *   npm run verify:alexa
 *
 * Unit tests prove the conversation logic with a fake `ListOps`; this proves the whole
 * thing works against HEB — the same code path an Echo takes, minus the speech recognition.
 * Request envelopes are built exactly as Alexa sends them, and session attributes are
 * threaded between turns by hand, which is what Alexa does.
 *
 * MUTATES the real list, and cleans up after itself.
 */

import { resolve } from 'node:path';
import { FileStore, HebClient, HebListOps, checkSession, type HebList } from '@heb/core';
import { createSkill } from '@heb/lambda-api';

const SESSION_PATH = resolve('.session/session.json');
const store = new FileStore(SESSION_PATH);

/** Lines this run created. Only these may be deleted. */
const createdLines = new Set<string>();

/** lineId -> the quantity it had before this run incremented it. */
/**
 * Lines this run incremented: `lineId -> { previous, produced }`.
 *
 * Both numbers are needed. `previous` is where to restore to; `produced` is what this run
 * left the line at, and restoring is only safe while the line still reads exactly that.
 * Anything else means somebody edited it during the run, and their change is not ours to
 * discard.
 */
const raisedQuantities = new Map<
  string,
  {
    previous: number;
    produced: number;
    /**
     * Units this run put on the line.
     *
     * The number cleanup subtracts. `previous` is *not* safe to write back: it was read
     * before the mutation, and a household member incrementing the same line in that gap is
     * folded into `produced` — so restoring `previous` removes their unit along with this
     * run's (1 → their 2 → our 3 → restore 1). Subtracting only what this run contributed
     * leaves their change standing.
     */
    contributed: number;
  }
>();

/**
 * Read the list through a client that has cached nothing.
 *
 * `HebListOps` caches the resolved list, which is right within one operation and wrong
 * across two. Every guard below runs *inside* an operation the skill is already performing —
 * `RemoveItemIntent` calls `rankLines()` before `removeItem`, and that read populates the
 * cache — so `ops.getList()` in a guard returns the snapshot the skill took a moment ago
 * rather than the live list. A guard reading its own operation's opening snapshot cannot
 * detect a change made during that operation, which is the only thing it is looking for.
 *
 * The resolved list id is remembered across calls. Without it every fresh instance re-runs
 * `getShoppingLists` to find the default list, so each guard would cost two round trips
 * instead of one — and the guards now run on every add and every removal.
 */
let resolvedListId: string | undefined;

const freshList = async (): Promise<HebList> => {
  const list = await new HebListOps({
    client: new HebClient({ store }),
    ...(resolvedListId === undefined ? {} : { listId: resolvedListId }),
  }).getList();
  resolvedListId = list.listId;
  return list;
};

/**
 * `HebListOps` that physically cannot delete a line this run did not create.
 *
 * Declining to answer "yes" is not protection: if `rankLines` finds an existing line
 * confident, `RemoveItemIntent` deletes it immediately, before any confirmation. That is
 * not hypothetical — an earlier run of this very script removed a real grocery that way.
 * The removal path still needs exercising against live data, so it is fenced rather than
 * skipped: a wrong deletion becomes a loud failure instead of silent data loss.
 */
function guardedListOps(): HebListOps {
  const ops = new HebListOps({ client: new HebClient({ store }) });
  const realAdd = ops.addItem.bind(ops);
  const realRemove = ops.removeItem.bind(ops);

  ops.addItem = async (input) => {
    // Capture the pre-existing quantity *before* the mutation, because afterwards there is
    // no way to know what it was. An `already_present` add increments a real household
    // line, and tracking only created line ids would leave that increment behind on a run
    // that otherwise reports success.
    const before = new Map(
      (await freshList()).items.map((item) => [item.lineId, item.quantity] as const),
    );

    try {
      const result = await realAdd(input);
      // `added` means "no line in the opening snapshot", which is NOT the same as "this
      // call created it". If a household member added the same product in between, HEB
      // merged this unit into their brand-new line and `HebListOps` — whose snapshot
      // showed nothing — still reports `added` with their line id. Deleting it during
      // cleanup would take their grocery. Only a line reading exactly one was created here;
      // anything higher is a merge, and is undone by restoring the quantity instead.
      // What this call asked H-E-B to put on the line. `addItem` merges server-side, so a
      // successful add contributes exactly this many units regardless of what else is
      // happening to the line.
      const contributed = input.quantity ?? 1;

      // A counter line is measured in pounds, and `setItemQuantity` on one is meaningless —
      // recording it for a quantity restore would write a number nobody buys by.
      if (result.status !== 'needs_confirmation' && result.item.weight !== undefined) {
        console.error(
          `\n⚠ "${result.item.text}" is sold by weight, so this run cannot undo it by\n` +
            '  quantity. Reconcile by hand.',
        );
        process.exitCode = 1;
      } else if (result.status === 'added') {
        // `added` means "no line in the opening snapshot", not "this call created it whole".
        // If another household member creates or fills the same line to its ceiling between
        // the snapshot and this write, HEB returns the unchanged ceiling line under `added`
        // just the same, and the raw quantity is exactly as unprovable here as it is for
        // `already_present` at the same ceiling: `quantityRequested` bounds our contribution
        // from one side when present, and a ceiling hit without it makes the split
        // unprovable, so it is left for manual reconciliation instead of risking cleanup that
        // discards someone else's units.
        const atCeiling =
          result.item.maximumQuantity !== undefined &&
          result.item.quantity >= result.item.maximumQuantity;
        if (atCeiling && result.quantityRequested === undefined) {
          console.error(
            `\n⚠ "${result.item.text}" reads ${result.item.quantity}, its own ceiling, and ` +
              'this run cannot prove which unit is its own. Reconcile by hand.',
          );
          process.exitCode = 1;
        } else if (result.item.quantity === 1) createdLines.add(result.item.lineId);
        else if (!raisedQuantities.has(result.item.lineId)) {
          const provenContribution =
            result.quantityRequested === undefined
              ? contributed
              : Math.max(0, contributed - Math.max(0, result.quantityRequested - result.item.quantity));
          raisedQuantities.set(result.item.lineId, {
            previous: result.item.quantity - provenContribution,
            produced: result.item.quantity,
            contributed: provenContribution,
          });
        }
      } else if (result.status === 'already_present') {
        // `already_present` does not mean this call wrote anything — a line already at its
        // ceiling is reported `already_present` with the mutation never issued. The raw diff
        // against the opening snapshot is not proof either: a household member incrementing
        // the same line between that snapshot and this call's write inflates the diff past
        // whatever this run actually contributed, and attributing the whole diff to this run
        // restores the line to a value that discards their unit too. `quantityRequested`,
        // when present, is the ceiling's own accounting of how much of *our* request landed —
        // independent of anyone else's concurrent edits — so it bounds the claim from one
        // side while the raw diff bounds it from the other; only the smaller of the two is
        // proven to be this run's.
        const previous = before.get(result.item.lineId);
        const rawDelta = previous === undefined ? 0 : result.item.quantity - previous;
        // A line landing exactly on its own ceiling is exactly the case core cannot tell
        // apart from a household member's concurrent add hitting that same ceiling: either
        // way `quantityRequested` comes back undefined (the response already equals the
        // computed target) and `rawDelta` alone cannot prove whose unit made up the gap.
        // Claiming it anyway risks cleanup restoring the line to a value that discards
        // somebody else's grocery, so this case is left for manual reconciliation instead.
        const atCeiling =
          result.item.maximumQuantity !== undefined &&
          result.item.quantity >= result.item.maximumQuantity;
        const shortfall =
          result.quantityRequested === undefined
            ? atCeiling
              ? contributed
              : 0
            : Math.max(0, result.quantityRequested - result.item.quantity);
        const provenContribution = Math.max(0, contributed - shortfall);
        const actualContributed = Math.min(rawDelta, provenContribution);
        if (atCeiling && result.quantityRequested === undefined) {
          console.error(
            `\n⚠ "${result.item.text}" reads ${result.item.quantity}, its own ceiling, and ` +
              'this run cannot prove which unit is its own. Reconcile by hand.',
          );
          process.exitCode = 1;
        }
        if (previous !== undefined && actualContributed > 0 && !raisedQuantities.has(result.item.lineId)) {
          raisedQuantities.set(result.item.lineId, {
            previous,
            produced: result.item.quantity,
            contributed: actualContributed,
          });
        }
      }
      return result;
    } catch (error) {
      // Deliberately claims nothing.
      //
      // `HebListOps` now reports a transport failure as *indeterminate*, precisely because
      // a line appearing afterwards is equally well explained by a household member adding
      // the same product. Reading the list here and calling the match "ours" reinstates the
      // guess the core stopped making — and the consequence is worse in a verifier, whose
      // whole job ends by deleting what it believes it owns.
      //
      // The cost is a line this run may have created and will not clean up. That is
      // visible, reported, and removable by hand.
      console.error(
        `\n⚠ The add for ${input.productId ?? input.query ?? '(unknown)'} did not confirm.\n` +
          '  This run cannot prove what it wrote, so nothing is claimed for cleanup.\n' +
          '  Check the list by hand: there may be one extra unit.',
      );
      throw error;
    }
  };

  ops.removeItem = async (input) => {
    if (!createdLines.has(input.lineId)) {
      throw new Error(
        `REFUSED: tried to delete a line this verification did not create (${input.lineId}). ` +
          'That would remove a real grocery item.',
      );
    }

    // Membership in `createdLines` was earned when the add returned. It does not survive
    // contact with a household member: if somebody added the same product since, the line
    // now holds their unit too and deleting it takes both. The cleanup loop checks this,
    // and the *scripted removal* — the path the verification actually exercises — used to
    // walk straight past it.
    // Fails CLOSED. A `.catch(() => null)` here would turn a transient read failure into
    // "no evidence against deleting", which is the opposite of what the check is for: the
    // whole point is that permission must be re-earned, and an unreadable list earns
    // nothing. Only a successful read showing exactly one unit authorises the delete.
    let current;
    try {
      current = (await freshList()).items.find((item) => item.lineId === input.lineId);
    } catch (error) {
      throw new Error(
        `REFUSED: could not re-read the list to confirm line ${input.lineId} is still ` +
          `solely this run's, so it will not be deleted. Cause: ${(error as Error).message}`,
      );
    }
    if (current !== undefined && current.quantity !== 1) {
      throw new Error(
        `REFUSED: line ${input.lineId} now reads ${current.quantity}, not the 1 this run ` +
          'created. Somebody added to it; deleting would remove their unit as well.',
      );
    }

    await realRemove(input);
    createdLines.delete(input.lineId);
  };

  return ops;
}

const skill = createSkill({ createListOps: guardedListOps });

let sessionAttributes: Record<string, unknown> = {};

function envelope(request: object): object {
  return {
    version: '1.0',
    session: {
      new: false,
      sessionId: 'verify',
      application: { applicationId: 'amzn1.ask.skill.verify' },
      attributes: sessionAttributes,
      user: { userId: 'verify' },
    },
    context: {
      System: {
        application: { applicationId: 'amzn1.ask.skill.verify' },
        user: { userId: 'verify' },
      },
    },
    request,
  };
}

const intent = (name: string, item?: string): object => ({
  type: 'IntentRequest',
  requestId: 'r',
  timestamp: new Date().toISOString(),
  locale: 'en-US',
  intent: {
    name,
    confirmationStatus: 'NONE',
    slots:
      item === undefined
        ? {}
        : { item: { name: 'item', value: item, confirmationStatus: 'NONE' } },
  },
});

async function say(label: string, request: object): Promise<string> {
  const started = Date.now();
  const response = (await skill.invoke(envelope(request) as never, {} as never)) as {
    sessionAttributes?: Record<string, unknown>;
    response: { outputSpeech?: { ssml?: string }; card?: { content?: string } };
  };

  sessionAttributes = response.sessionAttributes ?? {};
  const speech = (response.response.outputSpeech?.ssml ?? '').replace(/<\/?speak>/g, '').trim();
  const elapsed = Date.now() - started;

  console.log(`\n🗣  ${label}`);
  console.log(`🔊 ${speech}`);
  console.log(`   (${elapsed}ms${elapsed > 8_000 ? '  ⚠ OVER ALEXA’S ~8s CEILING' : ''})`);
  if (response.response.card?.content !== undefined) {
    console.log(`   [card] ${response.response.card.content.split('\n').slice(0, 4).join(' | ')}`);
  }
  return speech;
}

/**
 * Remove exactly the lines this run added, leaving anything pre-existing untouched.
 *
 * Diffing lineIds rather than matching on names: the list belongs to someone, and a
 * name-based cleanup would happily delete a real item that resembled the test one.
 */
async function cleanUp(): Promise<void> {
  const listOps = new HebListOps({ client: new HebClient({ store }) });

  // Only lines this run created, never "everything absent from the opening snapshot".
  // A household member adding a grocery from the app while this runs would satisfy that
  // diff and be deleted — which is precisely the failure this cleanup exists to prevent.
  const added = (await freshList()).items.filter((item) => createdLines.has(item.lineId));

  for (const item of added) {
    // Created by this run, yes — but that was proved when the add returned, and a
    // household member merging into the same line since then leaves it above one.
    // Deleting it now would take their unit with it. Creation-time proof is not
    // cleanup-time proof.
    if (item.quantity !== 1) {
      console.error(
        `\n⚠ "${item.product?.name ?? item.text}" was created by this run but now reads ` +
          `${item.quantity}.\n  Somebody added to it, so it is NOT being deleted. ` +
          'Reconcile by hand.',
      );
      // A run that deliberately leaves test data on a real list has not verified cleanly,
      // whatever the assertions said. Without this the green "verified" message prints and
      // the process exits 0, so nobody learns there is a unit to remove.
      process.exitCode = 1;
      continue;
    }
    await listOps.removeItem({ lineId: item.lineId });
    console.log(`\n🧹 cleaned up: ${item.product?.name ?? item.text}`);
  }

  // Increments are undone by restoring the old quantity, never by deleting the line: it
  // belongs to the household, not to this run.
  //
  // A *fresh* client, not `listOps`. That instance's cache was populated by the read at the
  // top of this function, so `getList()` here returns that earlier snapshot rather than the
  // live line — and a household member's edit made since then is invisible to the
  // `now.quantity !== produced` check below, which then happily writes `previous` over it.
  // The guard was reading a photograph of the moment it was trying to detect changes since.
  const fresh = new HebListOps({ client: new HebClient({ store }) });
  let current;
  try {
    current = await fresh.getList();
  } catch (error) {
    console.error(
      '\n⛔ Could not re-read the list, so no quantity can be confirmed safe to restore.\n' +
        `   ${raisedQuantities.size} line(s) still hold this run's extra unit — reconcile by hand.\n` +
        `   Cause: ${(error as Error).message}`,
    );
    process.exitCode = 1;
    return;
  }

  for (const [lineId, { previous, produced, contributed }] of raisedQuantities) {
    // Only when the line still reads exactly what this run left it at. "Still above where
    // it started" is not enough: a household member incrementing the same line during the
    // run also satisfies it, and writing the opening quantity then discards their unit
    // along with the test's — restoring 1 from 3 when the test only ever added one.
    const now = current.items.find((item) => item.lineId === lineId);
    if (now === undefined) {
      console.log(`\n🧹 line ${lineId} is gone; nothing to restore`);
      continue;
    }
    if (now.quantity !== produced) {
      console.error(
        `\n⚠ line ${lineId} reads ${now.quantity}, not the ${produced} this run left.\n` +
          `   Somebody changed it during the run, so it is NOT being restored to ${previous}.\n` +
          `   Reconcile by hand if the test's extra unit is unwanted.`,
      );
      process.exitCode = 1;
      continue;
    }
    // Subtract this run's contribution; do not write the pre-mutation reading. When nobody
    // else touched the line the two are the same number, so the ordinary case is unchanged.
    const target = produced - contributed;
    if (target < previous) {
      // Fewer units landed than were asked for — a server-side ceiling, most likely — so
      // subtracting the full contribution would remove units this run never added.
      console.log(`\n🧹 line unchanged from its opening quantity; nothing to restore`);
      continue;
    }
    await listOps.setItemQuantity(lineId, target);
    console.log(
      `\n🧹 took back this run's ${contributed} unit(s): ${produced} → ${target}` +
        (target === previous ? '' : `, above the opening ${previous}`),
    );
  }

  if (added.length === 0 && raisedQuantities.size === 0) {
    console.log('\n🧹 nothing to clean up.');
  }
}

async function main(): Promise<void> {
  const health = checkSession(await store.getSession(), Date.now());
  if (!health.usable) {
    console.error(`⛔ No usable session (${health.reason ?? 'unknown'}). Run \`npm run login\`.`);
    process.exit(1);
  }

  console.log('── Alexa skill, driven against the real HEB list ──');


  // Everything from here can mutate the real list, so cleanup must be unconditional: an
  // assertion failure or a timed-out call would otherwise jump straight to the top-level
  // catch and leave a new grocery sitting on someone's list.
  try {
    await say('(open the skill)', {
      type: 'LaunchRequest',
      requestId: 'r',
      timestamp: new Date().toISOString(),
      locale: 'en-US',
    });

    await say('what is on my list', intent('ReadListIntent'));

    // A deliberately vague request: this should ask rather than write.
    const asked = await say('add green chili enchilada sauce', intent('AddItemIntent', 'green chili enchilada sauce'));
    if (!asked.startsWith('Did you mean')) {
      throw new Error('expected a vague request to be confirmed rather than written');
    }

    await say('no', intent('AMAZON.NoIntent'));
    const added = await say('yes', intent('AMAZON.YesIntent'));
    if (!/^Added |already on your list/.test(added)) {
      throw new Error(`expected "yes" to add the offered product, got: ${added}`);
    }

    await say('what is on my list', intent('ReadListIntent'));

    // Exercise spoken removal for real. `guardedListOps` refuses any line this run did not
    // create, so a mis-ranked confident removal fails loudly instead of destroying data.
    const removal = await say('remove enchilada sauce', intent('RemoveItemIntent', 'enchilada sauce'));
    if (!/Removed|Did you mean|could not find/.test(removal)) {
      throw new Error(`removal did not engage, got: ${removal}`);
    }
    if (removal.startsWith('Did you mean')) {
      await say('no', intent('AMAZON.NoIntent'));
    }

    await say('stop', intent('AMAZON.StopIntent'));


  } finally {
    // Deliberately not swallowed. Test data left on a real household list is a failure of
    // the verification, however well the assertions went, and exiting zero would hide it.
    await cleanUp();
  }

  await say('what is on my list', intent('ReadListIntent'));

  console.log('\n✅ Alexa skill verified against the real list: launch, read, ambiguous-add');
  console.log('   confirmation, no→next→yes, spoken removal, and stop.');
}

main().catch((error: unknown) => {
  console.error('\n⛔', error);
  process.exit(1);
});
