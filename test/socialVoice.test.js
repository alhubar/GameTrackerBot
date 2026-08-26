import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { tempDatabase, T0, MINUTE, HOUR, DAY } from './helpers.js';
import {
  isQualifyingChannel, humanOccupants, qualifiesForVoice, settleRoom, settleAllRooms,
} from '../src/socialTracking.js';

const GUILD = 'g1';
const ROOM = 'room-1';
const ROOM2 = 'room-2';
const AFK = 'afk-room';
const CAP = 240;

/**
 * A minimal stand-in for the guild/channel/member graph settleRoom walks. Members are given as
 * { id, bot, mute, deaf, channelId } and wired into the channel they claim to be in.
 */
function world(members, { afkChannelId = AFK } = {}) {
  const channels = new Map();
  const guild = { id: GUILD, afkChannelId, channels: { cache: channels } };
  const build = (id, type) => {
    const channel = { id, type, guild, members: new Map() };
    channels.set(id, channel);
    return channel;
  };
  build(ROOM, ChannelType.GuildVoice);
  build(ROOM2, ChannelType.GuildVoice);
  build(AFK, ChannelType.GuildVoice);
  build('stage-1', ChannelType.GuildStageVoice);
  build('text-1', ChannelType.GuildText);

  for (const spec of members) {
    const member = {
      id: spec.id,
      user: { bot: spec.bot ?? false },
      voice: { channelId: spec.channelId, mute: spec.mute ?? false, deaf: spec.deaf ?? false },
    };
    channels.get(spec.channelId)?.members.set(spec.id, member);
  }
  return guild;
}

const voiceMinutes = (db, userId, at = T0) =>
  db.getSocialTotals(GUILD, userId, at, at + DAY).voice_minutes;

// ---- Qualification -------------------------------------------------------------------------

test('only real voice channels can hold a clock', () => {
  const guild = world([]);
  const get = (id) => guild.channels.cache.get(id);
  assert.equal(isQualifyingChannel(get(ROOM)), true);
  assert.equal(isQualifyingChannel(get(AFK)), false, 'the AFK room is where Discord puts absent people');
  assert.equal(isQualifyingChannel(get('stage-1')), false, 'a stage audience is not a conversation');
  assert.equal(isQualifyingChannel(get('text-1')), false);
  assert.equal(isQualifyingChannel(null), false);
});

test('bots are furniture, not company', () => {
  const guild = world([
    { id: 'alice', channelId: ROOM },
    { id: 'musicbot', channelId: ROOM, bot: true },
  ]);
  const room = guild.channels.cache.get(ROOM);
  assert.deepEqual(humanOccupants(room).map((m) => m.id), ['alice']);
  assert.equal(qualifiesForVoice(room.members.get('alice'), room, humanOccupants(room).length), false,
    'alone with a music bot is still alone');
});

test('two humans in a room both qualify', () => {
  const guild = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM }]);
  const room = guild.channels.cache.get(ROOM);
  const count = humanOccupants(room).length;
  assert.equal(qualifiesForVoice(room.members.get('alice'), room, count), true);
  assert.equal(qualifiesForVoice(room.members.get('bob'), room, count), true);
});

test('mute and deafen stop your own clock, not your companion\'s', () => {
  const guild = world([
    { id: 'alice', channelId: ROOM },
    { id: 'bob', channelId: ROOM, mute: true },
    { id: 'carol', channelId: ROOM, deaf: true },
  ]);
  const room = guild.channels.cache.get(ROOM);
  const count = humanOccupants(room).length;
  assert.equal(qualifiesForVoice(room.members.get('alice'), room, count), true, 'still has company');
  assert.equal(qualifiesForVoice(room.members.get('bob'), room, count), false);
  assert.equal(qualifiesForVoice(room.members.get('carol'), room, count), false);
});

// ---- Banking -------------------------------------------------------------------------------

test('a qualifying pair banks minutes as time passes', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const guild = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM }]);
    settleRoom(db, guild, ROOM, T0, CAP);
    settleRoom(db, guild, ROOM, T0 + 30 * MINUTE, CAP);
    assert.equal(voiceMinutes(db, 'alice'), 30);
    assert.equal(voiceMinutes(db, 'bob'), 30);
  } finally { cleanup(); }
});

test('somebody alone banks nothing, however long they sit there', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const guild = world([{ id: 'alice', channelId: ROOM }]);
    settleRoom(db, guild, ROOM, T0, CAP);
    settleRoom(db, guild, ROOM, T0 + 8 * HOUR, CAP);
    assert.equal(voiceMinutes(db, 'alice'), 0, 'the overnight-alone case earns nothing');
  } finally { cleanup(); }
});

test('a muted member banks nothing while their companion banks normally', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const guild = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM, mute: true }]);
    settleRoom(db, guild, ROOM, T0, CAP);
    settleRoom(db, guild, ROOM, T0 + 20 * MINUTE, CAP);
    assert.equal(voiceMinutes(db, 'alice'), 20);
    assert.equal(voiceMinutes(db, 'bob'), 0);
  } finally { cleanup(); }
});

test('both muting stops both clocks at once', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const talking = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM }]);
    settleRoom(db, talking, ROOM, T0, CAP);
    settleRoom(db, talking, ROOM, T0 + 10 * MINUTE, CAP);

    const muted = world([
      { id: 'alice', channelId: ROOM, mute: true },
      { id: 'bob', channelId: ROOM, mute: true },
    ]);
    settleRoom(db, muted, ROOM, T0 + 10 * MINUTE, CAP);
    settleRoom(db, muted, ROOM, T0 + 3 * HOUR, CAP);
    assert.equal(voiceMinutes(db, 'alice'), 10, 'nothing accrued after the mute');
    assert.equal(voiceMinutes(db, 'bob'), 10);
  } finally { cleanup(); }
});

test('unmuting does not retroactively credit the muted stretch', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const muted = world([
      { id: 'alice', channelId: ROOM, mute: true },
      { id: 'bob', channelId: ROOM },
    ]);
    settleRoom(db, muted, ROOM, T0, CAP);
    settleRoom(db, muted, ROOM, T0 + 2 * HOUR, CAP);

    const unmuted = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM }]);
    settleRoom(db, unmuted, ROOM, T0 + 2 * HOUR, CAP);
    settleRoom(db, unmuted, ROOM, T0 + 2 * HOUR + 5 * MINUTE, CAP);
    assert.equal(voiceMinutes(db, 'alice'), 5, 'only the time since unmuting');
  } finally { cleanup(); }
});

test('sub-minute remainders survive repeated settling instead of being truncated away', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const guild = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM }]);
    settleRoom(db, guild, ROOM, T0, CAP);
    // A busy room settles constantly. Thirty settles at 40s apart is 20 minutes of real time;
    // truncating on each one would bank zero.
    for (let i = 1; i <= 30; i += 1) settleRoom(db, guild, ROOM, T0 + i * 40_000, CAP);
    assert.equal(voiceMinutes(db, 'alice'), 20);
  } finally { cleanup(); }
});

test('the daily cap bounds a pair who never leave', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const guild = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM }]);
    settleRoom(db, guild, ROOM, T0, CAP);
    settleRoom(db, guild, ROOM, T0 + 10 * HOUR, CAP);
    assert.equal(voiceMinutes(db, 'alice'), CAP, 'ten hours, capped at four');
  } finally { cleanup(); }
});

// ---- The ripple ----------------------------------------------------------------------------

test('the member left behind stops earning the moment the room empties out', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const together = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM }]);
    settleRoom(db, together, ROOM, T0, CAP);
    settleRoom(db, together, ROOM, T0 + 10 * MINUTE, CAP);

    // Bob leaves. Discord reports this for Bob, not for Alice — but Alice's clock has to stop.
    const alone = world([{ id: 'alice', channelId: ROOM }]);
    settleRoom(db, alone, ROOM, T0 + 10 * MINUTE, CAP);
    settleRoom(db, alone, ROOM, T0 + 4 * HOUR, CAP);

    assert.equal(voiceMinutes(db, 'alice'), 10, 'the four hours alone are worth nothing');
    assert.equal(db.getVoiceRow(GUILD, 'alice').qualified, 0);
    assert.equal(db.getVoiceRow(GUILD, 'bob'), null, 'bob is no longer on record anywhere');
  } finally { cleanup(); }
});

test('arriving company starts the clock for whoever was already waiting', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const alone = world([{ id: 'alice', channelId: ROOM }]);
    settleRoom(db, alone, ROOM, T0, CAP);
    settleRoom(db, alone, ROOM, T0 + HOUR, CAP);
    assert.equal(voiceMinutes(db, 'alice'), 0);

    const together = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM }]);
    settleRoom(db, together, ROOM, T0 + HOUR, CAP);
    settleRoom(db, together, ROOM, T0 + HOUR + 15 * MINUTE, CAP);
    assert.equal(voiceMinutes(db, 'alice'), 15, 'only from when bob showed up');
  } finally { cleanup(); }
});

test('moving rooms banks the time owed in the room departed', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const before = world([
      { id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM },
      { id: 'carol', channelId: ROOM2 },
    ]);
    settleRoom(db, before, ROOM, T0, CAP);
    settleRoom(db, before, ROOM2, T0, CAP);

    // Alice moves to room 2 after 20 minutes, joining Carol who was waiting alone.
    const at = T0 + 20 * MINUTE;
    const after = world([
      { id: 'bob', channelId: ROOM },
      { id: 'alice', channelId: ROOM2 }, { id: 'carol', channelId: ROOM2 },
    ]);
    for (const id of [ROOM, ROOM2]) settleRoom(db, after, id, at, CAP);
    settleRoom(db, after, ROOM2, at + 10 * MINUTE, CAP);

    assert.equal(voiceMinutes(db, 'alice'), 30, '20 with bob, then 10 with carol');
    assert.equal(voiceMinutes(db, 'bob'), 20, 'banked, then alone and earning nothing');
    assert.equal(voiceMinutes(db, 'carol'), 10, 'only once alice arrived');
    assert.equal(db.getVoiceRow(GUILD, 'alice').channel_id, ROOM2);
  } finally { cleanup(); }
});

test('settling the rooms in either order gives the same answer', () => {
  const run = (order) => {
    const { db, cleanup } = tempDatabase();
    try {
      const before = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM }]);
      settleRoom(db, before, ROOM, T0, CAP);
      const at = T0 + 12 * MINUTE;
      const after = world([
        { id: 'bob', channelId: ROOM },
        { id: 'alice', channelId: ROOM2 }, { id: 'carol', channelId: ROOM2 },
      ]);
      for (const id of order) settleRoom(db, after, id, at, CAP);
      settleRoom(db, after, ROOM2, at + 8 * MINUTE, CAP);
      return { alice: voiceMinutes(db, 'alice'), bob: voiceMinutes(db, 'bob') };
    } finally { cleanup(); }
  };
  assert.deepEqual(run([ROOM, ROOM2]), run([ROOM2, ROOM]));
});

test('being moved to the AFK channel stops the clock', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const together = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM }]);
    settleRoom(db, together, ROOM, T0, CAP);
    settleRoom(db, together, ROOM, T0 + 5 * MINUTE, CAP);

    const afk = world([{ id: 'alice', channelId: AFK }, { id: 'bob', channelId: AFK }]);
    for (const id of [ROOM, AFK]) settleRoom(db, afk, id, T0 + 5 * MINUTE, CAP);
    settleRoom(db, afk, AFK, T0 + 6 * HOUR, CAP);

    assert.equal(voiceMinutes(db, 'alice'), 5);
    assert.equal(db.getVoiceRow(GUILD, 'alice'), null, 'nobody is on record in the AFK room');
  } finally { cleanup(); }
});

test('a text channel never produces voice rows, whoever can see it', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const guild = world([]);
    const text = guild.channels.cache.get('text-1');
    // GuildChannel.members is everyone who can *view* the channel — the whole server, in effect.
    for (const id of ['alice', 'bob', 'carol']) {
      text.members.set(id, { id, user: { bot: false }, voice: { channelId: null } });
    }
    settleRoom(db, guild, 'text-1', T0, CAP);
    assert.deepEqual(db.getAllVoiceRows(), []);
  } finally { cleanup(); }
});

test('a deleted channel settles what it owed and leaves nothing behind', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const guild = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM }]);
    settleRoom(db, guild, ROOM, T0, CAP);
    guild.channels.cache.delete(ROOM);
    settleRoom(db, guild, ROOM, T0 + 25 * MINUTE, CAP);
    assert.equal(voiceMinutes(db, 'alice'), 25, 'time up to the deletion is kept');
    assert.deepEqual(db.getAllVoiceRows(), []);
  } finally { cleanup(); }
});

// ---- Opt-out, checkpoint and shutdown --------------------------------------------------------

test('an opted-out member is never recorded, and their companion is unaffected', () => {
  const { db, cleanup } = tempDatabase();
  try {
    db.optOut(GUILD, 'alice', T0);
    const guild = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM }]);
    settleRoom(db, guild, ROOM, T0, CAP);
    settleRoom(db, guild, ROOM, T0 + 30 * MINUTE, CAP);
    assert.equal(voiceMinutes(db, 'alice'), 0);
    assert.equal(db.getVoiceRow(GUILD, 'alice'), null);
    assert.equal(voiceMinutes(db, 'bob'), 30, 'alice is still company, she is just not recorded');
  } finally { cleanup(); }
});

test('opting out mid-call drops the row so nothing more is credited', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const guild = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM }]);
    settleRoom(db, guild, ROOM, T0, CAP);
    settleRoom(db, guild, ROOM, T0 + 10 * MINUTE, CAP);
    db.optOut(GUILD, 'alice', T0 + 10 * MINUTE);
    assert.equal(db.getVoiceRow(GUILD, 'alice'), null);
    settleRoom(db, guild, ROOM, T0 + 40 * MINUTE, CAP);
    assert.equal(voiceMinutes(db, 'alice'), 10, 'kept what was earned before, nothing after');
  } finally { cleanup(); }
});

test('the periodic settle re-reads live state for every room on record', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const guild = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM }]);
    const client = { guilds: { cache: new Map([[GUILD, guild]]) } };
    settleRoom(db, guild, ROOM, T0, CAP);
    settleAllRooms(db, client, T0 + 45 * MINUTE, CAP);
    assert.equal(voiceMinutes(db, 'alice'), 45, 'no gateway event needed');
  } finally { cleanup(); }
});

test('a clean shutdown banks what is owed and empties the table', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const guild = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM }]);
    settleRoom(db, guild, ROOM, T0, CAP);
    db.flushVoice(T0 + 17 * MINUTE, CAP);
    assert.equal(voiceMinutes(db, 'alice'), 17);
    assert.equal(voiceMinutes(db, 'bob'), 17);
    assert.deepEqual(db.getAllVoiceRows(), []);
  } finally { cleanup(); }
});

test('purging a member removes their voice row too', () => {
  const { db, cleanup } = tempDatabase();
  try {
    const guild = world([{ id: 'alice', channelId: ROOM }, { id: 'bob', channelId: ROOM }]);
    settleRoom(db, guild, ROOM, T0, CAP);
    const removed = db.purgeMember(GUILD, 'alice');
    assert.equal(removed.activeVoice, 1);
    assert.equal(db.getVoiceRow(GUILD, 'alice'), null);
    assert.ok(db.getVoiceRow(GUILD, 'bob'), 'bob is untouched');
  } finally { cleanup(); }
});
