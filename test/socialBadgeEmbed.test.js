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
).data;

const field = (data, name) => data.fields.find((f) => f.name.includes(name));

test('both badges render with their holder and their own unit', () => {
  const data = build({
    bard: row('alice', { voice: 312 }),
    scribe: row('bob', { text: 90 }),
  });
  assert.match(field(data, 'Bard').value, /\*\*Alice\*\*/);
  assert.match(field(data, 'Bard').value, /5h 12m in voice/);
  assert.match(field(data, 'Scribe').value, /\*\*Bob\*\*/);
  assert.match(field(data, 'Scribe').value, /90 active minutes of chat/,
    'text minutes are a count of separate minutes, never a duration');
});

test('one active minute is not pluralised', () => {
  const data = build({ scribe: row('bob', { text: 1 }) });
  assert.match(field(data, 'Scribe').value, /1 active minute of chat/);
});

test('an unclaimed badge says so and names the bar it missed', () => {
  const data = build({ bard: null, scribe: row('bob', { text: 90 }) });
  assert.match(field(data, 'Bard').value, /Unclaimed/);
  assert.match(field(data, 'Bard').value, /nobody reached 1h in voice/);
});

test('an unclaimed badge with no floor set still reads as unclaimed', () => {
  const data = build({ bard: null }, { bardFloorMinutes: 0 });
  assert.match(field(data, 'Bard').value, /Unclaimed/);
  assert.match(field(data, 'Bard').value, /nobody qualified/);
});

test('a passed-over leader is explained at the badge they did not get', () => {
  const data = build({
    bard: row('bob', { voice: 200 }),
    alsoTopped: new Map([['alice', ['voice']]]),
  });
  assert.match(field(data, 'Bard').value, /\*\*Bob\*\*/);
  assert.match(field(data, 'Bard').value, /Alice topped voice, but already wears another badge/);
});

test('the explanation lands on the right badge when somebody topped both', () => {
  const data = build({
    bard: row('alice', { voice: 300 }),
    scribe: row('bob', { text: 80 }),
    alsoTopped: new Map([['alice', ['text']]]),
  });
  assert.doesNotMatch(field(data, 'Bard').value, /topped/, 'she was given voice, so nothing to explain');
  assert.match(field(data, 'Scribe').value, /Alice topped text/);
});

test('a holder is never told they were passed over for their own badge', () => {
  const data = build({
    bard: row('alice', { voice: 300 }),
    alsoTopped: new Map([['alice', ['voice']]]),
  });
  assert.doesNotMatch(field(data, 'Bard').value, /but already wears/);
});

test('a disabled badge is left out entirely rather than shown empty', () => {
  const data = build({ scribe: row('bob', { text: 90 }) }, { bardRoleName: null });
  assert.equal(data.fields.length, 1);
  assert.ok(field(data, 'Scribe'));
});

test('with neither badge configured there is no card to post', () => {
  const embed = buildSocialBadgesEmbed(
    { bard: null, scribe: null, alsoTopped: new Map() },
    { displayNames: NAMES, range: RANGE, bardRoleName: null, scribeRoleName: null },
  );
  assert.equal(embed, null);
});

test('a custom role name is used as the field heading', () => {
  const data = build({ bard: row('alice', { voice: 90 }) }, { bardRoleName: 'Yapper' });
  assert.ok(field(data, 'Yapper'), 'the badge is named whatever the server called it');
});

test('an unknown member degrades rather than throwing', () => {
  const data = build({ bard: row('nobody-cached', { voice: 90 }) });
  assert.match(field(data, 'Bard').value, /Unknown member/);
});

test('the footer says how long the badges are held', () => {
  const data = build({ bard: row('alice', { voice: 90 }) });
  assert.match(data.footer.text, /Held until next week's recap/);
});

test('a missing alsoTopped map is tolerated', () => {
  const embed = buildSocialBadgesEmbed(
    { bard: row('alice', { voice: 90 }), scribe: null },
    { displayNames: NAMES, range: RANGE, bardRoleName: 'Bard', scribeRoleName: 'Scribe' },
  );
  assert.ok(embed.data.fields.length);
});

// ---- Cave Dweller ----------------------------------------------------------------------------

test('cave dwellers are reported as a count, never as a list of names', () => {
  const data = build({ bard: row('alice', { voice: 90 }) }, {
    caveDwellerRoleName: 'Cave Dweller', caveDwellerCount: 3,
  });
  const value = field(data, 'Cave Dweller').value;
  assert.match(value, /\*\*3\*\* members/);
  assert.doesNotMatch(value, /Alice|Bob|Carol/, 'a roll-call of the absent is a much sharper object');
});

test('a single cave dweller is not pluralised', () => {
  const data = build({}, { caveDwellerRoleName: 'Cave Dweller', caveDwellerCount: 1 });
  assert.match(field(data, 'Cave Dweller').value, /\*\*1\*\* member\n/);
});

test('a week where everybody turned up says so, and reads as good news', () => {
  const data = build({}, { caveDwellerRoleName: 'Cave Dweller', caveDwellerCount: 0 });
  assert.match(field(data, 'Cave Dweller').value, /Nobody — everyone turned up this week/);
});

test('the badge is absent from the card when it is switched off', () => {
  const data = build({ bard: row('alice', { voice: 90 }) }, {
    caveDwellerRoleName: null, caveDwellerCount: 4,
  });
  assert.equal(field(data, 'Cave Dweller'), undefined, 'a disabled badge is never mentioned');
});

test('a card can be built for cave dwellers alone when the other badges are off', () => {
  const embed = buildSocialBadgesEmbed(
    { bard: null, scribe: null, alsoTopped: new Map() },
    {
      displayNames: NAMES, range: RANGE, bardRoleName: null, scribeRoleName: null,
      caveDwellerRoleName: 'Cave Dweller', caveDwellerCount: 2,
    },
  );
  assert.ok(embed, 'still worth a post');
  assert.equal(embed.data.fields.length, 1);
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
    // Alice talks the most and also wins the playtime title; Bob is second in voice; Carol types.
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
    assert.match(field(data, 'Bard').value, /Alice topped voice/);
    assert.match(field(data, 'Scribe').value, /40 active minutes of chat/);
  } finally { cleanup(); }
});

test('a week where the cap bit still renders the capped figure', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.creditVoiceMinutes(GUILD, 'alice', 900, 240, T0);
    const awards = awardSocialBadges({
      voice: db.getSocialLeaderboard(GUILD, T0, T0 + DAY, 'voice', 25),
      voiceFloorMinutes: 60,
    });
    assert.equal(awards.bard.voice_minutes, 240, 'the cap is applied on the way in, not on display');
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
