import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// embeds.js reaches config.js, which throws at import when DISCORD_TOKEN is missing — and CI runs
// with no .env at all. Set one first, then pull the module in dynamically so the assignment is
// guaranteed to happen before the graph loads. dotenv leaves an existing value alone, so a real
// local .env still wins.
process.env.DISCORD_TOKEN ??= 'test-token';
const { buildRecapEmbed, ordinal } = await import('../src/embeds.js');

const RANGE = { title: 'Gamer of the Week', periodNoun: 'week' };
const NAMES = new Map([['alice', 'Alice']]);

const recap = (overrides = {}) => ({
  range: RANGE,
  winner: {
    userId: 'alice',
    totalSeconds: 5 * 3600,
    gamesPlayed: 3,
    topGame: null,
    topGameSeconds: 0,
    achievements: [],
    ...overrides,
  },
});

const build = (options = {}) =>
  buildRecapEmbed(recap(), { displayNames: NAMES, avatarUrl: null, ...options }).data;

describe('ordinal', () => {
  test('the ordinary cases take their suffix from the last digit', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 9].map(ordinal), ['1st', '2nd', '3rd', '4th', '5th', '9th']);
  });

  test('the teens are all th, which the last-digit rule alone gets wrong', () => {
    assert.deepEqual([11, 12, 13].map(ordinal), ['11th', '12th', '13th']);
  });

  test('past twenty the last digit rules again', () => {
    assert.deepEqual([20, 21, 22, 23, 24].map(ordinal), ['20th', '21st', '22nd', '23rd', '24th']);
  });

  test('the teens exception repeats every century, and only for the teens', () => {
    assert.deepEqual([111, 112, 113].map(ordinal), ['111th', '112th', '113th']);
    assert.deepEqual([101, 102, 103].map(ordinal), ['101st', '102nd', '103rd']);
  });
});

describe('the recap card', () => {
  test('a first win says nothing about being a first win', () => {
    const embed = build({ winNumber: 1 });
    assert.match(embed.description, /5h/);
    assert.doesNotMatch(embed.description, /taking the title/);
  });

  test('an omitted win number reads as a first win', () => {
    assert.doesNotMatch(build().description, /taking the title/);
  });

  test('a repeat win is called out by its ordinal', () => {
    assert.match(build({ winNumber: 3 }).description, /3rd time\*\* taking the title/);
  });

  test('the ordinal is rendered, not concatenated — the teens prove it', () => {
    assert.match(build({ winNumber: 11 }).description, /11th time/);
  });

  test('the playtime sentence survives alongside it', () => {
    const embed = build({ winNumber: 2 });
    assert.match(embed.description, /across \*\*3\*\* different games last week/);
    assert.match(embed.description, /2nd time/);
  });
});
