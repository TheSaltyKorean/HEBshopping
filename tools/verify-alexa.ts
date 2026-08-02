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

const skill = createSkill({
  createListOps: () => new HebListOps({ client: new HebClient({ store }) }),
});

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
async function cleanUp(before: ReadonlySet<string>): Promise<void> {
  const listOps = new HebListOps({ client: new HebClient({ store }) });
  const added = (await listOps.getList()).items.filter((item) => !before.has(item.lineId));

  for (const item of added) {
    await listOps.removeItem({ lineId: item.lineId });
    console.log(`\n🧹 cleaned up: ${item.product.name}`);
  }
  if (added.length === 0) console.log('\n🧹 nothing to clean up.');
}

async function main(): Promise<void> {
  const health = checkSession(await store.getSession(), Date.now());
  if (!health.usable) {
    console.error(`⛔ No usable session (${health.reason ?? 'unknown'}). Run \`npm run login\`.`);
    process.exit(1);
  }

  console.log('── Alexa skill, driven against the real HEB list ──');

  // Snapshot first: cleanup removes the difference, never a name that looks familiar.
  const before = new Set(
    (await new HebListOps({ client: new HebClient({ store }) }).getList()).items.map(
      (item) => item.lineId,
    ),
  );

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

  // Exercise the spoken-removal path, but only far enough to see it engage. Answering
  // "yes" here would delete whichever line the matcher offered first, which on a real
  // household list is very likely to be something the owner put there. A verification
  // tool must not gamble with the user's data, so the actual cleanup is done below by
  // lineId — precisely, against the line this run created.
  const removal = await say('remove enchilada sauce', intent('RemoveItemIntent', 'enchilada sauce'));
  if (!/Removed|Did you mean/.test(removal)) {
    throw new Error(`removal did not engage, got: ${removal}`);
  }
  await say('no', intent('AMAZON.NoIntent'));

  await say('stop', intent('AMAZON.StopIntent'));

  await cleanUp(before);
  await say('what is on my list', intent('ReadListIntent'));

  console.log('\n✅ Alexa skill verified against the real list: launch, read, ambiguous-add');
  console.log('   confirmation, no→next→yes, spoken removal, and stop.');
}

main().catch((error: unknown) => {
  console.error('\n⛔', error);
  process.exit(1);
});
