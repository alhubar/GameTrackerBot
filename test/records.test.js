import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, playSession, HOUR, MINUTE, T0 } from './helpers.js';
import { buildServerRecords, recordsAsFields, recordsAsLines } from '../src/records.js';
import { COUNTS_AS_PLAYED_SECONDS } from '../src/achievements.js';

/**
 * Server records: whoever holds each one right now, computed on read.
 *
 * Two things here are load-bearing. Each record is returned as parts rather than a finished string,
 * because the card renders one embed field per record and /server renders a bold heading — and a
 * game name comes from Rich Presence, so it is unbounded and full of characters escapeMarkdown
 * doubles. Clipping has to happen before escaping or the limit counts backslashes, and an embed
 * field Discord rejects takes the whole card down with it.
 */

const GUILD = 'guild-1';

let db;
let cleanup;
beforeEach(() => { ({ db, cleanup } = tempDatabase()); });
afterEach(() => cleanup());

/** Only .members.fetch(id) is touched: `null` for anybody the guild no longer has. */
const fakeGuild = (names = {}) => ({
  id: GUILD,
  members: {
    fetch: async (id) => {
      if (!(id in names)) throw new Error('unknown member');
      return { id, displayName: names[id] };
    },
  },
});

const byLabel = (records, label) => records.find((record) => record.label === label);

describe('which records are set', () => {
  test('a server with no history has no records at all', async () => {
    // An empty array, not placeholders: both surfaces skip the section entirely.
    assert.deepEqual(await buildServerRecords(db, fakeGuild()), []);
  });

  test('the longest session names its holder, its length and its game', async () => {
    playSession(db, GUILD, 'alice', 'Hades', T0, 3 * HOUR);
    playSession(db, GUILD, 'bob', 'Celeste', T0, 5 * HOUR);
    const record = byLabel(await buildServerRecords(db, fakeGuild({ alice: 'Alice', bob: 'Bob' })), 'Longest session');
    assert.equal(record.emoji, '⏱️');
    assert.equal(record.detail, '└ Bob — **5h** in Celeste');
  });

  test('one player is not a gaming group', async () => {
    playSession(db, GUILD, 'alice', 'Hades', T0, 2 * HOUR);
    assert.equal(byLabel(await buildServerRecords(db, fakeGuild({ alice: 'Alice' })), 'Largest gaming group'), undefined);
  });

  test('the largest group counts the players who put real time in', async () => {
    for (const id of ['alice', 'bob', 'carol']) playSession(db, GUILD, id, 'Hades', T0, COUNTS_AS_PLAYED_SECONDS * 1000);
    // Under the bar, so this one does not join the group — launching something is not playing it.
    playSession(db, GUILD, 'dave', 'Hades', T0, 5 * MINUTE);
    const record = byLabel(await buildServerRecords(db, fakeGuild()), 'Largest gaming group');
    assert.equal(record.emoji, '👥');
    assert.equal(record.detail, '└ Hades — **3 players**');
  });

  test('the collection record uses the same one-hour bar as the ladder', async () => {
    playSession(db, GUILD, 'alice', 'Hades', T0, COUNTS_AS_PLAYED_SECONDS * 1000);
    playSession(db, GUILD, 'alice', 'Celeste', T0, 30 * MINUTE);
    playSession(db, GUILD, 'alice', 'Tunic', T0, 20 * MINUTE);
    const record = byLabel(await buildServerRecords(db, fakeGuild({ alice: 'Alice' })), 'Most games by one player');
    assert.equal(record.emoji, '🕹️');
    assert.equal(record.detail, '└ Alice — **1**');
  });

  test('a member with nothing over the bar sets no collection record', async () => {
    playSession(db, GUILD, 'alice', 'Hades', T0, 30 * MINUTE);
    assert.equal(byLabel(await buildServerRecords(db, fakeGuild({ alice: 'Alice' })), 'Most games by one player'), undefined);
  });

  test('records read in a fixed order, so the card sections never shuffle', async () => {
    for (const id of ['alice', 'bob']) playSession(db, GUILD, id, 'Hades', T0, 2 * HOUR);
    const records = await buildServerRecords(db, fakeGuild({ alice: 'Alice', bob: 'Bob' }));
    assert.deepEqual(records.map((record) => record.label),
      ['Longest session', 'Largest gaming group', 'Most games by one player']);
  });

  test('opted-out members hold no records', async () => {
    playSession(db, GUILD, 'quiet', 'Hades', T0, 9 * HOUR);
    db.optOut(GUILD, 'quiet', T0);
    assert.deepEqual(await buildServerRecords(db, fakeGuild({ quiet: 'Quiet' })), []);
  });

  test('a holder who has left the guild still holds it, under a neutral name', async () => {
    playSession(db, GUILD, 'gone', 'Hades', T0, 2 * HOUR);
    const record = byLabel(await buildServerRecords(db, fakeGuild()), 'Longest session');
    assert.match(record.detail, /^└ Former member — /);
  });
});

describe('clipping long names', () => {
  test('a game name is clipped before it is escaped, not after', async () => {
    // 200 markdown characters. Clipping first leaves 59 visible ones and an ellipsis; escaping
    // first would spend most of the budget on backslashes and clip the visible name to a fraction
    // of that. Undo the escaping to compare what a member would actually read.
    playSession(db, GUILD, 'alice', '*'.repeat(200), T0, 2 * HOUR);
    const record = byLabel(await buildServerRecords(db, fakeGuild({ alice: 'Alice' })), 'Longest session');
    const visible = record.detail.replace(/\\(.)/g, '$1');
    assert.equal(visible, `└ Alice — **2h** in ${'*'.repeat(59)}…`);
  });

  test('a name that fits is left exactly as it is', async () => {
    playSession(db, GUILD, 'alice', 'Hades', T0, 2 * HOUR);
    const record = byLabel(await buildServerRecords(db, fakeGuild({ alice: 'Alice' })), 'Longest session');
    assert.equal(record.detail, '└ Alice — **2h** in Hades');
  });

  test('a display name gets the same treatment as a game name', async () => {
    playSession(db, GUILD, 'alice', 'Hades', T0, 2 * HOUR);
    const record = byLabel(await buildServerRecords(db, fakeGuild({ alice: 'A'.repeat(200) })), 'Longest session');
    assert.ok(record.detail.startsWith(`└ ${'A'.repeat(59)}…`));
  });

  test('every rendered field stays inside the 1024 characters Discord allows', async () => {
    playSession(db, GUILD, 'alice', '*'.repeat(500), T0, 2 * HOUR);
    playSession(db, GUILD, 'bob', '*'.repeat(500), T0, 2 * HOUR);
    const records = await buildServerRecords(db, fakeGuild({ alice: '_'.repeat(500), bob: 'Bob' }));
    for (const field of recordsAsFields(records)) {
      assert.ok(field.value.length <= 1024, `field "${field.name}" is ${field.value.length} characters`);
      assert.ok(field.name.length <= 256);
    }
  });
});

describe('rendering the same records two ways', () => {
  const RECORDS = [
    { emoji: '⏱️', label: 'Longest session', detail: '└ Alice — **5h** in Hades' },
    { emoji: '👥', label: 'Largest gaming group', detail: '└ Hades — **3 players**' },
  ];

  test('the card gets one field per record, never one field for all of them', () => {
    // A single wrapper field needs a name, and even a zero-width space occupies its own line —
    // which rendered as a blank gap the sections around it do not have.
    assert.deepEqual(recordsAsFields(RECORDS), [
      { name: '⏱️ Longest session', value: '└ Alice — **5h** in Hades', inline: false },
      { name: '👥 Largest gaming group', value: '└ Hades — **3 players**', inline: false },
    ]);
  });

  test('/server gets a bold heading and its detail line, matching the sections around it', () => {
    assert.deepEqual(recordsAsLines(RECORDS), [
      '⏱️ **Longest session**',
      '└ Alice — **5h** in Hades',
      '👥 **Largest gaming group**',
      '└ Hades — **3 players**',
    ]);
  });

  test('nothing set renders as nothing at all, on both surfaces', () => {
    assert.deepEqual(recordsAsFields([]), []);
    assert.deepEqual(recordsAsLines([]), []);
  });
});
