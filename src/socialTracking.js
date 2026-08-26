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
