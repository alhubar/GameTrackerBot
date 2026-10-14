import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// embeds.js reaches config.js, which throws at import when DISCORD_TOKEN is missing — and CI runs
// with no .env at all. Set one first, then pull the module in dynamically so the assignment is
// guaranteed to happen before the graph loads. dotenv leaves an existing value alone, so a real
// local .env still wins.
process.env.DISCORD_TOKEN ??= 'test-token';
const { buildRecapEmbed, buildRestPeriodEmbed, ordinal } = await import('../src/embeds.js');

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

describe('the runners-up field', () => {
  const PODIUM_NAMES = new Map([['alice', 'Alice'], ['bob', 'Bob'], ['cleo', 'Cleo'], ['dan', 'Dan']]);
  const withPodium = (podium, names = PODIUM_NAMES) =>
    buildRecapEmbed({ ...recap(), podium }, { displayNames: names, avatarUrl: null }).data;
  const closeBehind = (embed) => embed.fields.find((field) => field.name.includes('Close behind'));

  const FULL_PODIUM = [
    { userId: 'alice', totalSeconds: 5 * 3600 },
    { userId: 'bob', totalSeconds: 4 * 3600 + 30 * 60 },
    { userId: 'cleo', totalSeconds: 2 * 3600 },
  ];

  test('the other two are named with their time', () => {
    const field = closeBehind(withPodium(FULL_PODIUM));
    assert.equal(field.value, '**Bob** — 4h 30m\n**Cleo** — 2h');
  });

  test('it sits inline, so it completes the row rather than starting one', () => {
    assert.equal(closeBehind(withPodium(FULL_PODIUM)).inline, true);
  });

  test('the winner is not listed under their own card', () => {
    assert.doesNotMatch(closeBehind(withPodium(FULL_PODIUM)).value, /Alice/);
  });

  test('a runner-up the caller could not name is dropped, not shown as Unknown member', () => {
    const field = closeBehind(withPodium(FULL_PODIUM, new Map([['alice', 'Alice'], ['cleo', 'Cleo']])));
    assert.equal(field.value, '**Cleo** — 2h');
    assert.doesNotMatch(field.value, /Unknown member/);
  });

  test('a period the winner played alone omits the field entirely', () => {
    assert.equal(closeBehind(withPodium([FULL_PODIUM[0]])), undefined);
  });

  test('a podium of nobody but unnameable members omits it too', () => {
    const embed = withPodium(FULL_PODIUM, new Map([['alice', 'Alice']]));
    assert.equal(closeBehind(embed), undefined);
  });

  test('a recap built without a podium at all still renders', () => {
    const embed = buildRecapEmbed(recap(), { displayNames: NAMES, avatarUrl: null }).data;
    assert.equal(closeBehind(embed), undefined);
    assert.equal(embed.title, 'Alice');
  });

  test('a deeper podium is capped, so the field cannot outgrow the two beside it', () => {
    const field = closeBehind(withPodium([...FULL_PODIUM, { userId: 'dan', totalSeconds: 3600 }]));
    assert.equal(field.value.split('\n').length, 2);
    assert.doesNotMatch(field.value, /Dan/);
  });
});

describe('the rest card', () => {
  const card = (options = {}) => buildRestPeriodEmbed(RANGE, options).data;

  test('it says why there are no badges, so it does not read as the bot breaking', () => {
    const data = card();
    assert.equal(data.title, '🛌 Rest week');
    assert.match(data.description, /everybody wears their own rank for a week/);
  });

  test('with one rest period it says the week now running counts', () => {
    assert.match(card({ restPeriods: 1 }).description, /This week counts again for everyone/);
  });

  test('with longer rests it does not promise which week counts', () => {
    const { description } = card({ restPeriods: 2 });
    assert.doesNotMatch(description, /This week counts/);
    assert.match(description, /once the rest is over/);
  });

  test('new Cave Dwellers are still named, since that badge keeps running', () => {
    const data = card({
      displayNames: new Map([['bob', 'Bob']]),
      caveDwellerRoleName: 'Cave Dweller',
      caveDwellerIds: ['bob'],
    });
    assert.equal(data.fields.length, 1);
    assert.match(data.fields[0].value, /\*\*Bob\*\*/);
  });

  test('no Cave Dweller field when the badge is off or nobody new arrived', () => {
    assert.equal(card({ caveDwellerRoleName: null, caveDwellerIds: ['bob'] }).fields, undefined);
    assert.equal(card({ caveDwellerRoleName: 'Cave Dweller', caveDwellerIds: [] }).fields, undefined);
  });
});
