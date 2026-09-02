import { Events } from 'discord.js';
import { db, client } from './runtime.js';
import {
  DISCORD_TOKEN, GUILD_ID, MAX_SESSION_MS, RECAP_ENABLED, EVENT_REMINDER_STAGES_MINUTES,
  BACKUP_ENABLED, BACKUP_DIR, BACKUP_KEEP, BACKUP_HOUR_UTC, BACKUP_MIRROR_DIR, SOCIAL_ENABLED,
  SOCIAL_VOICE_DAILY_CAP_MINUTES, CAVE_DWELLER_ENABLED, PRESENCE_PLATFORM_LOG,
} from './config.js';
import { commands } from './commands/index.js';
import { handleInteraction } from './interactions/index.js';
import {
  updateActivity, reconcileRank, trackerState, noteSociallyActive, syncGuildRanks,
} from './tracking.js';
import { recordMessage, shouldRecordMessage, settleRoom, settleAllRooms } from './socialTracking.js';
import { ensureMembersCached } from './roles.js';
import {
  announceAchievements, announceRecap, checkServerAchievements, announceEventOccurrence,
} from './announce.js';
import { memberRef } from './log.js';
import { formatPlayTime, rankForSeconds } from './ranks.js';
import { evaluateOngoingSession, evaluateSessionEnd, evaluateTouchGrass } from './achievements.js';
import { clawBackSessionCap } from './adjustments.js';
import { collectDueReminders, rollRecurringEvents } from './events.js';
import { describeRawPresence } from './presenceSpike.js';
import { isBackupDue, runBackup } from './backup.js';

/**
 * Wiring only: connect Discord's events and the periodic loops to the modules that do the work.
 *
 * Anything with real logic lives elsewhere — presence handling in tracking.js, Discord output in
 * announce.js, slash commands under commands/, components under interactions/.
 */

/**
 * Everything a guild needs before it is tracked: the social floor, live voice occupancy, slash
 * commands, and whatever was already running when we arrived.
 *
 * Called from ClientReady *and* GuildCreate, so a server that adds the bot while it is running is
 * set up there and then rather than waiting for the next restart.
 */
async function initGuild(guild) {
  // The floor every "has said nothing" judgement is measured from. Recorded before the GUILD_ID
  // filter because messages are recorded for every guild the bot is in, and the first call for a
  // guild wins — moving it on a later start would reset everyone's silence to zero. On a join
  // that first call is this one, which is what makes the arrival date the floor.
  if (SOCIAL_ENABLED) db.markSocialTrackingStarted(guild.id);
  const tracked = !GUILD_ID || guild.id === GUILD_ID;

  // Commands first, ahead of the member fetch below. On a genuine join the member cache is cold, so
  // that fetch really does go out — and it is the rate-limited one (gateway opcode 8), which can
  // leave it queued for a long time. A new server with no slash commands looks broken, so nothing
  // that can stall is allowed in front of registering them.
  if (tracked) await guild.commands.set(commands);

  if (SOCIAL_ENABLED) {
    // Voice states arrive with the guild, but `channel.members` reads the member cache, so warm
    // it once before trusting occupancy. Rows from a previous run were dropped when the database
    // opened; this puts back everyone who is genuinely in a call right now.
    await ensureMembersCached(guild);
    for (const channel of guild.channels.cache.values()) {
      if (channel.isVoiceBased?.() && channel.members?.size) {
        settleRoom(db, guild, channel.id, Date.now(), SOCIAL_VOICE_DAILY_CAP_MINUTES);
      }
    }
  }
  if (!tracked) return;
  // Presence updates that happened before the bot became ready are not replayed.
  // Begin timing those activities from this successful connection.
  for (const presence of guild.presences.cache.values()) {
    if (presence.member) await updateActivity(presence.member, presence);
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  for (const guild of readyClient.guilds.cache.values()) {
    // Per guild, so one guild the bot cannot read leaves the rest set up.
    await initGuild(guild).catch((error) => console.error(`Could not set up ${guild.id}:`, error));
  }
});

// Added to a server while running. Without this the guild is invisible until a restart: no slash
// commands, no social floor, no voice occupancy.
client.on(Events.GuildCreate, async (guild) => {
  console.log(`Joined ${guild.name} (${guild.id})`);
  await initGuild(guild).catch((error) => console.error(`Could not set up ${guild.id}:`, error));
});

client.on(Events.PresenceUpdate, async (_oldPresence, newPresence) => {
  try {
    const member = newPresence.member;
    if (member) await updateActivity(member, newPresence);
  } catch (error) { console.error('Could not update activity:', error); }
});

// A member leaving is the one way a session can be orphaned. Presence events stop arriving for them
// the instant they are gone, and every other guard is presence-driven: the idle pause needs an
// event to fire on, and the runaway cap only exists when MAX_SESSION_HOURS is above zero. Left
// open, the session keeps banking until the next restart closes it as one impossible row — which is
// how a departed member took the longest-session record with 15h of Counter-Strike 2.
//
// Only the session is closed. Nothing is deleted, and nothing else changes: leaving is often
// accidental, so a rejoiner still finds their hours, rank and achievements where they left them.
//
// Deliberately silent. The time up to this moment is banked because they really were playing it,
// but no achievement is evaluated and nothing is announced — a member who has left is not there to
// be congratulated. Same reasoning that keeps flushAll quiet on shutdown.
client.on(Events.GuildMemberRemove, (member) => {
  try {
    const completed = db.stopSession(member.guild.id, member.id);
    if (completed) {
      console.log(`${memberRef(member)} left while playing ${completed.gameName} — session closed `
        + `at ${formatPlayTime(completed.durationSeconds)}`);
    }
  } catch (error) { console.error('Could not close a departing session:', error); }
});

// The console-presence spike (issue #5), off unless PRESENCE_PLATFORM_LOG=true. Registered as a
// raw-gateway listener rather than folded into the PresenceUpdate handler above because the field
// it exists to capture — the activity's `platform` — is dropped by discord.js before a Presence is
// ever constructed. Logs only; nothing downstream reads it.
if (PRESENCE_PLATFORM_LOG) {
  client.on(Events.Raw, (packet) => {
    try {
      const line = describeRawPresence(packet);
      if (line) console.log(line);
    } catch (error) { console.error('Could not describe a raw presence:', error); }
  });
}

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
    for (const { guildId, userId, completed, capSeconds } of db.closeSessionsExceeding(MAX_SESSION_MS, now)) {
      // Ordinarily excessSeconds is 0 — this tick runs every 60s and catches the cap within a
      // minute. It is only nonzero after a late tick (host sleep, a blocked event loop), and has to
      // run whether or not the member is still cached: the seconds were already banked into
      // game_stats/member_stats regardless of whether achievements get evaluated below.
      const clawedBack = clawBackSessionCap(db, {
        guildId, userId, gameName: completed.gameName,
        excessSeconds: completed.excessSeconds, capSeconds,
      }, now);
      const member = client.guilds.cache.get(guildId)?.members.cache.get(userId);
      if (!member) continue;
      // A claw-back lowers a total, so the rank has to move with it — the same rule /adjust follows
      // after a manual subtraction. It matters most right here: checkpointAll ran earlier in this
      // same tick and reconciled against the *over-banked* total, so it may have just handed out
      // (and announced) a rank bought with the very seconds being taken back. announceRankUp is a
      // no-op on the way down, so nobody is told they were demoted.
      if (clawedBack?.appliedSeconds) {
        await reconcileRank(member, rankForSeconds(clawedBack.totalBefore)).catch(console.error);
      }
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

// Post the recap once the week (or month) turns over, and RECAP_HOUR_UTC has arrived with it.
//
// Every five minutes rather than hourly, because the whole point of RECAP_HOUR_UTC is landing at a
// time somebody chose: setInterval counts from process start, not from the top of the hour, so an
// hourly tick would scatter the post anywhere across the hour after the target depending on when
// the bot was last restarted. The check itself is one pure date calculation and one indexed read
// per guild before announceRecap returns, so the extra ticks cost nothing.
//
// announceRecap records the period either way, so this cannot double-post across a restart.
if (RECAP_ENABLED) {
  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      const recap = await announceRecap(guild).catch((error) => {
        console.error('Recap failed:', error);
        return null;
      });
      // A recap hands the Cave Dweller badge around, and a Cave Dweller wears no rank while they
      // hold one. One sweep here brings every rank back in line with the badges immediately,
      // instead of each member waiting for their own next presence event to put theirs right.
      if (recap && SOCIAL_ENABLED && CAVE_DWELLER_ENABLED) {
        await syncGuildRanks(guild).catch((error) => console.error('Rank sweep failed:', error));
      }
    }
  }, 5 * 60_000).unref();
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
  // Roll every recurring event whose occurrence has passed on to the next one, and post a fresh
  // announcement for it. Ahead of the reminder scan so a rolled event is measured against its new
  // start time in the same tick, and ahead of the expiry sweep below, which skips recurring rows
  // entirely. The database half already happened inside rollRecurringEvents and is exactly-once;
  // everything this loop does is the part that is allowed to fail.
  for (const { event, previousMessageId } of rollRecurringEvents(db, now)) {
    await announceEventOccurrence(event.id, previousMessageId)
      .catch((error) => console.error(`Could not announce the next occurrence of event ${event.id}:`, error));
  }
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
      const { path, removed, mirror } = await runBackup(db, BACKUP_DIR, now, BACKUP_KEEP, BACKUP_MIRROR_DIR);
      console.log(`Database backed up to ${path}${removed.length ? ` (rotated out ${removed.length})` : ''}`);
      // The copy itself is already safe by here; the mirror failing is worth a line but not a throw.
      if (mirror?.error) console.error(`Backup mirror to ${BACKUP_MIRROR_DIR} failed:`, mirror.error);
      else if (mirror) console.log(`Mirrored to ${mirror.path}`);
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
