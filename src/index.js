import { Events } from 'discord.js';
import { db, client } from './runtime.js';
import {
  DISCORD_TOKEN, GUILD_ID, MAX_SESSION_MS, RECAP_ENABLED, EVENT_REMINDER_STAGES_MINUTES,
  BACKUP_ENABLED, BACKUP_DIR, BACKUP_KEEP, BACKUP_HOUR_UTC, SOCIAL_ENABLED,
  SOCIAL_VOICE_DAILY_CAP_MINUTES,
} from './config.js';
import { commands } from './commands/index.js';
import { handleInteraction } from './interactions/index.js';
import { updateActivity, reconcileRank, trackerState } from './tracking.js';
import { recordMessage, shouldRecordMessage, settleRoom, settleAllRooms } from './socialTracking.js';
import {
  announceAchievements, announceRecap, checkServerAchievements, noteSociallyActive,
} from './announce.js';
import { rankForSeconds } from './ranks.js';
import { evaluateOngoingSession, evaluateSessionEnd, evaluateTouchGrass } from './achievements.js';
import { collectDueReminders } from './events.js';
import { isBackupDue, runBackup } from './backup.js';

/**
 * Wiring only: connect Discord's events and the periodic loops to the modules that do the work.
 *
 * Anything with real logic lives elsewhere — presence handling in tracking.js, Discord output in
 * announce.js, slash commands under commands/, components under interactions/.
 */

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  for (const guild of readyClient.guilds.cache.values()) {
    // The floor every "has said nothing" judgement is measured from. Recorded before the GUILD_ID
    // filter because messages are recorded for every guild the bot is in, and the first call for a
    // guild wins — moving it on a later start would reset everyone's silence to zero.
    if (SOCIAL_ENABLED) {
      db.markSocialTrackingStarted(guild.id);
      // Voice states arrive with the guild, but `channel.members` reads the member cache, so warm
      // it once before trusting occupancy. Rows from a previous run were dropped when the database
      // opened; this puts back everyone who is genuinely in a call right now.
      await guild.members.fetch().catch(() => null);
      for (const channel of guild.channels.cache.values()) {
        if (channel.isVoiceBased?.() && channel.members?.size) {
          settleRoom(db, guild, channel.id, Date.now(), SOCIAL_VOICE_DAILY_CAP_MINUTES);
        }
      }
    }
    const scope = GUILD_ID ? (guild.id === GUILD_ID ? guild : null) : guild;
    if (!scope) continue;
    await scope.commands.set(commands);
    // Presence updates that happened before the bot became ready are not replayed.
    // Begin timing those activities from this successful connection.
    for (const presence of scope.presences.cache.values()) {
      if (presence.member) await updateActivity(presence.member, presence);
    }
  }
});

client.on(Events.PresenceUpdate, async (_oldPresence, newPresence) => {
  try {
    const member = newPresence.member;
    if (member) await updateActivity(member, newPresence);
  } catch (error) { console.error('Could not update activity:', error); }
});

// Text minutes for the Scribe badge. Registered only when the feature is on, so a disabled server
// never even receives the events. recordMessage decides what counts and checks the opt-out; a
// second message inside the same minute is deliberately worth nothing.
if (SOCIAL_ENABLED) {
  client.on(Events.MessageCreate, (message) => {
    try {
      // Any message counts as turning up, even one that bought no minute because an earlier
      // message already claimed that minute.
      if (recordMessage(db, message) || shouldRecordMessage(message)) noteSociallyActive(message.member);
    } catch (error) { console.error('Could not record a message:', error); }
  });
}

// Voice minutes for the Bard badge. Both rooms are settled, never just the member who moved:
// whether a clock runs depends on who else is in the room, so somebody leaving changes whether
// everyone left behind is still earning — and Discord only tells us about the one who moved.
if (SOCIAL_ENABLED) {
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    try {
      const guild = newState.guild ?? oldState.guild;
      const now = Date.now();
      for (const channelId of new Set([oldState.channelId, newState.channelId].filter(Boolean))) {
        settleRoom(db, guild, channelId, now, SOCIAL_VOICE_DAILY_CAP_MINUTES);
        // Everyone whose clock is now running has turned up — not only the member who moved.
        // Two people joining an empty channel both start counting off a single gateway event.
        for (const row of db.getVoiceRowsForChannel(guild.id, channelId)) {
          if (row.qualified) noteSociallyActive(guild.members.cache.get(row.user_id));
        }
      }
    } catch (error) { console.error('Could not settle a voice channel:', error); }
  });
}

client.on(Events.InteractionCreate, handleInteraction);

// Persist elapsed time and re-evaluate ranks/achievements even if Discord did not send a new presence event.
setInterval(async () => {
  const now = Date.now();
  trackerState.lastCheckpointAt = now;
  for (const { guild_id, user_id, elapsed_seconds, started_at, game_name, paused_ms } of db.checkpointAll(now)) {
    const guild = client.guilds.cache.get(guild_id);
    const member = guild?.members.cache.get(user_id);
    const oldRank = rankForSeconds(db.getTotalSeconds(guild_id, user_id) - elapsed_seconds);
    if (member) {
      await reconcileRank(member, oldRank).catch(console.error);
      const unlocked = evaluateOngoingSession(db, guild_id, user_id, game_name, started_at, now, paused_ms);
      await announceAchievements(member, unlocked).catch(console.error);
    }
  }
  // Retire sessions that have run past the cap. Anyone genuinely still playing is picked up again
  // by their next presence event; nobody keeps banking hours off a game left running unattended.
  if (MAX_SESSION_MS) {
    for (const { guildId, userId, completed } of db.closeSessionsExceeding(MAX_SESSION_MS, now)) {
      const member = client.guilds.cache.get(guildId)?.members.cache.get(userId);
      if (!member) continue;
      const unlocked = evaluateSessionEnd(db, guildId, userId, completed, now);
      await announceAchievements(member, unlocked).catch(console.error);
    }
  }
  // Voice needs the same treatment as sessions, for a different reason: nobody has to *do*
  // anything for a room to stop qualifying, so occupancy is re-read from live state here rather
  // than trusted from the last gateway event. A missed event heals on the next pass.
  if (SOCIAL_ENABLED) {
    try {
      settleAllRooms(db, client, now, SOCIAL_VOICE_DAILY_CAP_MINUTES);
    } catch (error) { console.error('Could not settle voice channels:', error); }
  }
  // Catch server-wide milestones (e.g. combined playtime) crossed by idle accrual, not just by a presence event.
  for (const guild of client.guilds.cache.values()) {
    await checkServerAchievements(guild).catch(console.error);
  }
}, 60_000).unref();

// Post the recap once the week (or month) turns over. Hourly is plenty for either boundary, and
// announceRecap records the period either way so this can't double-post across a restart.
if (RECAP_ENABLED) {
  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      await announceRecap(guild).catch((error) => console.error('Recap failed:', error));
    }
  }, 60 * 60_000).unref();
}

// Award Touch Grass to members who have gone quiet; this can't be triggered by a presence event since it's about absence.
setInterval(async () => {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    for (const { userId, unlocked } of evaluateTouchGrass(db, guild.id, now)) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) await announceAchievements(member, unlocked).catch(console.error);
    }
  }
}, 6 * 60 * 60 * 1000).unref();

// Ping everyone who's "Going" at each configured reminder stage before an event starts (stage 0
// means "at start" — configure EVENT_REMINDER_STAGES_MINUTES to include/exclude it). The staging
// rules live in events.js so they can be tested without Discord; this loop just delivers them.
setInterval(async () => {
  const now = Date.now();
  for (const { event, going, text } of collectDueReminders(db, EVENT_REMINDER_STAGES_MINUTES, now)) {
    const guild = client.guilds.cache.get(event.guild_id);
    const channel = guild?.channels.cache.get(event.channel_id);
    if (!channel?.isTextBased()) continue;
    const mentions = going.map((row) => `<@${row.user_id}>`).join(' ');
    // Same jump-link shape /event list uses — a masked link (bots can use them in plain content)
    // makes the title itself a way back to the buried announcement.
    const titleText = event.message_id
      ? `[${event.title}](https://discord.com/channels/${event.guild_id}/${event.channel_id}/${event.message_id})`
      : event.title;
    await channel.send(`🔔 ${titleText} ${text}\n${mentions}`)
      .catch((error) => console.error('Could not send event reminder:', error));
  }
  // Clean up events well after they've started so the table doesn't grow unbounded, and take the
  // announcement message with them. Without this the post sits in the channel indefinitely with
  // live-looking RSVP buttons that answer "This event no longer exists" once the row is gone.
  //
  // The announcement is the bot's own interaction reply, so deleting it needs no Manage Messages.
  // The row is dropped whether or not the message went, deliberately: retrying a message that
  // cannot be deleted would re-run every 60 seconds forever, and one orphaned post is a far
  // smaller problem than a cleanup loop that never finishes. Same at-most-once shape as reminders.
  for (const event of db.getStaleEvents(now - 24 * 60 * 60_000)) {
    if (event.message_id) {
      const channel = client.guilds.cache.get(event.guild_id)?.channels.cache.get(event.channel_id);
      if (channel?.isTextBased()) {
        const message = await channel.messages.fetch(event.message_id).catch(() => null);
        if (message) {
          await message.delete()
            .catch((error) => console.error('Could not delete the expired event message:', error));
        }
      }
    }
    db.deleteEvent(event.id);
  }
}, 60_000).unref();

// Take the nightly copy once BACKUP_HOUR_UTC arrives. Checked hourly rather than scheduled to a
// single moment, so a bot that was down at the hour still gets that day's copy when it comes back.
// Whether tonight's is already taken is read off the filenames, so this cannot double-post either.
if (BACKUP_ENABLED) {
  setInterval(async () => {
    const now = Date.now();
    if (!isBackupDue(BACKUP_DIR, now, BACKUP_HOUR_UTC)) return;
    try {
      const { path, removed } = await runBackup(db, BACKUP_DIR, now, BACKUP_KEEP);
      console.log(`Database backed up to ${path}${removed.length ? ` (rotated out ${removed.length})` : ''}`);
    } catch (error) { console.error('Backup failed:', error); }
  }, 60 * 60_000).unref();
}

function shutdown() {
  db.flushAll();
  // Stopping on purpose should not cost anyone the minutes they were part-way through earning,
  // so every voice row is settled as of now rather than dropped the way a crash drops them.
  if (SOCIAL_ENABLED) db.flushVoice(Date.now(), SOCIAL_VOICE_DAILY_CAP_MINUTES);
  db.close();
  client.destroy();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// A single flaky Discord API response (e.g. a stale interaction from rapid clicking) should
// never be able to take the whole bot down. Log and keep running instead of crashing.
client.on('error', (error) => console.error('Discord client error:', error));
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));

client.login(DISCORD_TOKEN);
