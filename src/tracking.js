import { ActivityType } from 'discord.js';
import { db } from './runtime.js';
import { memberRef } from './log.js';
import {
  DEFAULT_ROLE_COLORS, LEVEL_UP_CHANNEL, PAUSE_ON_IDLE,
  SOCIAL_ENABLED, CAVE_DWELLER_ENABLED, CAVE_DWELLER_ROLE, UNRANKED_ROLE,
} from './config.js';
import {
  removeRankRoles, removeRoleByName, ensureMembersCached, ensureBadgeRole, UNRANKED_ROLE_COLOR,
} from './roles.js';
import { findTextChannel } from './ui.js';
import {
  RANKS, RANK_HOURS, formatHours, levelUpMessageTemplate, rankForSeconds, roleName, detectRankShift,
} from './ranks.js';
import {
  evaluateSessionStart, evaluateSessionEnd, evaluateSocialTiers, evaluateDuoDays,
} from './achievements.js';
import { announceAchievements, checkServerAchievements } from './announce.js';

/**
 * Presence in, sessions and roles out — the heart of the bot.
 *
 * `updateActivity` is the single place that starts/stops sessions, evaluates achievements and
 * reconciles rank roles. The 60-second checkpoint loop in index.js re-derives the same state for
 * sessions Discord has stopped sending events about; it does not duplicate the logic here.
 */

/**
 * Liveness counters for `/health`. Presence events are the bot's only real input, so "when did the
 * last one arrive" is the difference between a quiet server and Discord having stopped talking
 * to us — a distinction nothing else in the bot surfaces.
 */
export const trackerState = {
  startedAt: Date.now(),
  lastPresenceUpdateAt: null,
  lastCheckpointAt: null,
  presenceUpdates: 0,
};

export function playingGame(presence) {
  return presence?.activities.find((activity) => activity.type === ActivityType.Playing)?.name ?? null;
}

/**
 * Every rank role this guild actually has, matched by saved id **or** by name.
 *
 * The saved ids go stale: delete a rank role in Discord and recreate it and the id changes, while
 * `rank_roles` still points at the old one. The add path below already falls back to matching by
 * name for exactly that reason — the removal path did not, so a member whose role had been
 * recreated could rank up and quietly end up wearing two ranks at once, and the Cave Dweller strip
 * silently did nothing at all. Both now resolve the same way.
 */
function rankRoleIds(guild) {
  const saved = new Set(db.getRankRoles(guild.id).map((entry) => entry.role_id));
  const names = new Set(RANKS.map((rank) => roleName(rank)));
  return guild.roles.cache
    .filter((role) => saved.has(role.id) || names.has(role.name))
    .map((role) => role.id);
}

/** Whether this member is currently wearing the Cave Dweller badge. */
function isCaveDweller(member) {
  if (!CAVE_DWELLER_ENABLED || !CAVE_DWELLER_ROLE) return false;
  return member.roles.cache.some((role) => role.name === CAVE_DWELLER_ROLE);
}

/**
 * Takes the Cave Dweller badge off a member who has just done something, and gives them their rank
 * back in the same breath.
 *
 * The badge is a state rather than an award: it stops being true the instant somebody turns up, so
 * it comes off on the spot rather than at the next recap. Restoring the rank here rather than
 * waiting for the next presence update matters — a member who only typed a message might not
 * produce one for hours, and would be left with no rank role in the meantime.
 *
 * Cheap enough to call on every message: `removeRoleByName` makes no API call unless the member
 * actually holds the badge, and `syncRank` is skipped entirely in that overwhelmingly common case.
 */
export async function noteSociallyActive(member) {
  if (!SOCIAL_ENABLED || !CAVE_DWELLER_ENABLED || !CAVE_DWELLER_ROLE || !member) return;
  const had = await removeRoleByName(member, CAVE_DWELLER_ROLE);
  if (had) await syncRank(member).catch(console.error);
}

/**
 * Puts the starting role on a member who has not reached the first rank, or takes it off one who
 * has. A no-op when UNRANKED_ROLE is blank, which is the default.
 *
 * This is a name for unranked, not a rank. It is deliberately outside RANK_NAMES so that no stat
 * can see it: rankForSeconds still answers -1 for these members, the leaderboard sorts them exactly
 * as before, and the achievements that gate on having reached the first rank keep their meaning.
 */
async function applyUnrankedRole(member, unranked) {
  if (!UNRANKED_ROLE) return;
  if (!unranked) { await removeRoleByName(member, UNRANKED_ROLE); return; }
  const role = await ensureBadgeRole(member.guild, {
    roleName: UNRANKED_ROLE,
    color: UNRANKED_ROLE_COLOR,
    // Beneath every rank, where a member who has not earned one belongs.
    placement: 'bottom',
    reason: `${UNRANKED_ROLE} — starting role`,
  });
  if (!role || member.roles.cache.has(role.id)) return;
  await member.roles.add(role, `${UNRANKED_ROLE} — not yet ranked`)
    .catch((error) => console.error(`Could not give the ${UNRANKED_ROLE} role to ${memberRef(member.id)}:`, error));
}

export async function syncRank(member) {
  if (member.user.bot) return;
  // A Cave Dweller wears no rank while they hold the badge. On a server that hoists its rank roles
  // — which this bot never does, but plenty of servers do by hand — a hoisted rank sitting above
  // the badge would decide the member's section and hide it completely. Removing the rank is the
  // only way the badge can be their lowest *and* highest hoisted role, which is what puts them at
  // the foot of the member list. Nothing is lost: hours and rank live in the database, and the
  // role is rebuilt the moment they do anything.
  if (isCaveDweller(member)) {
    await removeRankRoles(member, rankRoleIds(member.guild), `Wearing ${CAVE_DWELLER_ROLE}`);
    // The starting role goes too. It is not a rank, but it is hoisted and sits above the badge, so
    // leaving it on would decide the member's section and hide the thing being awarded.
    await removeRoleByName(member, UNRANKED_ROLE);
    return false;
  }
  const total = db.getTotalSeconds(member.guild.id, member.id);
  const rankIndex = rankForSeconds(total);
  const rankRoles = db.getRankRoles(member.guild.id);
  const trackedRoleIds = new Set(rankRoleIds(member.guild));
  const targetId = rankRoles.find((entry) => entry.rank_index === rankIndex)?.role_id;
  const target = targetId ? member.guild.roles.cache.get(targetId) : (rankIndex >= 0 ? member.guild.roles.cache.find((role) => role.name === roleName(RANKS[rankIndex])) : null);
  const roles = member.guild.roles.cache.filter((role) => trackedRoleIds.has(role.id));
  const remove = roles.filter((role) => role.id !== target?.id && member.roles.cache.has(role.id));
  if (remove.size) await member.roles.remove(remove, 'Game tracker rank changed');
  await applyUnrankedRole(member, rankIndex < 0);
  if (!target) return roles.size > 0; // No rank below the first configured threshold.
  if (!member.roles.cache.has(target.id)) await member.roles.add(target, 'Game tracker rank changed');
  return true;
}

export async function announceRankUp(member, oldRank) {
  const seconds = db.getTotalSeconds(member.guild.id, member.id);
  const newRank = rankForSeconds(seconds);
  if (newRank <= oldRank) return;

  // LEVEL_UP_CHANNEL wins when set, so rank-ups can be moved without re-running /setup somewhere
  // else. Without it, they keep going wherever /setup was last run, as before.
  const channelId = db.getNotificationChannel(member.guild.id);
  const channel = LEVEL_UP_CHANNEL
    ? findTextChannel(member.guild, LEVEL_UP_CHANNEL)
    : (channelId ? member.guild.channels.cache.get(channelId) : null);
  if (!channel?.isTextBased()) return;

  const message = levelUpMessageTemplate(newRank)
    .replaceAll('{user}', `${member}`)
    .replaceAll('{level}', newRank + 1)
    .replaceAll('{rank}', RANKS[newRank])
    .replaceAll('{hours}', formatHours(RANK_HOURS[newRank]));
  await channel.send(message);
}

export async function reconcileRank(member, oldRank) {
  const roleWasSynced = await syncRank(member);
  if (roleWasSynced) await announceRankUp(member, oldRank);
}

export async function updateActivity(member, presence) {
  if (member.user.bot) return;
  trackerState.lastPresenceUpdateAt = Date.now();
  trackerState.presenceUpdates += 1;
  // Opted out: no session, no achievements, no rank reconciliation, no announcements. This is the
  // single gate for the whole write path — everything downstream of a presence event runs from
  // here, so nothing else needs to re-check. The counters above still move, because /health is
  // asking whether the gateway is alive, not whether anyone is being recorded.
  if (db.isOptedOut(member.guild.id, member.id)) return;
  const oldRank = rankForSeconds(db.getTotalSeconds(member.guild.id, member.id));
  const game = playingGame(presence);
  const now = Date.now();

  if (game) {
    const { changed, previous } = db.startSession(member.guild.id, member.id, game, now);
    // Playing counts as turning up, so the Cave Dweller badge comes off here too — that badge is
    // for members who did *nothing*, not merely for members who did not talk.
    noteSociallyActive(member);
    // Discord reports "idle" after about ten minutes without input while still naming the game.
    // Stop the clock on it and restart only once the member is genuinely back at the keyboard.
    // A status flip carries no `changed`, so this has to run outside that branch.
    const idleChanged = PAUSE_ON_IDLE && presence?.status === 'idle'
      ? db.pauseSession(member.guild.id, member.id, now)
      : db.resumeSession(member.guild.id, member.id, now);
    if (changed) {
      if (previous) {
        await announceAchievements(member, evaluateSessionEnd(db, member.guild.id, member.id, previous, now));
      }
      await announceAchievements(member, evaluateSessionStart(db, member.guild.id, member.id, game, now));

      for (const { userId, unlocked } of evaluateSocialTiers(db, member.guild.id, game, now)) {
        const target = userId === member.id ? member : await member.guild.members.fetch(userId).catch(() => null);
        if (target) await announceAchievements(target, unlocked);
      }
      for (const { userId, unlocked } of evaluateDuoDays(db, member.guild.id, game, now)) {
        const target = userId === member.id ? member : await member.guild.members.fetch(userId).catch(() => null);
        if (target) await announceAchievements(target, unlocked);
      }
    }
    if (!changed && !idleChanged) {
      // A presence event that touched neither the game nor the idle state (a custom status edit,
      // a Spotify update, mobile to desktop) banked no time, so no rank or server milestone can
      // have moved. Reconciling the rank is still cheap and repairs a manually removed role; the
      // server-achievement sweep is not, and the 60s tick runs it for every guild anyway.
      await reconcileRank(member, oldRank);
      return;
    }
  } else {
    const previous = db.stopSession(member.guild.id, member.id, now);
    if (!previous) {
      // Not playing now and was not playing before — the overwhelming majority of presence events
      // on a busy server. Same reasoning as above: nothing banked, nothing to sweep for.
      await reconcileRank(member, oldRank);
      return;
    }
    await announceAchievements(member, evaluateSessionEnd(db, member.guild.id, member.id, previous, now));
  }
  await reconcileRank(member, oldRank);
  await checkServerAchievements(member.guild).catch(console.error);
}

/**
 * Thrown by `setupRoles` when RANK_NAMES looks like it was reordered or had a rank inserted rather
 * than renamed — see `detectRankShift`. Deliberately stops before renaming anything: silently
 * "repairing" this would be the same silent demotion the check exists to catch.
 */
export class RankShiftDetected extends Error {
  constructor(shifts) {
    const detail = shifts
      .map(({ name, savedIndex, foundIndex }) => `"${name}" was rank ${savedIndex + 1}, now looks like rank ${foundIndex + 1}`)
      .join('; ');
    super(
      `RANK_NAMES looks like it was reordered or had a rank inserted, not just renamed (${detail}). `
      + 'Renaming roles now would silently shift who holds which rank. Stop the bot, delete this '
      + "guild's rank_roles rows, restart it and run /setup again — with no saved mapping it "
      + 'matches every role by name instead.',
    );
    this.shifts = shifts;
  }
}

export async function setupRoles(guild) {
  const rankRoles = db.getRankRoles(guild.id);
  const roleNames = new Map(guild.roles.cache.map((role) => [role.id, role.name]));
  const shifts = detectRankShift(rankRoles, roleNames);
  if (shifts.length) throw new RankShiftDetected(shifts);
  const savedRoles = new Map(rankRoles.map((entry) => [entry.rank_index, entry.role_id]));
  const legacyRoles = [...guild.roles.cache.values()]
    .filter((role) => role.name.startsWith('Game Tracker | ') && ![...savedRoles.values()].includes(role.id))
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  for (const [index, rank] of RANKS.entries()) {
    const name = roleName(rank);
    let role = guild.roles.cache.get(savedRoles.get(index));
    role ??= guild.roles.cache.find((candidate) => candidate.name === name);
    role ??= legacyRoles.shift();
    if (role) {
      if (role.name !== name) await role.setName(name, 'Game tracker rank configuration changed');
    } else {
      role = await guild.roles.create({
        name,
        color: DEFAULT_ROLE_COLORS[index % DEFAULT_ROLE_COLORS.length],
        reason: `Game tracker rank ${index + 1}`,
      });
    }
    db.saveRankRole(guild.id, index, role.id);
  }
}

export async function syncGuildRanks(guild) {
  await ensureMembersCached(guild);
  for (const member of guild.members.cache.values()) {
    await syncRank(member).catch((error) => console.error(`Could not sync rank for ${memberRef(member.id)}:`, error));
  }
}
