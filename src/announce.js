import { db, client } from './runtime.js';
import { findTextChannel, presentMemberIds } from './ui.js';
import {
  ACHIEVEMENT_ANNOUNCEMENTS, ACHIEVEMENT_CHANNEL, RECAP_CHANNEL, RECAP_PERIOD,
  RECAP_MIN_SECONDS, RECAP_HOUR_UTC, RECAP_WINNER_ROLE, RECAP_WINNER_ROLE_ICON,
  SOCIAL_ENABLED, BARD_ROLE, BARD_ROLE_ICON, BARD_MIN_MINUTES,
  SCRIBE_ROLE, SCRIBE_ROLE_ICON, SCRIBE_MIN_MINUTES,
  CAVE_DWELLER_ENABLED, CAVE_DWELLER_ROLE, CAVE_DWELLER_ROLE_ICON, CAVE_DWELLER_GRACE_MS,
} from './config.js';
import { achievementById, evaluateRecapBadge } from './achievements.js';
import { evaluateServerAchievements } from './serverAchievements.js';
import {
  buildAchievementEmbed, buildServerAchievementEmbed, buildRecapEmbed, buildNoWinnerRecapEmbed,
  buildSocialBadgesEmbed,
} from './embeds.js';
import { buildRecap, isRecapDue, markRecapAnnounced } from './recap.js';
import { awardSocialBadges } from './socialBadges.js';
import {
  awardWinnerRole, clearWinnerRole, awardBadgeRole, clearBadgeRole, syncBadgeRoleMembers, ensureMembersCached,
  BARD_ROLE_COLOR, SCRIBE_ROLE_COLOR, CAVE_DWELLER_ROLE_COLOR,
} from './roles.js';
import { eligibleForSilence } from './social.js';
import { buildEventEmbed, buildEventComponents } from './interactions/eventViews.js';

/**
 * How far down each social board to look. Only the top few can ever hold a badge, but pass-down
 * walks past everyone who already has one, so the list has to be deep enough to have somewhere to
 * go — the same over-fetch the leaderboards do before dropping departed members.
 */
const SOCIAL_CANDIDATES = 25;

/**
 * Every badge name, so each one knows which coloured roles above it are its own siblings rather
 * than a rank about to steal its colour. They deliberately share the slot under the bot's role, so
 * without this the position warning fires for all of them on every single recap.
 */
const BADGE_ROLE_NAMES = [RECAP_WINNER_ROLE, BARD_ROLE, SCRIBE_ROLE, CAVE_DWELLER_ROLE];

/** Everything that turns an unlocked achievement or a finished recap into a Discord message. */

export async function announceAchievements(member, achievementIds) {
  if (!ACHIEVEMENT_ANNOUNCEMENTS || !achievementIds?.length || !ACHIEVEMENT_CHANNEL) return;
  const channel = findTextChannel(member.guild, ACHIEVEMENT_CHANNEL);
  if (!channel) return;
  const trackedPlayers = db.getTrackedPlayerCount(member.guild.id);
  for (const id of achievementIds) {
    const achievement = achievementById(id);
    if (!achievement) continue;
    const unlockCount = db.getAchievementUnlockCount(member.guild.id, id);
    const embed = buildAchievementEmbed(achievement, {
      displayName: member.displayName,
      avatarUrl: member.displayAvatarURL(),
      percentOfPlayers: trackedPlayers ? Math.max(1, Math.round((unlockCount / trackedPlayers) * 100)) : 100,
    });
    await channel.send({ content: `<@${member.id}>`, embeds: [embed] })
      .catch((error) => console.error('Could not announce achievement:', error));
  }
}

export async function announceServerAchievements(guild, unlockedTiers) {
  if (!ACHIEVEMENT_ANNOUNCEMENTS || !unlockedTiers?.length || !ACHIEVEMENT_CHANNEL) return;
  const channel = findTextChannel(guild, ACHIEVEMENT_CHANNEL);
  if (!channel) return;
  for (const tier of unlockedTiers) {
    const embed = buildServerAchievementEmbed(tier, guild.iconURL() ?? null);
    await channel.send({ embeds: [embed] }).catch((error) => console.error('Could not announce server achievement:', error));
  }
}

export async function checkServerAchievements(guild) {
  const { unlocked } = evaluateServerAchievements(db, guild.id);
  await announceServerAchievements(guild, unlocked);
}

/**
 * Works out who holds what for a period, and gathers the names needed to render it. Reads only —
 * no role is created, granted or taken away.
 *
 * Split from the settling below so anything that only wants to *look* at a period — a preview
 * script, or a future command — cannot hand a role out as a side effect of rendering. The badges
 * are awarded once, at the recap, and nowhere else.
 */
export async function computeSocialBadges(guild, range, championId) {
  await ensureMembersCached(guild);
  // Departed members are dropped before the award pass, never after: a post-filter would hand a
  // badge to somebody who has left and then quietly show it as unclaimed.
  const present = await presentMemberIds(guild);
  const board = (metric) => {
    const rows = db.getSocialLeaderboard(guild.id, range.start, range.end, metric, SOCIAL_CANDIDATES);
    return present ? rows.filter((row) => present.has(row.user_id)) : rows;
  };

  const awards = awardSocialBadges({
    championId,
    voice: board('voice'),
    text: board('text'),
    voiceFloorMinutes: BARD_MIN_MINUTES,
    textFloorMinutes: SCRIBE_MIN_MINUTES,
  });
  const caveDwellerIds = findCaveDwellers(guild, range);

  const displayNames = new Map();
  for (const userId of new Set([
    awards.bard?.user_id, awards.scribe?.user_id,
    ...awards.alsoTopped.keys(), ...(caveDwellerIds ?? []),
  ])) {
    if (!userId) continue;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) displayNames.set(userId, member.displayName);
  }
  return { awards, caveDwellerIds, displayNames };
}

/** The badge card for a period. Exported for the preview scripts. */
export async function buildBadgeCardFor(guild, range, championId) {
  const { awards, caveDwellerIds, displayNames } = await computeSocialBadges(guild, range, championId);
  return buildSocialBadgesEmbed(awards, {
    displayNames,
    range,
    bardRoleName: BARD_ROLE || null,
    scribeRoleName: SCRIBE_ROLE || null,
    bardFloorMinutes: BARD_MIN_MINUTES,
    scribeFloorMinutes: SCRIBE_MIN_MINUTES,
    caveDwellerRoleName: CAVE_DWELLER_ENABLED ? (CAVE_DWELLER_ROLE || null) : null,
    caveDwellerIds,
  });
}

/**
 * Decides the period's Bard, Scribe and Cave Dwellers, hands their roles over, and returns their
 * cards — or null when the feature is off or both talking badges are disabled.
 *
 * Runs whether or not anybody won the playtime title: the boards are independent, and a period
 * where nobody played is exactly the sort where the talkers should still be recognised.
 *
 * The champion is passed in by id only. Nothing here needs their role to exist yet, so this can be
 * settled before the playtime badge is handed over without the two interleaving.
 */
async function settleSocialBadges(guild, recap, championId) {
  if (!SOCIAL_ENABLED || (!BARD_ROLE && !SCRIBE_ROLE)) return null;
  const { range } = recap;
  const { awards, caveDwellerIds, displayNames } = await computeSocialBadges(guild, range, championId);

  // An unclaimed badge is stripped rather than left on last period's holder — that is what makes
  // "unclaimed" an outcome the recap can honestly report.
  const handOver = async (roleName, roleIcon, color, award) => {
    if (!roleName) return;
    if (!award) {
      await clearBadgeRole(guild, roleName)
        .catch((error) => console.error(`Could not clear the ${roleName} role:`, error));
      return;
    }
    await awardBadgeRole(guild, award.user_id, {
      roleName, roleIcon, color,
      siblingRoleNames: BADGE_ROLE_NAMES,
      reason: `${roleName} — social badge`,
      awardReason: `${roleName} — top of the board last ${range.periodNoun}`,
    }).catch((error) => console.error(`Could not award the ${roleName} role:`, error));
  };
  // Both share the slot directly beneath the bot's role, alongside Champion of the Realm. They
  // never need to be told apart by position, because nobody ever holds two.
  await handOver(BARD_ROLE, BARD_ROLE_ICON, BARD_ROLE_COLOR, awards.bard);
  await handOver(SCRIBE_ROLE, SCRIBE_ROLE_ICON, SCRIBE_ROLE_COLOR, awards.scribe);

  await applyCaveDwellerRole(guild, range, caveDwellerIds);

  // The awards travel back out alongside the card because `announceRecap` writes every badge
  // holder down in one place. Recording them here would split that record across two functions and
  // put a permanent write inside the half that renders — the separation `computeSocialBadges`
  // exists to keep.
  const embed = buildSocialBadgesEmbed(awards, {
    displayNames,
    range,
    bardRoleName: BARD_ROLE || null,
    scribeRoleName: SCRIBE_ROLE || null,
    bardFloorMinutes: BARD_MIN_MINUTES,
    scribeFloorMinutes: SCRIBE_MIN_MINUTES,
    caveDwellerRoleName: CAVE_DWELLER_ENABLED ? (CAVE_DWELLER_ROLE || null) : null,
    caveDwellerIds,
  });
  return { embed, awards };
}

/**
 * Writes down who took each badge, so a period leaves something behind once its roles move on.
 *
 * Called whether or not the recap reached a channel, for the same reason `markRecapAnnounced` is:
 * the roles were handed over regardless, and a badge worn but never recorded is a worse outcome
 * than one recorded but never posted. An unclaimed badge writes nothing — there is no holder to
 * name, and a row saying so would have to invent a member id.
 *
 * Taking a badge for the first time is also an achievement, evaluated here because this is the one
 * place that knows a badge changed hands. It is announced the way every other achievement is, ping
 * included — the recap itself deliberately pings nobody, but that rule is about a summary of things
 * that happened, and this is a thing the member did.
 */
async function recordRecapWinners(guild, recap, awards, now) {
  const periodKey = recap.range.key;
  const record = async (badge, userId, metricSeconds) => {
    if (!userId) return;
    db.recordRecapWinner({ guildId: guild.id, periodKey, badge, userId, metricSeconds }, now);
    const unlocked = evaluateRecapBadge(db, guild.id, userId, badge, now);
    if (!unlocked.length) return;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) await announceAchievements(member, unlocked).catch(console.error);
  };
  if (recap.winner) await record('champion', recap.winner.userId, recap.winner.totalSeconds);
  // The social boards are counted in minutes; the column is seconds for every badge, so they are
  // multiplied out here rather than leaving one row in a different unit from its neighbours.
  await record('bard', awards?.bard?.user_id, (awards?.bard?.voice_minutes ?? 0) * 60);
  await record('scribe', awards?.scribe?.user_id, (awards?.scribe?.text_minutes ?? 0) * 60);
}

/**
 * Gives the Cave Dweller role to everyone who did nothing at all last period, and takes it off
 * everyone else. Returns their ids so the card can name them, or null when the badge is off.
 *
 * Not an award and not ranked, so it cannot use the award pass: it lands on however many members
 * were absent, or on none. It also cannot collide with the other badges, and needs no rule saying
 * so — Champion has playtime above zero, Bard voice above zero and Scribe text above zero, while
 * this requires all three to be zero. The exclusion is arithmetic rather than policy.
 *
 * Switched off, this touches nothing at all rather than stripping the role from whoever has it.
 * Turning a setting off should not fire a burst of role edits across the server; deleting the role
 * in Discord is the way to clear it.
 */
function findCaveDwellers(guild, range) {
  if (!SOCIAL_ENABLED || !CAVE_DWELLER_ENABLED || !CAVE_DWELLER_ROLE) return null;
  const active = new Set(db.getActiveMemberIds(guild.id, range.start, range.end));
  const trackingStartedAt = db.getSocialTrackingStartedAt(guild.id);

  const dwellers = [];
  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    // Opting out means not being measured, which has to include not being labelled for the result.
    if (db.isOptedOut(guild.id, member.id)) continue;
    if (active.has(member.id)) continue;
    if (!eligibleForSilence({
      trackingStartedAt,
      joinedAt: member.joinedTimestamp ?? null,
      periodStart: range.start,
      graceMs: CAVE_DWELLER_GRACE_MS,
    })) continue;
    dwellers.push(member.id);
  }
  return dwellers;
}

/** Hands the inactivity badge to exactly this set of members. The write half of the pair above. */
async function applyCaveDwellerRole(guild, range, dwellers) {
  if (!dwellers) return;
  await syncBadgeRoleMembers(guild, dwellers, {
    roleName: CAVE_DWELLER_ROLE,
    roleIcon: CAVE_DWELLER_ROLE_ICON,
    color: CAVE_DWELLER_ROLE_COLOR,
    // Hoisted like the rest, so a badge always means its own section in the member list.
    hoist: true,
    // The one badge that goes to the *bottom* of the role list rather than the top. Discord orders
    // hoisted sections by role position, so this puts the Cave Dwellers at the foot of the member
    // list, under everybody — which is the right place for a badge that means "did nothing".
    //
    // It also means their rank role, sitting above it, keeps their name colour. That is the trade
    // and it is the right way round: somebody who ground their way to a rank should not be
    // recoloured grey for one quiet week, and the section already says everything the colour would.
    placement: 'bottom',
    siblingRoleNames: BADGE_ROLE_NAMES,
    reason: `${CAVE_DWELLER_ROLE} — inactivity badge`,
    awardReason: `${CAVE_DWELLER_ROLE} — nothing recorded last ${range.periodNoun}`,
  }).catch((error) => console.error('Could not settle the Cave Dweller role:', error));
}

/**
 * Posts the last completed period's recap once, on the first check after it ends. The period key is
 * recorded either way, so a quiet week is not retried forever and a restart cannot double-post.
 */
export async function announceRecap(guild, now = Date.now(), { force = false } = {}) {
  if (!force && !isRecapDue(db, guild.id, now, RECAP_PERIOD, RECAP_HOUR_UTC)) return null;
  const recap = buildRecap(db, guild.id, now, { period: RECAP_PERIOD, minSeconds: RECAP_MIN_SECONDS });
  const channel = findTextChannel(guild, RECAP_CHANNEL || ACHIEVEMENT_CHANNEL);

  // One post for the whole period. The badges are settled first so that whichever branch below
  // runs, its message carries the same companion card.
  const social = await settleSocialBadges(guild, recap, recap.winner?.userId ?? null)
    .catch((error) => {
      console.error('Could not settle the social badges:', error);
      return null;
    });
  const socialEmbed = social?.embed ?? null;

  if (!recap.winner) {
    // Nobody cleared the bar, so the badge comes off whoever held it and the period is announced
    // as unclaimed rather than passed over in silence.
    await clearWinnerRole(guild, RECAP_WINNER_ROLE).catch((error) =>
      console.error('Could not clear the winner role:', error));
    if (channel) {
      const embed = buildNoWinnerRecapEmbed(recap, {
        botAvatarUrl: client.user?.displayAvatarURL() ?? null,
        roleName: RECAP_WINNER_ROLE || null,
      });
      await channel.send({ embeds: [embed, socialEmbed].filter(Boolean) })
        .catch((error) => console.error('Could not post the recap:', error));
    }
    // No champion, but the talking badges are decided independently and may well have been given
    // out — a period nobody played is exactly the sort where they are the only thing that happened.
    await recordRecapWinners(guild, recap, social?.awards, now);
    markRecapAnnounced(db, guild.id, now, RECAP_PERIOD);
    return recap;
  }

  // Read before the row below is written, and with this period excluded, so the ordinal is the
  // same whether this is the first pass over the period or a forced repeat.
  const winNumber = db.getRecapWinCount(guild.id, recap.winner.userId, 'champion', recap.range.key) + 1;

  const role = await awardWinnerRole(guild, recap.winner.userId, {
    roleName: RECAP_WINNER_ROLE,
    roleIcon: RECAP_WINNER_ROLE_ICON,
    siblingRoleNames: BADGE_ROLE_NAMES,
  });

  if (channel) {
    const displayNames = new Map();
    for (const entry of recap.podium) {
      const member = await guild.members.fetch(entry.userId).catch(() => null);
      if (member) displayNames.set(entry.userId, member.displayName);
    }
    const winnerMember = await guild.members.fetch(recap.winner.userId).catch(() => null);
    const embed = buildRecapEmbed(recap, {
      displayNames,
      avatarUrl: winnerMember?.displayAvatarURL() ?? null,
      roleName: role?.name ?? null,
      winNumber,
    });
    await channel.send({ embeds: [embed, socialEmbed].filter(Boolean) })
      .catch((error) => console.error('Could not post the recap:', error));
  }
  await recordRecapWinners(guild, recap, social?.awards, now);
  markRecapAnnounced(db, guild.id, now, RECAP_PERIOD);
  return recap;
}

/**
 * Posts a fresh announcement for a recurring event that has just rolled on to its next occurrence,
 * and removes the one belonging to the occurrence that ended.
 *
 * Everything here is best-effort by design. `rollRecurringEvents` has already committed the new
 * start time, so a channel that has been deleted or a send that is refused costs the *post*, not
 * the schedule: the event still exists, `/event list` still shows it, and its reminders still fire.
 * That is the whole reason the row is advanced before this is called rather than by it.
 *
 * **Nobody is pinged.** The invite line on the previous announcement is not carried over, and the
 * previous occurrence's Going list is not re-pinged. Same rule the recap follows — an achievement
 * pings because it is a thing you did, and a series coming round again is a thing that happened.
 * The reminder stages still ping whoever signs up for this occurrence, which is the part somebody
 * actually chose.
 */
export async function announceEventOccurrence(eventId, previousMessageId) {
  const event = db.getEvent(eventId);
  if (!event) return;
  const guild = client.guilds.cache.get(event.guild_id);
  const channel = guild?.channels.cache.get(event.channel_id);
  if (!channel?.isTextBased()) {
    console.warn(`[EVENT] Event ${eventId} rolled forward, but its channel is gone — no announcement posted.`);
    return;
  }
  // First, so a failure here still leaves exactly one live announcement rather than none. The row
  // no longer points at this message either way, so a copy left behind is a stale post, not a
  // second card people can RSVP into and have answered the wrong occurrence.
  if (previousMessageId) {
    const old = await channel.messages.fetch(previousMessageId).catch(() => null);
    if (old) {
      await old.delete()
        .catch((error) => console.warn(`[EVENT] Could not delete the previous announcement for event ${eventId}:`, error));
    }
  }
  const message = await channel.send({
    embeds: [buildEventEmbed(event, db.getEventSignups(eventId))],
    components: buildEventComponents(eventId),
  }).catch((error) => {
    console.error(`[EVENT] Could not announce the next occurrence of event ${eventId}:`, error);
    return null;
  });
  if (message) db.setEventMessageId(eventId, message.id);
}
