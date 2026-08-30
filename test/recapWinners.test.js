import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, T0 } from './helpers.js';

/**
 * The permanent record of who took each recap badge.
 *
 * The recap crowns somebody every period and the role moves on when the next one lands, so these
 * rows are the only place the result survives. Two properties carry the weight: re-running a period
 * corrects it rather than duplicating it — announceRecap can and does run twice over one period —
 * and the win ordinal reads the same on a re-run as it did the first time.
 */

const GUILD = 'guild-1';
const OTHER_GUILD = 'guild-2';

let harness;
let db;
beforeEach(() => { harness = tempDatabase(); db = harness.db; });
afterEach(() => harness.cleanup());

const win = (userId, periodKey, badge = 'champion', metricSeconds = 3600, now = T0) =>
  db.recordRecapWinner({ guildId: GUILD, periodKey, badge, userId, metricSeconds }, now);

describe('recording a badge', () => {
  test('a win is counted for the member who took it', () => {
    win('alice', '2026-W01');
    assert.deepEqual(db.getRecapWinCounts(GUILD, 'alice'), { champion: 1 });
    assert.equal(db.getRecapWinCount(GUILD, 'alice', 'champion'), 1);
  });

  test('a member with no wins has no badges rather than a row of zeroes', () => {
    assert.deepEqual(db.getRecapWinCounts(GUILD, 'nobody'), {});
    assert.equal(db.getRecapWinCount(GUILD, 'nobody', 'champion'), 0);
  });

  test('each badge is counted separately', () => {
    win('alice', '2026-W01', 'champion');
    win('alice', '2026-W02', 'champion');
    win('alice', '2026-W03', 'bard', 90 * 60);
    assert.deepEqual(db.getRecapWinCounts(GUILD, 'alice'), { bard: 1, champion: 2 });
  });

  test('one period holds one of each badge, and they can be different members', () => {
    win('alice', '2026-W01', 'champion');
    win('bob', '2026-W01', 'bard', 120 * 60);
    win('carol', '2026-W01', 'scribe', 40 * 60);
    const period = db.getRecapWinnersForPeriod(GUILD, '2026-W01');
    assert.equal(period.length, 3);
    assert.deepEqual(
      period.map((row) => [row.badge, row.user_id]).sort(),
      [['bard', 'bob'], ['champion', 'alice'], ['scribe', 'carol']],
    );
  });

  test('re-recording a period corrects it instead of duplicating it', () => {
    win('alice', '2026-W01', 'champion', 3600);
    win('bob', '2026-W01', 'champion', 7200, T0 + 1000);
    assert.equal(db.getRecapWinCount(GUILD, 'alice', 'champion'), 0);
    assert.equal(db.getRecapWinCount(GUILD, 'bob', 'champion'), 1);
    const [row] = db.getRecapWinnersForPeriod(GUILD, '2026-W01');
    assert.equal(row.metric_seconds, 7200);
    assert.equal(row.awarded_at, T0 + 1000);
  });

  test('negative time is clamped away rather than stored', () => {
    win('alice', '2026-W01', 'champion', -500);
    assert.equal(db.getRecapWinnersForPeriod(GUILD, '2026-W01')[0].metric_seconds, 0);
  });

  test('guilds keep their own history', () => {
    win('alice', '2026-W01');
    db.recordRecapWinner({ guildId: OTHER_GUILD, periodKey: '2026-W01', badge: 'champion', userId: 'alice' }, T0);
    assert.equal(db.getRecapWinCount(GUILD, 'alice', 'champion'), 1);
    assert.equal(db.getRecapWinCount(OTHER_GUILD, 'alice', 'champion'), 1);
  });
});

describe('the win ordinal', () => {
  test('excluding this period makes a first pass and a re-run agree', () => {
    win('alice', '2026-W01');
    win('alice', '2026-W02');
    // The third win, about to be recorded: two on record, this period not yet written.
    assert.equal(db.getRecapWinCount(GUILD, 'alice', 'champion', '2026-W03') + 1, 3);
    win('alice', '2026-W03');
    // The same question after the write, which is what a forced re-run asks.
    assert.equal(db.getRecapWinCount(GUILD, 'alice', 'champion', '2026-W03') + 1, 3);
  });

  test('a member who has never won is on their first', () => {
    assert.equal(db.getRecapWinCount(GUILD, 'newcomer', 'champion', '2026-W01') + 1, 1);
  });

  test('another badge does not raise the champion ordinal', () => {
    win('alice', '2026-W01', 'bard', 90 * 60);
    assert.equal(db.getRecapWinCount(GUILD, 'alice', 'champion', '2026-W02') + 1, 1);
  });
});

describe('the hall of fame', () => {
  test('nothing recorded means nothing to show', () => {
    assert.deepEqual(db.getHallOfFame(GUILD), []);
  });

  test('members are ranked by total badges, with the champion count breaking ties', () => {
    win('alice', '2026-W01', 'champion');
    win('alice', '2026-W02', 'champion');
    win('alice', '2026-W03', 'bard', 60 * 60);
    win('bob', '2026-W04', 'champion');
    win('bob', '2026-W05', 'bard', 60 * 60);
    win('bob', '2026-W06', 'scribe', 60 * 60);
    win('carol', '2026-W07', 'scribe', 60 * 60);

    const rows = db.getHallOfFame(GUILD);
    assert.deepEqual(rows.map((row) => row.user_id), ['alice', 'bob', 'carol']);
    // Alice and Bob are level on three badges; her two champions put her first.
    assert.deepEqual(
      rows.map((row) => [row.wins, row.champion, row.bard, row.scribe]),
      [[3, 2, 1, 0], [3, 1, 1, 1], [1, 0, 0, 1]],
    );
  });

  test('the list is capped at the limit asked for', () => {
    for (const [index, userId] of ['alice', 'bob', 'carol', 'dave'].entries()) {
      win(userId, `2026-W0${index + 1}`);
    }
    assert.equal(db.getHallOfFame(GUILD, 2).length, 2);
  });

  test('an opted-out member is hidden, exactly as they are from every other ranking', () => {
    win('alice', '2026-W01');
    win('bob', '2026-W02');
    db.optOut(GUILD, 'alice', T0);
    assert.deepEqual(db.getHallOfFame(GUILD).map((row) => row.user_id), ['bob']);
    // Hidden, not erased: opting back in restores the record untouched.
    db.optIn(GUILD, 'alice');
    assert.deepEqual(db.getHallOfFame(GUILD).map((row) => row.user_id), ['alice', 'bob']);
  });

  test('a winner in another guild never appears', () => {
    db.recordRecapWinner({ guildId: OTHER_GUILD, periodKey: '2026-W01', badge: 'champion', userId: 'stranger' }, T0);
    assert.deepEqual(db.getHallOfFame(GUILD), []);
  });
});

describe('privacy', () => {
  test('badges are declared in the stored-data summary', () => {
    win('alice', '2026-W01', 'champion');
    win('alice', '2026-W02', 'bard', 60 * 60);
    assert.equal(db.getStoredDataSummary(GUILD, 'alice').recapWins, 2);
    assert.equal(db.getStoredDataSummary(GUILD, 'bob').recapWins, 0);
  });

  test('erasing a member takes their badges with them', () => {
    win('alice', '2026-W01', 'champion');
    win('alice', '2026-W02', 'bard', 60 * 60);
    win('bob', '2026-W03', 'champion');
    const removed = db.purgeMember(GUILD, 'alice');
    assert.equal(removed.recapWins, 2);
    assert.deepEqual(db.getRecapWinCounts(GUILD, 'alice'), {});
    // The period keeps its other holders; only the erased member's rows go.
    assert.equal(db.getRecapWinCount(GUILD, 'bob', 'champion'), 1);
  });
});
