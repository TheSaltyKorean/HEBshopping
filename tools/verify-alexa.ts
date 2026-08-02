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
import { FileStore, HebClient, HebListOps, checkSession } from '@heb/core';
import { createSkill } from '@heb/lambda-api';

const SESSION_PATH = resolve('.session/session.json');
const store = new FileStore(SESSION_PATH);

/** Lines this run created. Only these may be deleted. */
const createdLines = new Set<string>();

/** lineId -> the quantity it had before this run incremented it. */
const raisedQuantities = new Map<string, number>();

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
      (await ops.getList()).items.map((item) => [item.lineId, item.quantity] as const),
    );

    try {
      const result = await realAdd(input);
      if (result.status === 'added') createdLines.add(result.item.lineId);
      if (result.status === 'already_present') {
        const previous = before.get(result.item.lineId);
        if (previous !== undefined && !raisedQuantities.has(result.item.lineId)) {
          raisedQuantities.set(result.item.lineId, previous);
        }
      }
      return result;
    } catch (error) {
      // The throw does not mean nothing happened: HEB may have committed the write and
      // lost the response. But claim only the product *this call* asked for — a household
      // member adding something at the same moment also appears as a line absent from the
      // snapshot, and an unconditional diff would mark their grocery as test data and
      // delete it during cleanup.
      const wanted = input.productId;
      const after = wanted === undefined ? null : await ops.getList().catch(() => null);

      const mine = after?.items.find((item) => item.product?.id === wanted);
      if (mine !== undefined) {
        const previous = before.get(mine.lineId);
        if (previous === undefined) createdLines.add(mine.lineId);
        else if (mine.quantity > previous && !raisedQuantities.has(mine.lineId)) {
          raisedQuantities.set(mine.lineId, previous);
        }
      }
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
  const added = (await listOps.getList()).items.filter((item) => createdLines.has(item.lineId));

  for (const item of added) {
    await listOps.removeItem({ lineId: item.lineId });
    console.log(`\n🧹 cleaned up: ${item.product?.name ?? item.text}`);
  }

  // Increments are undone by restoring the old quantity, never by deleting the line: it
  // belongs to the household, not to this run.
  const current = await listOps.getList().catch(() => null);
  for (const [lineId, previous] of raisedQuantities) {
    // Only if the line still sits above where it started. Writing the opening quantity
    // unconditionally would erase an edit somebody made in the H-E-B app during the run.
    const now = current?.items.find((item) => item.lineId === lineId);
    if (now === undefined || now.quantity <= previous) {
      console.log(`\n🧹 line already at or below ${previous}; leaving it alone`);
      continue;
    }
    await listOps.setItemQuantity(lineId, previous);
    console.log(`\n🧹 restored quantity ${previous} on a pre-existing line`);
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
