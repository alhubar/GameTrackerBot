import { ChannelType } from 'discord.js';

/**
 * Messages and voice activity in, social day-buckets out.
 *
 * The counterpart to tracking.js, which owns the presence path. Everything here is about the two
 * event sources that have nothing to do with playing a game.
 *
 * Takes `db` as a parameter rather than importing runtime.js, and reads no config: that keeps it
 * importable from tests without opening a database as a side effect, the same arrangement
 * achievements.js uses. index.js owns the SOCIAL_ENABLED switch and passes the runtime handle in.
 */

/**
 * The single opt-out gate for every social write.
 *
 * tracking.js has its own gate for the presence path; this is the one for both new event paths.
 * Message and voice recording route through here rather than each calling `isOptedOut` for itself
 * — three hand-threaded checks is where the fourth gets forgotten, and a missed one means
 * recording somebody who explicitly asked not to be recorded.
 */
export const isSociallyTracked = (db, guildId, userId) => !db.isOptedOut(guildId, userId);

/**
 * Whether a message counts towards its author's text minutes.
 *
 * Three exclusions, each for its own reason:
 * - **No guild.** A DM has no guild to credit, and social minutes are per-server.
 * - **Bots.** Otherwise every bot in the server races for Scribe. This also covers webhook posts,
 *   whose author is a user with the bot flag set.
 * - **System messages.** Discord attributes "X joined the server", pins and boost notices to the
 *   member as author. Counting those would hand out a text minute for *arriving*, which is the
 *   exact opposite of what the badge is supposed to measure.
 *
 * Message *content* is never read — only who posted and where. That is why the bot needs the
 * non-privileged GuildMessages intent and not MessageContent.
 */
export function shouldRecordMessage(message) {
  if (!message?.guildId) return false;
  // An author is required rather than assumed: there is nobody to credit without one, and every
  // check below reads through it. Discord can deliver a message whose author has not resolved.
  if (!message.author?.id) return false;
  if (message.author.bot) return false;
  if (message.system) return false;
  return true;
}

/**
 * Credits the minute containing `now` to the message author, if the message counts and the member
 * is being tracked. Returns true only when this actually bought a new minute — a second message in
 * the same minute is recorded as nothing, which is what stops volume from being worth anything.
 */
export function recordMessage(db, message, now = Date.now()) {
  if (!shouldRecordMessage(message)) return false;
  const guildId = message.guildId;
  const userId = message.author.id;
  if (!isSociallyTracked(db, guildId, userId)) return false;
  return db.recordTextMinute(guildId, userId, now);
}

// ---- Voice ---------------------------------------------------------------------------------

/**
 * Whether time spent in this channel can count at all, before looking at anybody in it.
 *
 * The AFK channel is the room Discord moves people into precisely because they are not there.
 * Stage channels are excluded because an audience is potentially hundreds of silent listeners who
 * would all mint minutes at once, which is nothing like a conversation.
 */
export function isQualifyingChannel(channel) {
  if (!channel) return false;
  if (channel.type !== ChannelType.GuildVoice) return false;
  if (channel.id === channel.guild?.afkChannelId) return false;
  return true;
}

/** Everyone actually in the room, bots excluded — they are furniture, not company. */
export function humanOccupants(channel) {
  return [...(channel?.members?.values() ?? [])].filter((member) => !member.user?.bot);
}

/**
 * Whether this member's voice clock should be running right now.
 *
 * Their own mute or deafen stops their own clock, but says nothing about anyone else's: somebody
 * listening in silence still counts as company for the person talking. Requiring everyone present
 * to be unmuted would let one quiet listener zero out the person actually speaking.
 *
 * `humanCount` is the number of non-bot members in the room including this one, so the test is
 * "at least one other human". This is the whole reason a voice clock cannot be evaluated from the
 * member alone — see settleRoom.
 */
export function qualifiesForVoice(member, channel, humanCount) {
  if (!isQualifyingChannel(channel)) return false;
  if (member?.user?.bot) return false;
  const voice = member?.voice;
  if (!voice || voice.channelId !== channel.id) return false;
  if (voice.mute || voice.deaf) return false;
  return humanCount >= 2;
}

/**
 * Settles one voice channel: bank what everyone in it is owed, then re-derive who is still
 * counting. This is the unit of work for voice, and it is a *room*, never a member.
 *
 * Nothing else in this codebase works this way. A game session belongs to one member and can be
 * banked without reference to anyone else; a voice clock depends on who else is present, so one
 * person leaving silently changes whether everybody left behind is still earning. Discord tells us
 * only about the member who moved, which is why callers settle both the room departed and the room
 * joined rather than touching a single member.
 *
 * Bank before re-deriving, always. Reversed, somebody who has just stopped qualifying loses the
 * minutes they had legitimately earned right up to the instant the room changed.
 */
export function settleRoom(db, guild, channelId, now = Date.now(), dailyCapMinutes = Infinity) {
  if (!guild || !channelId) return 0;
  const channel = guild.channels?.cache?.get(channelId) ?? null;
  // Only a real voice channel can hold anybody's clock, so anything else has no occupants as far
  // as this is concerned — a stage, the AFK room, a channel that has since been deleted, or a text
  // channel, whose `.members` is everyone who can *view* it rather than anyone sitting in it.
  // Rows still claiming such a channel are settled and dropped by the loop below.
  const occupants = isQualifyingChannel(channel) ? humanOccupants(channel) : [];
  const stillHere = new Set(occupants.map((member) => member.id));
  let credited = 0;

  // Everyone this channel had on record: settle them, then drop anyone who is no longer in it.
  // A member who moved to another room is dropped here and re-added when that room is settled.
  for (const row of db.getVoiceRowsForChannel(guild.id, channelId)) {
    credited += db.bankVoiceTime(guild.id, row.user_id, now, dailyCapMinutes);
    if (!stillHere.has(row.user_id)) db.clearVoiceRow(guild.id, row.user_id);
  }

  const humanCount = occupants.length;
  for (const member of occupants) {
    if (!isSociallyTracked(db, guild.id, member.id)) {
      // Opted out: never recorded, and any row from before they opted out goes with them.
      db.clearVoiceRow(guild.id, member.id);
      continue;
    }
    // Someone who arrived from another channel still owes time there; bank it against the row as
    // it stands before overwriting which room they are in.
    const existing = db.getVoiceRow(guild.id, member.id);
    if (existing && existing.channel_id !== channelId) {
      credited += db.bankVoiceTime(guild.id, member.id, now, dailyCapMinutes);
    }
    db.setVoiceState(guild.id, member.id, channelId, qualifiesForVoice(member, channel, humanCount), now);
  }
  return credited;
}

/**
 * Settles every room the bot currently has anyone on record in.
 *
 * Driven off the rows rather than off Discord's channel list: those rows are exactly the members
 * whose clocks might be running, and a room nobody is recorded in has nothing to settle. This is
 * what the periodic checkpoint calls, so occupancy is re-read from live state every minute instead
 * of being trusted from the last event — a missed gateway event heals here.
 */
export function settleAllRooms(db, client, now = Date.now(), dailyCapMinutes = Infinity) {
  const rooms = new Map();
  for (const row of db.getAllVoiceRows()) {
    if (!rooms.has(row.guild_id)) rooms.set(row.guild_id, new Set());
    rooms.get(row.guild_id).add(row.channel_id);
  }
  let credited = 0;
  for (const [guildId, channelIds] of rooms) {
    const guild = client.guilds?.cache?.get(guildId);
    if (!guild) continue;
    for (const channelId of channelIds) {
      credited += settleRoom(db, guild, channelId, now, dailyCapMinutes);
    }
  }
  return credited;
}
