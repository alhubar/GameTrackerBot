import test from 'node:test';
import assert from 'node:assert/strict';

// embeds.js reaches config.js, which throws at import when DISCORD_TOKEN is missing — and CI runs
// with no .env at all. Set one first, then pull the module in dynamically so the assignment is
// guaranteed to happen before the graph loads. dotenv leaves an existing value alone, so a real
// local .env still wins.
process.env.DISCORD_TOKEN ??= 'test-token';
const { buildSocialBadgesEmbed } = await import('../src/embeds.js');

const RANGE = { periodNoun: 'week' };
const NAMES = new Map([['alice', 'Alice'], ['bob', 'Bob'], ['carol', 'Carol']]);

const row = (userId, { voice = 0, text = 0 } = {}) =>
  ({ user_id: userId, voice_minutes: voice, text_minutes: text });

const build = (awards, options = {}) => buildSocialBadgesEmbed(
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
)?.data;

/** The field whose heading names this badge. */
const field = (data, name) => data.fields.find((entry) => entry.name.includes(name));

// ---- One compact row -------------------------------------------------------------------------

test('every badge is a field on one card, laid out in a single row', () => {
  const data = build({
    bard: row('alice', { voice: 312 }),
    scribe: row('bob', { text: 90 }),
  }, { caveDwellerRoleName: 'Cave Dwellers', caveDwellerIds: ['carol'] });

  assert.equal(data.fields.length, 3);
  for (const entry of data.fields) {
    assert.equal(entry.inline, true, 'inline is what puts them side by side rather than stacked');
  }
});

test('a badge names its holder and what they did', () => {
  const data = build({ bard: row('alice', { voice: 312 }), scribe: row('bob', { text: 90 }) });
  assert.match(field(data, 'Bard').value, /\*\*Alice\*\*/);
  assert.match(field(data, 'Bard').value, /5h 12m in voice/);
  assert.match(field(data, 'Scribe').value, /\*\*Bob\*\*/);
  assert.match(field(data, 'Scribe').value, /1h 30m in chat/);
});

test('both badges read as durations, so the row shares one unit', () => {
  const data = build({ bard: row('alice', { voice: 61 }), scribe: row('bob', { text: 61 }) });
  assert.match(field(data, 'Bard').value, /1h 1m in voice/);
  assert.match(field(data, 'Scribe').value, /1h 1m in chat/);
});

test('the card carries a footer once, not per badge', () => {
  const data = build({ bard: row('alice', { voice: 90 }), scribe: row('bob', { text: 40 }) });
  assert.match(data.footer.text, /Held until next week's recap/);
});

// ---- Unclaimed -------------------------------------------------------------------------------

test('an unclaimed badge keeps its field, naming the bar it missed', () => {
  const data = build({ bard: null, scribe: row('bob', { text: 90 }) });
  assert.match(field(data, 'Bard').value, /Unclaimed/);
  assert.match(field(data, 'Bard').value, /nobody reached 1h/);
});

test('an unclaimed badge with no floor set still reads as unclaimed', () => {
  const data = build({ bard: null }, { bardFloorMinutes: 0 });
  assert.match(field(data, 'Bard').value, /Unclaimed/);
  assert.match(field(data, 'Bard').value, /nobody qualified/);
});

// ---- Passed over -----------------------------------------------------------------------------

test('a passed-over leader is named on the badge they did not get', () => {
  const data = build({
    bard: row('bob', { voice: 200 }),
    alsoTopped: new Map([['alice', ['voice']]]),
  });
  assert.match(field(data, 'Bard').value, /\*\*Bob\*\*/);
  assert.match(field(data, 'Bard').value, /Alice led this/);
});

test('the note lands on the right badge when somebody topped both', () => {
  const data = build({
    bard: row('alice', { voice: 300 }),
    scribe: row('bob', { text: 80 }),
    alsoTopped: new Map([['alice', ['text']]]),
  });
  assert.doesNotMatch(field(data, 'Bard').value, /led this/, 'she was given voice, so nothing to explain');
  assert.match(field(data, 'Scribe').value, /Alice led this/);
});

test('a holder is never told they were passed over for their own badge', () => {
  const data = build({
    bard: row('alice', { voice: 300 }),
    alsoTopped: new Map([['alice', ['voice']]]),
  });
  assert.doesNotMatch(field(data, 'Bard').value, /led this/);
});

// ---- Cave Dwellers ---------------------------------------------------------------------------

test('cave dwellers are named', () => {
  const data = build({}, { caveDwellerRoleName: 'Cave Dwellers', caveDwellerIds: ['bob', 'carol'] });
  assert.match(field(data, 'Cave Dwellers').value, /\*\*Bob\*\*, \*\*Carol\*\*/);
  assert.match(field(data, 'Cave Dwellers').value, /watching from the shadows/);
});

test('a week where everybody turned up drops the field entirely', () => {
  const data = build({ bard: row('alice', { voice: 90 }) }, {
    caveDwellerRoleName: 'Cave Dwellers', caveDwellerIds: [],
  });
  assert.equal(field(data, 'Cave Dwellers'), undefined,
    'a field saying nobody was absent is a field about nothing');
});

test('a disabled cave dweller badge has no field at all', () => {
  const data = build({ bard: row('alice', { voice: 90 }) }, {
    caveDwellerRoleName: 'Cave Dwellers', caveDwellerIds: null,
  });
  assert.equal(field(data, 'Cave Dwellers'), undefined, 'null means switched off, unlike an empty list');
});

test('a long list is trimmed rather than overflowing the field', () => {
  // Discord caps a field value at 1024 characters; going over drops the whole embed.
  const many = Array.from({ length: 30 }, (_, i) => `ghost-${i}`);
  const data = build({}, { caveDwellerRoleName: 'Cave Dwellers', caveDwellerIds: many });
  const { value } = field(data, 'Cave Dwellers');
  assert.match(value, /and 22 more/);
  assert.ok(value.length < 1024, 'stays inside the field cap');
});

// ---- Nothing to say --------------------------------------------------------------------------

test('a disabled badge produces no field', () => {
  const data = build({ scribe: row('bob', { text: 90 }) }, { bardRoleName: null });
  assert.equal(data.fields.length, 1);
  assert.ok(field(data, 'Scribe'));
});

test('with nothing configured there is no card to post', () => {
  assert.equal(buildSocialBadgesEmbed(
    { bard: null, scribe: null, alsoTopped: new Map() },
    { displayNames: NAMES, range: RANGE, bardRoleName: null, scribeRoleName: null },
  ), null);
});

test('a custom role name is used as the field heading', () => {
  const data = build({ bard: row('alice', { voice: 90 }) }, { bardRoleName: 'Yapper' });
  assert.ok(field(data, 'Yapper'), 'the badge is named whatever the server called it');
});

test('an unknown member degrades rather than throwing', () => {
  const data = build({ bard: row('nobody-cached', { voice: 90 }) });
  assert.match(field(data, 'Bard').value, /Unknown member/);
});

test('a missing alsoTopped map is tolerated', () => {
  const embed = buildSocialBadgesEmbed(
    { bard: row('alice', { voice: 90 }), scribe: null },
    { displayNames: NAMES, range: RANGE, bardRoleName: 'Bard', scribeRoleName: 'Scribe' },
  );
  assert.ok(embed.data.fields.length);
});

// ---- End to end ------------------------------------------------------------------------------
// Real rows out of the real query, through the real award pass, into the real renderer. The three
// agree on a row shape only by convention, and a renamed column would otherwise fail in Discord
// rather than here.

const { tempDatabase, T0, MINUTE, DAY } = await import('./helpers.js');
const { awardSocialBadges } = await import('../src/socialBadges.js');

const GUILD = 'g1';

test('a week of real activity produces the card the recap posts', () => {
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

    const data = buildSocialBadgesEmbed(awards, {
      displayNames: NAMES, range: RANGE,
      bardRoleName: 'Bard', scribeRoleName: 'Scribe',
      bardFloorMinutes: 60, scribeFloorMinutes: 30,
    }).data;
    assert.match(field(data, 'Bard').value, /\*\*Bob\*\*/);
    assert.match(field(data, 'Bard').value, /2h in voice/);
    assert.match(field(data, 'Bard').value, /Alice led this/);
    assert.match(field(data, 'Scribe').value, /40m in chat/);
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
    const data = buildSocialBadgesEmbed(awards, {
      displayNames: NAMES, range: RANGE, bardRoleName: 'Bard', scribeRoleName: null,
    }).data;
    assert.match(field(data, 'Bard').value, /4h in voice/);
  } finally { cleanup(); }
});

test('an opted-out top talker never reaches the card', () => {
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
