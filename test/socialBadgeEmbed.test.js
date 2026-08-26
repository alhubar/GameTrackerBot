import test from 'node:test';
import assert from 'node:assert/strict';

// embeds.js reaches config.js, which throws at import when DISCORD_TOKEN is missing — and CI runs
// with no .env at all. Set one first, then pull the module in dynamically so the assignment is
// guaranteed to happen before the graph loads. dotenv leaves an existing value alone, so a real
// local .env still wins.
process.env.DISCORD_TOKEN ??= 'test-token';
const { buildSocialBadgeEmbeds } = await import('../src/embeds.js');
const { BARD_ROLE_COLOR, SCRIBE_ROLE_COLOR, CAVE_DWELLER_ROLE_COLOR } = await import('../src/roles.js');

const RANGE = { periodNoun: 'week' };
const NAMES = new Map([['alice', 'Alice'], ['bob', 'Bob'], ['carol', 'Carol']]);

const row = (userId, { voice = 0, text = 0 } = {}) =>
  ({ user_id: userId, voice_minutes: voice, text_minutes: text });

const build = (awards, options = {}) => buildSocialBadgeEmbeds(
  { alsoTopped: new Map(), ...awards },
  {
    displayNames: NAMES,
    range: RANGE,
    bardRoleName: 'Bard',
    scribeRoleName: 'Scribe',
    bardFloorMinutes: 60,
    scribeFloorMinutes: 30,
    ...options,
  },
).map((embed) => embed.data);

/** The card whose heading names this badge. */
const card = (cards, name) => cards.find((entry) => entry.author?.name.includes(name));

// ---- One card per badge ----------------------------------------------------------------------

test('each badge is its own card, in its own role colour', () => {
  const cards = build({
    bard: row('alice', { voice: 312 }),
    scribe: row('bob', { text: 90 }),
  }, { caveDwellerRoleName: 'Cave Dwellers', caveDwellerIds: ['carol'] });

  assert.equal(cards.length, 3, 'one card each, not one card with three fields');
  assert.equal(card(cards, 'Bard').color, BARD_ROLE_COLOR);
  assert.equal(card(cards, 'Scribe').color, SCRIBE_ROLE_COLOR);
  assert.equal(card(cards, 'Cave Dwellers').color, CAVE_DWELLER_ROLE_COLOR);
});

test('a card names its holder and says what it was for', () => {
  const cards = build({ bard: row('alice', { voice: 312 }), scribe: row('bob', { text: 90 }) });
  assert.match(card(cards, 'Bard').description, /Awarded to \*\*Alice\*\* for speaking a lot/);
  assert.match(card(cards, 'Bard').description, /\*\*5h 12m\*\* in voice/);
  assert.match(card(cards, 'Scribe').description, /Awarded to \*\*Bob\*\* for writing more than most/);
  assert.match(card(cards, 'Scribe').description, /\*\*1h 30m\*\* in chat/);
});

test('both badges read as durations, so the cards share one unit', () => {
  const cards = build({ bard: row('alice', { voice: 61 }), scribe: row('bob', { text: 61 }) });
  assert.match(card(cards, 'Bard').description, /\*\*1h 1m\*\* in voice/);
  assert.match(card(cards, 'Scribe').description, /\*\*1h 1m\*\* in chat/);
});

test('only the last card carries the footer', () => {
  const cards = build({ bard: row('alice', { voice: 90 }), scribe: row('bob', { text: 40 }) });
  assert.equal(card(cards, 'Bard').footer, undefined);
  assert.match(cards[cards.length - 1].footer.text, /Held until next week's recap/);
});

// ---- Unclaimed -------------------------------------------------------------------------------

test('an unclaimed badge still gets a card, naming the bar it missed', () => {
  const cards = build({ bard: null, scribe: row('bob', { text: 90 }) });
  assert.match(card(cards, 'Bard').description, /Unclaimed/);
  assert.match(card(cards, 'Bard').description, /Nobody reached 1h in voice/);
});

test('an unclaimed badge with no floor set still reads as unclaimed', () => {
  const cards = build({ bard: null }, { bardFloorMinutes: 0 });
  assert.match(card(cards, 'Bard').description, /Unclaimed/);
  assert.match(card(cards, 'Bard').description, /nobody qualified/);
});

// ---- Passed over -----------------------------------------------------------------------------

test('a passed-over leader is explained on the card they did not get', () => {
  const cards = build({
    bard: row('bob', { voice: 200 }),
    alsoTopped: new Map([['alice', ['voice']]]),
  });
  assert.match(card(cards, 'Bard').description, /\*\*Bob\*\*/);
  assert.match(card(cards, 'Bard').description, /Alice topped voice, but already wears another badge/);
});

test('the explanation lands on the right card when somebody topped both', () => {
  const cards = build({
    bard: row('alice', { voice: 300 }),
    scribe: row('bob', { text: 80 }),
    alsoTopped: new Map([['alice', ['text']]]),
  });
  assert.doesNotMatch(card(cards, 'Bard').description, /topped/, 'she was given voice, so nothing to explain');
  assert.match(card(cards, 'Scribe').description, /Alice topped text/);
});

test('a holder is never told they were passed over for their own badge', () => {
  const cards = build({
    bard: row('alice', { voice: 300 }),
    alsoTopped: new Map([['alice', ['voice']]]),
  });
  assert.doesNotMatch(card(cards, 'Bard').description, /but already wears/);
});

// ---- Cave Dwellers ---------------------------------------------------------------------------

test('cave dwellers are named', () => {
  const cards = build({}, { caveDwellerRoleName: 'Cave Dwellers', caveDwellerIds: ['bob', 'carol'] });
  assert.match(card(cards, 'Cave Dwellers').description,
    /\*\*Bob\*\*, \*\*Carol\*\* watching from the shadows/);
});

test('a week where everybody turned up produces no cave dweller card', () => {
  const cards = build({ bard: row('alice', { voice: 90 }) }, {
    caveDwellerRoleName: 'Cave Dwellers', caveDwellerIds: [],
  });
  assert.equal(card(cards, 'Cave Dwellers'), undefined);
});

test('a long list is trimmed rather than overflowing the card', () => {
  const many = Array.from({ length: 30 }, (_, i) => `ghost-${i}`);
  const cards = build({}, { caveDwellerRoleName: 'Cave Dwellers', caveDwellerIds: many });
  const { description } = card(cards, 'Cave Dwellers');
  assert.match(description, /and 22 more/);
  assert.ok(description.length < 4096, 'stays inside the description cap');
});

// ---- Nothing to say --------------------------------------------------------------------------

test('a disabled badge produces no card at all', () => {
  const cards = build({ scribe: row('bob', { text: 90 }) }, { bardRoleName: null });
  assert.equal(cards.length, 1);
  assert.ok(card(cards, 'Scribe'));
});

test('with nothing configured there are no cards', () => {
  assert.deepEqual(buildSocialBadgeEmbeds(
    { bard: null, scribe: null, alsoTopped: new Map() },
    { displayNames: NAMES, range: RANGE, bardRoleName: null, scribeRoleName: null },
  ), []);
});

test('a custom role name is used as the card heading', () => {
  const cards = build({ bard: row('alice', { voice: 90 }) }, { bardRoleName: 'Yapper' });
  assert.ok(card(cards, 'Yapper'));
});

test('an unknown member degrades rather than throwing', () => {
  const cards = build({ bard: row('nobody-cached', { voice: 90 }) });
  assert.match(card(cards, 'Bard').description, /Unknown member/);
});

test('a missing alsoTopped map is tolerated', () => {
  const embeds = buildSocialBadgeEmbeds(
    { bard: row('alice', { voice: 90 }), scribe: null },
    { displayNames: NAMES, range: RANGE, bardRoleName: 'Bard', scribeRoleName: 'Scribe' },
  );
  assert.ok(embeds.length);
});

// ---- End to end ------------------------------------------------------------------------------
// Real rows out of the real query, through the real award pass, into the real renderer. The three
// agree on a row shape only by convention, and a renamed column would otherwise fail in Discord
// rather than here.

const { tempDatabase, T0, MINUTE, DAY } = await import('./helpers.js');
const { awardSocialBadges } = await import('../src/socialBadges.js');

const GUILD = 'g1';

test('a week of real activity produces the cards the recap posts', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.creditVoiceMinutes(GUILD, 'alice', 300, 240, T0);
    db.creditVoiceMinutes(GUILD, 'bob', 120, 240, T0);
    for (let i = 0; i < 40; i += 1) db.recordTextMinute(GUILD, 'carol', T0 + i * MINUTE);

    const window = [T0, T0 + DAY];
    const awards = awardSocialBadges({
      championId: 'alice',
      voice: db.getSocialLeaderboard(GUILD, ...window, 'voice', 25),
      text: db.getSocialLeaderboard(GUILD, ...window, 'text', 25),
      voiceFloorMinutes: 60,
      textFloorMinutes: 30,
    });
    assert.equal(awards.bard.user_id, 'bob', 'alice is champion, so voice passes down');
    assert.equal(awards.scribe.user_id, 'carol');

    const cards = buildSocialBadgeEmbeds(awards, {
      displayNames: NAMES, range: RANGE,
      bardRoleName: 'Bard', scribeRoleName: 'Scribe',
      bardFloorMinutes: 60, scribeFloorMinutes: 30,
    }).map((embed) => embed.data);
    assert.match(card(cards, 'Bard').description, /\*\*Bob\*\*/);
    assert.match(card(cards, 'Bard').description, /\*\*2h\*\* in voice/);
    assert.match(card(cards, 'Bard').description, /Alice topped voice/);
    assert.match(card(cards, 'Scribe').description, /\*\*40m\*\* in chat/);
  } finally { cleanup(); }
});

test('the cap is applied on the way in, not on display', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.creditVoiceMinutes(GUILD, 'alice', 900, 240, T0);
    const awards = awardSocialBadges({
      voice: db.getSocialLeaderboard(GUILD, T0, T0 + DAY, 'voice', 25),
      voiceFloorMinutes: 60,
    });
    assert.equal(awards.bard.voice_minutes, 240);
    const cards = buildSocialBadgeEmbeds(awards, {
      displayNames: NAMES, range: RANGE, bardRoleName: 'Bard', scribeRoleName: null,
    }).map((embed) => embed.data);
    assert.match(card(cards, 'Bard').description, /\*\*4h\*\* in voice/);
  } finally { cleanup(); }
});

test('an opted-out top talker never reaches the cards', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.creditVoiceMinutes(GUILD, 'alice', 300, 240, T0);
    db.creditVoiceMinutes(GUILD, 'bob', 120, 240, T0);
    db.optOut(GUILD, 'alice', T0);
    const awards = awardSocialBadges({
      voice: db.getSocialLeaderboard(GUILD, T0, T0 + DAY, 'voice', 25),
      voiceFloorMinutes: 60,
    });
    assert.equal(awards.bard.user_id, 'bob');
    assert.equal(awards.alsoTopped.size, 0, 'she is hidden entirely, not shown as passed over');
  } finally { cleanup(); }
});
