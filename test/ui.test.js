import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempDatabase, playSession, HOUR, MINUTE, T0 } from './helpers.js';

/**
 * The shared render helpers, and the two properties the boards quietly depend on.
 *
 * Departed members keep every row they earned and are hidden from the *rankings* only, which means
 * the filtering happens after the query — so the boards over-fetch, and a failed member fetch has
 * to mean "show everyone" rather than "show nobody". Both were documented in three places and
 * tested in none; a regression in either is invisible until a real server loses its leaderboard.
 */

// ranks.js freezes the ladder from the environment at import time, and the real thresholds are
// deliberately absent from every shipping file. Pin a throwaway ladder before the dynamic import
// below so these assertions describe this test and nothing else. dotenv leaves an existing value
// alone, so this still wins when a real .env is present.
process.env.RANK_NAMES = 'Bronze,Silver,Gold';
process.env.RANK_HOURS = '1,2,3';

const {
  findTextChannel, presentMemberIds, leaderboardLines, buildLeaderboardLines,
  buildMonthlyLeaderboardLines, buildServerProfileParts, buildHallOfFameLines, splitDiscordMessage,
} = await import('../src/ui.js');

const GUILD = 'guild-1';

let db;
let cleanup;
beforeEach(() => { ({ db, cleanup } = tempDatabase()); });
afterEach(() => cleanup());

/**
 * A stand-in for a discord.js Guild covering only what these helpers touch: the member cache, a
 * bulk fetch that fills it, and memberCount. `roster` is who is actually in the guild; `cached` is
 * how much of that the cache already holds, which is what decides whether a fetch happens at all.
 */
function fakeGuild({ roster = [], cached = null, fetchFails = false, memberCount = null } = {}) {
  const cache = new Map();
  const member = (id) => ({ id, displayName: `Name-${id}` });
  for (const id of cached ?? roster) cache.set(id, member(id));
  const guild = {
    id: GUILD,
    memberCount: memberCount ?? roster.length,
    fetchCalls: 0,
    members: {
      cache,
      async fetch() {
        guild.fetchCalls += 1;
        if (fetchFails) throw new Error('rate limited');
        for (const id of roster) cache.set(id, member(id));
        return cache;
      },
    },
  };
  return guild;
}

/** Rows in the shape the leaderboard statements return, highest first. */
const rows = (ids) => ids.map((id, index) => ({ user_id: id, total_seconds: (ids.length - index) * HOUR / 1000 }));

describe('findTextChannel', () => {
  const channel = (name, isTextBased = true) => ({ name, isTextBased: () => isTextBased });
  const guildWith = (...channels) => ({ channels: { cache: channels } });

  test('an unset channel name is not a lookup', () => {
    assert.equal(findTextChannel(guildWith(channel('general')), undefined), null);
    assert.equal(findTextChannel(guildWith(channel('general')), ''), null);
  });

  test('matches on the channel name, which is what .env holds', () => {
    const wanted = channel('achievements');
    assert.equal(findTextChannel(guildWith(channel('general'), wanted), 'achievements'), wanted);
  });

  test('a renamed channel silently resolves to nothing rather than throwing', () => {
    assert.equal(findTextChannel(guildWith(channel('general')), 'achievements'), null);
  });

  test('a voice channel of the same name is not a text channel', () => {
    assert.equal(findTextChannel(guildWith(channel('achievements', false)), 'achievements'), null);
  });
});

describe('presentMemberIds', () => {
  test('a complete cache answers without spending a fetch', async () => {
    const guild = fakeGuild({ roster: ['a', 'b', 'c'] });
    assert.deepEqual(await presentMemberIds(guild), new Set(['a', 'b', 'c']));
    assert.equal(guild.fetchCalls, 0);
  });

  test('an incomplete cache is filled by one bulk fetch', async () => {
    const guild = fakeGuild({ roster: ['a', 'b', 'c'], cached: ['a'] });
    assert.deepEqual(await presentMemberIds(guild), new Set(['a', 'b', 'c']));
    assert.equal(guild.fetchCalls, 1);
  });

  test('an unknown member count still fetches, rather than trusting a partial cache', async () => {
    const guild = fakeGuild({ roster: ['a', 'b'], memberCount: 0 });
    assert.deepEqual(await presentMemberIds(guild), new Set(['a', 'b']));
    assert.equal(guild.fetchCalls, 1);
  });

  test('a failed fetch is null, never an empty set', async () => {
    // The whole point: an empty set is indistinguishable from "everyone left" and would blank
    // every board on a transient API error. null means "show everyone".
    const guild = fakeGuild({ roster: ['a', 'b'], cached: [], fetchFails: true });
    assert.equal(await presentMemberIds(guild), null);
  });
});

describe('leaderboardLines', () => {
  test('no rows is null, so the caller can say so in its own words', async () => {
    assert.equal(await leaderboardLines([], fakeGuild({ roster: ['a'] })), null);
  });

  test('departed members are dropped and the places close up behind them', async () => {
    const lines = await leaderboardLines(rows(['gone', 'a', 'b']), fakeGuild({ roster: ['a', 'b'] }));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^1\. .*Name-a/);
    assert.match(lines[1], /^2\. .*Name-b/);
  });

  test('the display limit is applied after filtering, not before', async () => {
    // The over-fetch invariant: 20 candidates with the top 10 departed must still fill ten places.
    const candidates = rows(Array.from({ length: 20 }, (_, i) => `m${i}`));
    const roster = candidates.slice(10).map((row) => row.user_id);
    const lines = await leaderboardLines(candidates, fakeGuild({ roster }));
    assert.equal(lines.length, 10);
    assert.match(lines[0], /Name-m10/);
    assert.match(lines[9], /Name-m19/);
  });

  test('a failed member fetch shows everyone instead of blanking the board', async () => {
    const guild = fakeGuild({ roster: ['a', 'b'], cached: ['a'], fetchFails: true });
    const lines = await leaderboardLines(rows(['a', 'b']), guild);
    assert.equal(lines.length, 2);
    // Only 'a' is in the incomplete cache, so 'b' has no name to render — but it still has a place.
    assert.match(lines[0], /Name-a/);
    assert.match(lines[1], /Former member/);
  });

  test('a board of nothing but departed members is null, not a heading over blank space', async () => {
    assert.equal(await leaderboardLines(rows(['gone']), fakeGuild({ roster: ['a'] })), null);
  });

  test('ranks are shown by default and suppressed for the monthly board', async () => {
    const guild = fakeGuild({ roster: ['a'] });
    const [ranked] = await leaderboardLines([{ user_id: 'a', total_seconds: 2 * 3600 }], guild);
    assert.match(ranked, /\*\*Silver\*\* Name-a — \*\*2h\*\*/);
    const [plain] = await leaderboardLines([{ user_id: 'a', total_seconds: 2 * 3600 }], guild, { showRank: false });
    assert.equal(plain, '1. Name-a — **2h**');
  });

  test('a member below the first rank is Unranked rather than missing', async () => {
    const [line] = await leaderboardLines([{ user_id: 'a', total_seconds: 60 }], fakeGuild({ roster: ['a'] }));
    assert.match(line, /\*\*Unranked\*\* Name-a/);
  });

  test('the limit is configurable for the shorter boards', async () => {
    const lines = await leaderboardLines(rows(['a', 'b', 'c']), fakeGuild({ roster: ['a', 'b', 'c'] }), { limit: 2 });
    assert.equal(lines.length, 2);
  });
});

describe('buildLeaderboardLines', () => {
  test('an empty server says so rather than rendering nothing', async () => {
    assert.deepEqual(await buildLeaderboardLines(db, fakeGuild({ roster: ['a'] })), ['No tracked play time yet.']);
  });

  test('enough candidates are asked for that departures still fill ten places', async () => {
    // Fifteen members, the five longest-played of whom have left. A query for only the top ten
    // would come back with five survivors; the board must still show ten.
    const ids = Array.from({ length: 15 }, (_, i) => `m${String(i).padStart(2, '0')}`);
    ids.forEach((id, index) => playSession(db, GUILD, id, 'Game', T0, (15 - index) * HOUR));
    const lines = await buildLeaderboardLines(db, fakeGuild({ roster: ids.slice(5) }));
    assert.equal(lines.length, 10);
    assert.match(lines[0], /Name-m05/);
  });

  test('opted-out members are absent, because every ranking hides them', async () => {
    playSession(db, GUILD, 'quiet', 'Game', T0, 5 * HOUR);
    playSession(db, GUILD, 'loud', 'Game', T0, 2 * HOUR);
    db.optOut(GUILD, 'quiet', T0);
    const lines = await buildLeaderboardLines(db, fakeGuild({ roster: ['quiet', 'loud'] }));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Name-loud/);
  });
});

describe('buildMonthlyLeaderboardLines', () => {
  test('an empty month says so in its own words', async () => {
    assert.deepEqual(
      await buildMonthlyLeaderboardLines(db, fakeGuild({ roster: ['a'] })),
      ['No tracked play time yet this month.'],
    );
  });

  test('this month is counted without a rank, which is an all-time standing', async () => {
    // Anchored to the real clock, because the month boundary is read from Date.now() inside.
    const now = Date.now();
    const nowDate = new Date(now);
    const monthStart = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1);
    const startedAt = Math.max(monthStart + MINUTE, now - HOUR);
    playSession(db, GUILD, 'a', 'Game', startedAt, now - startedAt);
    const [line] = await buildMonthlyLeaderboardLines(db, fakeGuild({ roster: ['a'] }));
    assert.match(line, /^1\. Name-a — \*\*/);
    assert.doesNotMatch(line, /Bronze|Silver|Gold|Unranked/);
  });
});

describe('buildServerProfileParts', () => {
  test('a quiet server gets placeholders rather than empty sections', async () => {
    const { topGames, topPlayers } = await buildServerProfileParts(db, fakeGuild({ roster: ['a'] }));
    assert.deepEqual(topGames, ['└ No game activity recorded yet']);
    assert.deepEqual(topPlayers, ['└ No player activity recorded yet']);
  });

  test('the server total keeps departed members, the player ranking does not', async () => {
    // The deliberate asymmetry: total time is the server's history, the top three is a roster.
    playSession(db, GUILD, 'gone', 'Game', T0, 10 * HOUR);
    playSession(db, GUILD, 'here', 'Game', T0, 1 * HOUR);
    const { profile, topPlayers } = await buildServerProfileParts(db, fakeGuild({ roster: ['here'] }));
    assert.equal(profile.totalSeconds, 11 * 3600);
    assert.equal(topPlayers.length, 1);
    assert.match(topPlayers[0], /🥇 Name-here — \*\*1h\*\*/);
  });

  test('the top three fills up past departed members', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    ids.forEach((id, index) => playSession(db, GUILD, id, 'Game', T0, (6 - index) * HOUR));
    const { topPlayers } = await buildServerProfileParts(db, fakeGuild({ roster: ids.slice(3) }));
    assert.equal(topPlayers.length, 3);
    assert.match(topPlayers[0], /Name-d/);
    assert.match(topPlayers[2], /Name-f/);
  });
});

describe('buildHallOfFameLines', () => {
  const win = (userId, periodKey, badge = 'champion') =>
    db.recordRecapWinner({ guildId: GUILD, periodKey, badge, userId, metricSeconds: HOUR / 1000 }, T0);

  test('null until a badge has actually been handed out', async () => {
    assert.equal(await buildHallOfFameLines(db, fakeGuild({ roster: ['a'] })), null);
  });

  test('departed winners are kept — they did win it', async () => {
    // The opposite call from the leaderboards, and deliberate: the recap said their name at the
    // time, so the monument keeps it even though the roster no longer does.
    win('gone', '2026-W01');
    const [line] = await buildHallOfFameLines(db, fakeGuild({ roster: ['here'] }));
    assert.match(line, /🥇 Former member — \*\*1\*\* badge/);
  });

  test('each badge is broken out, in the order the recap displays them', async () => {
    win('a', '2026-W01', 'champion');
    win('a', '2026-W02', 'champion');
    win('a', '2026-W03', 'bard');
    win('a', '2026-W04', 'scribe');
    const [line] = await buildHallOfFameLines(db, fakeGuild({ roster: ['a'] }));
    assert.match(line, /Name-a — \*\*4\*\* badges · 🏆2 🎵1 ✍️1$/);
  });

  test('a badge nobody has taken is left out of the breakdown', async () => {
    win('a', '2026-W01', 'bard');
    const [line] = await buildHallOfFameLines(db, fakeGuild({ roster: ['a'] }));
    assert.match(line, /· 🎵1$/);
  });

  test('the list is capped, and medals run in order', async () => {
    for (const [index, id] of ['a', 'b', 'c', 'd'].entries()) {
      for (let win_ = 0; win_ <= 4 - index; win_++) win(id, `2026-W${win_}${index}`);
    }
    const lines = await buildHallOfFameLines(db, fakeGuild({ roster: ['a', 'b', 'c', 'd'] }));
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((line) => line.slice(2, 4)), ['🥇', '🥈', '🥉']);
    assert.equal((await buildHallOfFameLines(db, fakeGuild({ roster: ['a', 'b', 'c', 'd'] }), 2)).length, 2);
  });

  test('opted-out winners are hidden, because this part is a ranking', async () => {
    win('quiet', '2026-W01');
    db.optOut(GUILD, 'quiet', T0);
    assert.equal(await buildHallOfFameLines(db, fakeGuild({ roster: ['quiet'] })), null);
  });
});

describe('splitDiscordMessage', () => {
  test('a message inside the limit is one chunk', () => {
    assert.deepEqual(splitDiscordMessage('short'), ['short']);
  });

  test('nothing to send is nothing to split', () => {
    assert.deepEqual(splitDiscordMessage(''), []);
  });

  test('splits on the last line break before the limit', () => {
    const content = `${'a'.repeat(40)}\n${'b'.repeat(40)}`;
    assert.deepEqual(splitDiscordMessage(content, 50), ['a'.repeat(40), 'b'.repeat(40)]);
  });

  test('falls back to a space when there is no line break', () => {
    assert.deepEqual(splitDiscordMessage(`${'a'.repeat(40)} ${'b'.repeat(40)}`, 50), ['a'.repeat(40), 'b'.repeat(40)]);
  });

  test('an unbroken run is cut at the limit rather than dropped', () => {
    const chunks = splitDiscordMessage('a'.repeat(120), 50);
    assert.deepEqual(chunks.map((chunk) => chunk.length), [50, 50, 20]);
  });

  test('no chunk ever exceeds the limit, however many are needed', () => {
    const content = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(i % 30)}`).join('\n');
    const chunks = splitDiscordMessage(content);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.ok(chunk.length <= 2000, `chunk of ${chunk.length}`);
    assert.equal(chunks.join('\n').replace(/\s+/g, ' '), content.replace(/\s+/g, ' '));
  });
});
