import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, T0, MINUTE, DAY } from './helpers.js';
import { shouldRecordMessage, isSociallyTracked, recordMessage } from '../src/socialTracking.js';

const GUILD = 'g1';
const A = 'alice';

/** The only fields of a discord.js Message this path ever looks at. */
function message({ guildId = GUILD, userId = A, bot = false, system = false } = {}) {
  return { guildId, author: { id: userId, bot }, system };
}

const textMinutes = (db, userId = A) => db.getSocialTotals(GUILD, userId, T0, T0 + DAY).text_minutes;

// ---- What counts -------------------------------------------------------------------------

test('an ordinary guild message from a human counts', () => {
  assert.equal(shouldRecordMessage(message()), true);
});

test('bots and webhooks do not count', () => {
  assert.equal(shouldRecordMessage(message({ bot: true })), false);
});

test('direct messages do not count — there is no guild to credit', () => {
  assert.equal(shouldRecordMessage(message({ guildId: null })), false);
});

test('system messages do not count, so joining is not worth a text minute', () => {
  // Discord attributes "X joined the server" to the member as author.
  assert.equal(shouldRecordMessage(message({ system: true })), false);
});

test('a malformed message is refused rather than throwing', () => {
  assert.equal(shouldRecordMessage(undefined), false);
  assert.equal(shouldRecordMessage({}), false);
  assert.equal(shouldRecordMessage({ guildId: GUILD }), false, 'no author');
});

// ---- Recording ---------------------------------------------------------------------------

test('a counted message buys its minute', () => {
  const { db, cleanup } = tempDatabase();
  try {
    assert.equal(recordMessage(db, message(), T0), true);
    assert.equal(textMinutes(db), 1);
  } finally { cleanup(); }
});

test('volume inside one minute is worth nothing', () => {
  const { db, cleanup } = tempDatabase();
  try {
    for (let i = 0; i < 50; i += 1) recordMessage(db, message(), T0 + i);
    assert.equal(textMinutes(db), 1, 'fifty messages, one minute');
  } finally { cleanup(); }
});

test('minutes accumulate across separate minutes', () => {
  const { db, cleanup } = tempDatabase();
  try {
    recordMessage(db, message(), T0);
    recordMessage(db, message(), T0 + MINUTE);
    recordMessage(db, message(), T0 + 2 * MINUTE);
    assert.equal(textMinutes(db), 3);
  } finally { cleanup(); }
});

test('an excluded message records nothing at all', () => {
  const { db, cleanup } = tempDatabase();
  try {
    assert.equal(recordMessage(db, message({ bot: true }), T0), false);
    assert.equal(recordMessage(db, message({ system: true }), T0), false);
    assert.equal(recordMessage(db, message({ guildId: null }), T0), false);
    assert.equal(textMinutes(db), 0);
  } finally { cleanup(); }
});

test('an opted-out member is not recorded', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.optOut(GUILD, A, T0);
    assert.equal(recordMessage(db, message(), T0), false);
    assert.equal(textMinutes(db), 0);
  } finally { cleanup(); }
});

test('opting back in resumes recording', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.optOut(GUILD, A, T0);
    recordMessage(db, message(), T0);
    db.optIn(GUILD, A);
    assert.equal(recordMessage(db, message(), T0 + MINUTE), true);
    assert.equal(textMinutes(db), 1);
  } finally { cleanup(); }
});

test('the opt-out gate is scoped to the guild the message was sent in', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.optOut('g2', A, T0);
    assert.equal(isSociallyTracked(db, GUILD, A), true);
    assert.equal(isSociallyTracked(db, 'g2', A), false);
    assert.equal(recordMessage(db, message(), T0), true, 'opting out of one server does not mute another');
  } finally { cleanup(); }
});

test('messages credit the guild they were sent in', () => {
  const { db, cleanup } = tempDatabase();
  try {
    recordMessage(db, message({ guildId: 'g2' }), T0);
    assert.equal(textMinutes(db), 0);
    assert.equal(db.getSocialTotals('g2', A, T0, T0 + DAY).text_minutes, 1);
  } finally { cleanup(); }
});
