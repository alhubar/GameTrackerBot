import test from 'node:test';
import assert from 'node:assert/strict';
import { awardSocialBadges } from '../src/socialBadges.js';

/** A candidate row as the two boards return it. */
const row = (userId, { voice = 0, text = 0 } = {}) =>
  ({ user_id: userId, voice_minutes: voice, text_minutes: text });

const holder = (award) => award?.user_id ?? null;

// ---- The ordinary case ---------------------------------------------------------------------

test('two different leaders take the two badges', () => {
  const result = awardSocialBadges({
    championId: 'carol',
    voice: [row('alice', { voice: 300 }), row('bob', { voice: 120 })],
    text: [row('bob', { text: 90 }), row('alice', { text: 40 })],
  });
  assert.equal(holder(result.bard), 'alice');
  assert.equal(holder(result.scribe), 'bob');
  assert.equal(result.alsoTopped.size, 0, 'nobody was passed over');
});

test('with no champion the badges still go to the two board leaders', () => {
  const result = awardSocialBadges({
    championId: null,
    voice: [row('alice', { voice: 300 })],
    text: [row('bob', { text: 90 })],
  });
  assert.equal(holder(result.bard), 'alice');
  assert.equal(holder(result.scribe), 'bob');
});

test('empty boards leave both badges unclaimed', () => {
  const result = awardSocialBadges({ championId: 'carol' });
  assert.equal(result.bard, null);
  assert.equal(result.scribe, null);
  assert.equal(result.alsoTopped.size, 0);
});

// ---- One member, one badge -----------------------------------------------------------------

test('the champion does not also take Bard — it passes down, and the recap is told', () => {
  const result = awardSocialBadges({
    championId: 'alice',
    voice: [row('alice', { voice: 400 }), row('bob', { voice: 200 })],
    text: [row('carol', { text: 70 })],
  });
  assert.equal(holder(result.bard), 'bob', 'passed down past the champion');
  assert.equal(holder(result.scribe), 'carol');
  assert.deepEqual(result.alsoTopped.get('alice'), ['voice'],
    'she genuinely topped voice and should not be written out of the result');
});

test('topping both boards wins one badge and a mention of the other', () => {
  const result = awardSocialBadges({
    championId: 'carol',
    voice: [row('alice', { voice: 300 }), row('bob', { voice: 100 })],
    text: [row('alice', { text: 200 }), row('bob', { text: 80 })],
  });
  assert.equal(holder(result.bard), 'alice', 'voice is settled first');
  assert.equal(holder(result.scribe), 'bob', 'so text passes down');
  assert.deepEqual(result.alsoTopped.get('alice'), ['text']);
});

test('a single member topping everything collects one badge and two mentions', () => {
  const result = awardSocialBadges({
    championId: 'alice',
    voice: [row('alice', { voice: 300 })],
    text: [row('alice', { text: 300 })],
  });
  assert.equal(result.bard, null, 'nobody else was eligible');
  assert.equal(result.scribe, null);
  assert.deepEqual(result.alsoTopped.get('alice'), ['voice', 'text']);
});

test('pass-down walks past every member who already holds something', () => {
  const result = awardSocialBadges({
    championId: 'alice',
    voice: [row('alice', { voice: 500 }), row('bob', { voice: 400 })],
    text: [
      row('alice', { text: 300 }), row('bob', { text: 200 }),
      row('carol', { text: 100 }),
    ],
  });
  assert.equal(holder(result.bard), 'bob');
  assert.equal(holder(result.scribe), 'carol', 'alice and bob are both spoken for');
  assert.deepEqual(result.alsoTopped.get('alice'), ['voice', 'text']);
});

test('a badge goes unclaimed when everyone eligible already holds one', () => {
  const result = awardSocialBadges({
    championId: 'alice',
    voice: [row('bob', { voice: 200 })],
    text: [row('alice', { text: 300 }), row('bob', { text: 250 })],
  });
  assert.equal(holder(result.bard), 'bob');
  assert.equal(result.scribe, null, 'only alice and bob typed, and both are taken');
  assert.deepEqual(result.alsoTopped.get('alice'), ['text']);
});

// ---- Floors --------------------------------------------------------------------------------

test('a leader below the floor leaves the badge unclaimed rather than being crowned', () => {
  const result = awardSocialBadges({
    voice: [row('alice', { voice: 4 }), row('bob', { voice: 2 })],
    voiceFloorMinutes: 60,
  });
  assert.equal(result.bard, null, 'four minutes is not a Bard');
  assert.equal(result.alsoTopped.size, 0, 'nobody topped a board nobody qualified for');
});

test('pass-down stops at the floor instead of sliding to a token contribution', () => {
  const result = awardSocialBadges({
    championId: 'alice',
    voice: [row('alice', { voice: 300 }), row('bob', { voice: 3 })],
    voiceFloorMinutes: 60,
  });
  assert.equal(result.bard, null, 'bob is nowhere near the bar');
  assert.deepEqual(result.alsoTopped.get('alice'), ['voice']);
});

test('the two boards carry their own floors', () => {
  const result = awardSocialBadges({
    voice: [row('alice', { voice: 45 })],
    text: [row('bob', { text: 45 })],
    voiceFloorMinutes: 60,
    textFloorMinutes: 30,
  });
  assert.equal(result.bard, null, '45 minutes of voice is under an hour');
  assert.equal(holder(result.scribe), 'bob', '45 active minutes of typing is a heavy week');
});

test('a floor of zero still refuses a member with nothing', () => {
  const result = awardSocialBadges({
    voice: [row('alice', { voice: 0 })],
    voiceFloorMinutes: 0,
  });
  assert.equal(result.bard, null);
});

test('exactly the floor qualifies', () => {
  const result = awardSocialBadges({
    voice: [row('alice', { voice: 60 })],
    voiceFloorMinutes: 60,
  });
  assert.equal(holder(result.bard), 'alice');
});

// ---- Robustness ----------------------------------------------------------------------------

test('rows handed over out of order are ranked before anything is decided', () => {
  const result = awardSocialBadges({
    voice: [row('bob', { voice: 100 }), row('alice', { voice: 300 })],
  });
  assert.equal(holder(result.bard), 'alice', 'the leader is the leader whatever order they arrive in');
});

test('a tie is broken by id, so the same week never awards two different answers', () => {
  const once = awardSocialBadges({ voice: [row('bob', { voice: 100 }), row('alice', { voice: 100 })] });
  const twice = awardSocialBadges({ voice: [row('alice', { voice: 100 }), row('bob', { voice: 100 })] });
  assert.equal(holder(once.bard), 'alice');
  assert.equal(holder(once.bard), holder(twice.bard));
});

test('the awarded row carries both metrics, so the recap can show the split', () => {
  const result = awardSocialBadges({ voice: [row('alice', { voice: 300, text: 25 })] });
  assert.equal(result.bard.voice_minutes, 300);
  assert.equal(result.bard.text_minutes, 25);
});

test('a missing metric counts as zero rather than throwing', () => {
  const result = awardSocialBadges({ voice: [{ user_id: 'alice' }] });
  assert.equal(result.bard, null);
});

test('called with nothing at all it returns an empty result', () => {
  const result = awardSocialBadges();
  assert.deepEqual({ bard: result.bard, scribe: result.scribe }, { bard: null, scribe: null });
  assert.equal(result.alsoTopped.size, 0);
});

test('the caller\'s arrays are not reordered underneath them', () => {
  const voice = [row('bob', { voice: 100 }), row('alice', { voice: 300 })];
  awardSocialBadges({ voice });
  assert.deepEqual(voice.map((r) => r.user_id), ['bob', 'alice']);
});
