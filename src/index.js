import 'dotenv/config';
import {
  Client, Events, GatewayIntentBits, ActivityType, PermissionFlagsBits, SlashCommandBuilder, escapeMarkdown,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, MessageFlags,
} from 'discord.js';
import { openDatabase } from './database.js';
import { memberRef } from './log.js';
import { RANKS, RANK_HOURS, formatHours, formatPlayTime, levelUpMessageTemplate, rankForSeconds, roleName } from './ranks.js';
import {
  ACHIEVEMENTS, achievementById, getUnlockedAchievements, evaluateSessionStart, evaluateSessionEnd,
  evaluateOngoingSession, evaluateSocialTiers, evaluateDuoDays, evaluateTouchGrass,
  LONGEST_SESSION_ACHIEVEMENT_MS,
} from './achievements.js';
import {
  SERVER_ACHIEVEMENTS, serverAchievementById, getUnlockedServerAchievements, evaluateServerAchievements,
} from './serverAchievements.js';
import { parseEventTime, formatEventTime, collectDueReminders } from './events.js';
import { buildAchievementEmbed, buildServerAchievementEmbed, buildRecapEmbed, buildNoWinnerRecapEmbed } from './embeds.js';
import { buildRecap, isRecapDue, markRecapAnnounced, RECAP_PERIODS } from './recap.js';
import { awardWinnerRole, clearWinnerRole } from './roles.js';

if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is missing. Copy .env.example to .env and add your token.');

// Defaults to data/tracker.sqlite. Point DATABASE_PATH at a throwaway file to try the bot against
// a test server without writing to the real one.
const db = openDatabase(process.env.DATABASE_PATH?.trim() || undefined);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences],
});

const commands = [
  new SlashCommandBuilder().setName('setup').setDescription(`Create the ${RANKS.length} game-tracker rank roles`)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('stats').setDescription('Show an interactive gaming profile card')
    .addUserOption((option) => option.setName('member').setDescription('Member to look up (defaults to you)')),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show the top tracked players'),
  new SlashCommandBuilder().setName('info').setDescription('Show the server’s game tracker rank progression'),
  new SlashCommandBuilder().setName('server').setDescription('Show this server’s gaming statistics'),
  new SlashCommandBuilder().setName('changes').setDescription('Post the configured game tracker update')
    .addBooleanOption((option) => option.setName('force').setDescription('Post the latest release even if it was announced already'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('event').setDescription('Schedule a game night and let people sign up')
    .addSubcommand((sub) => sub.setName('create').setDescription('Announce a new event (opens a form)'))
    .addSubcommand((sub) => sub.setName('list').setDescription('List and manage upcoming events')),
].map((command) => command.toJSON());

const DEFAULT_ROLE_COLORS = [
  0xFFFFFF, // white
  0x57F287, // green
  0x3498DB, // blue
  0xFEE75C, // yellow
  0xE67E22, // orange
  0xED4245, // red
  0x9B59B6, // purple
];

const DEFAULT_RANK_EMOJIS = ['⬜', '🟩', '🟦', '🟨', '🟧', '🟥', '🟪'];

function playingGame(presence) {
  return presence?.activities.find((activity) => activity.type === ActivityType.Playing)?.name ?? null;
}

const ACHIEVEMENT_ANNOUNCEMENTS = process.env.ACHIEVEMENT_ANNOUNCEMENTS?.trim().toLowerCase() !== 'false';
const ACHIEVEMENT_CHANNEL = process.env.ACHIEVEMENT_CHANNEL?.trim();
const LEVEL_UP_CHANNEL = process.env.LEVEL_UP_CHANNEL?.trim();

const RECAP_ENABLED = process.env.RECAP_ENABLED?.trim().toLowerCase() !== 'false';
const RECAP_CHANNEL = process.env.RECAP_CHANNEL?.trim();
const RECAP_PERIOD = (process.env.RECAP_PERIOD?.trim().toLowerCase() || 'week');
if (!RECAP_PERIODS.includes(RECAP_PERIOD)) {
  throw new Error(`RECAP_PERIOD must be one of ${RECAP_PERIODS.join(', ')} — got "${RECAP_PERIOD}".`);
}
// Blank disables the badge entirely; the recap is still posted.
const RECAP_WINNER_ROLE = process.env.RECAP_WINNER_ROLE?.trim() ?? 'Champion of the Realm';
const RECAP_WINNER_ROLE_ICON = process.env.RECAP_WINNER_ROLE_ICON?.trim();
// Minimum tracked playtime needed to take the title at all, so a stray few minutes on a quiet
// week doesn't crown anyone. 0 means anyone with any tracked play qualifies.
const RECAP_MIN_HOURS = Number(process.env.RECAP_MIN_HOURS ?? '2');
if (!Number.isFinite(RECAP_MIN_HOURS) || RECAP_MIN_HOURS < 0) {
  throw new Error(`RECAP_MIN_HOURS must be a non-negative number — got "${process.env.RECAP_MIN_HOURS}".`);
}
const RECAP_MIN_SECONDS = Math.round(RECAP_MIN_HOURS * 3600);
// Anti-idle tracking. Discord flips a member to "idle" after roughly ten minutes without input but
// keeps reporting whatever game is still open, so a launcher left running overnight would otherwise
// bank a full night of playtime and outrank everyone who actually played.
const HOUR_MS = 60 * 60 * 1000;
const PAUSE_ON_IDLE = process.env.PAUSE_ON_IDLE?.trim().toLowerCase() !== 'false';
// Backstop for the case idle never catches: a mouse jiggler, or a client that simply never reports
// idle. Must stay above the longest session-length achievement or that badge becomes unreachable.
const MAX_SESSION_HOURS = Number(process.env.MAX_SESSION_HOURS ?? '12');
if (!Number.isFinite(MAX_SESSION_HOURS) || MAX_SESSION_HOURS < 0) {
  throw new Error(`MAX_SESSION_HOURS must be a non-negative number — got "${process.env.MAX_SESSION_HOURS}".`);
}
if (MAX_SESSION_HOURS > 0 && MAX_SESSION_HOURS * HOUR_MS <= LONGEST_SESSION_ACHIEVEMENT_MS) {
  console.warn(
    `MAX_SESSION_HOURS is ${MAX_SESSION_HOURS}h, at or below the longest session-length achievement `
    + `(${LONGEST_SESSION_ACHIEVEMENT_MS / HOUR_MS}h). That achievement can no longer be earned.`,
  );
}
const MAX_SESSION_MS = MAX_SESSION_HOURS > 0 ? MAX_SESSION_HOURS * HOUR_MS : 0;

function parseTimezonePresets(value) {
  const zones = value ? value.split(',').map((zone) => zone.trim()).filter(Boolean) : ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Tokyo'];
  if (zones.length > 25) throw new Error('EVENT_TIMEZONE_PRESETS has more than 25 entries — Discord select menus support at most 25 options.');
  return zones.map((zone) => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch {
      throw new Error(`EVENT_TIMEZONE_PRESETS zone "${zone}" is not a valid IANA timezone (e.g. Europe/Madrid, America/Chicago, UTC).`);
    }
    return { label: zone.split('/').pop().replace(/_/g, ' '), value: zone };
  });
}
const EVENT_TIMEZONE_PRESETS = parseTimezonePresets(process.env.EVENT_TIMEZONE_PRESETS?.trim());
const EVENT_REMINDER_STAGES_MINUTES = (process.env.EVENT_REMINDER_STAGES_MINUTES ?? '720,60,0')
  .split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value >= 0)
  .sort((a, b) => b - a);

/** Finds a text channel by name, the way every configured channel in .env is resolved. */
function findTextChannel(guild, name) {
  if (!name) return null;
  return guild.channels.cache.find((candidate) => candidate.isTextBased() && candidate.name === name) ?? null;
}

async function announceAchievements(member, achievementIds) {
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

async function announceServerAchievements(guild, unlockedTiers) {
  if (!ACHIEVEMENT_ANNOUNCEMENTS || !unlockedTiers?.length || !ACHIEVEMENT_CHANNEL) return;
  const channel = findTextChannel(guild, ACHIEVEMENT_CHANNEL);
  if (!channel) return;
  for (const tier of unlockedTiers) {
    const embed = buildServerAchievementEmbed(tier, guild.iconURL() ?? null);
    await channel.send({ embeds: [embed] }).catch((error) => console.error('Could not announce server achievement:', error));
  }
}

async function checkServerAchievements(guild) {
  const { unlocked } = evaluateServerAchievements(db, guild.id);
  await announceServerAchievements(guild, unlocked);
}


/**
 * Posts the last completed period's recap once, on the first check after it ends. The period key is
 * recorded either way, so a quiet week is not retried forever and a restart cannot double-post.
 */
async function announceRecap(guild, now = Date.now(), { force = false } = {}) {
  if (!force && !isRecapDue(db, guild.id, now, RECAP_PERIOD)) return null;
  const recap = buildRecap(db, guild.id, now, { period: RECAP_PERIOD, minSeconds: RECAP_MIN_SECONDS });
  const channel = findTextChannel(guild, RECAP_CHANNEL || ACHIEVEMENT_CHANNEL);

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
      await channel.send({ embeds: [embed] })
        .catch((error) => console.error('Could not post the recap:', error));
    }
    markRecapAnnounced(db, guild.id, now, RECAP_PERIOD);
    return recap;
  }

  const role = await awardWinnerRole(guild, recap.winner.userId, {
    roleName: RECAP_WINNER_ROLE,
    roleIcon: RECAP_WINNER_ROLE_ICON,
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
    });
    await channel.send({ content: `<@${recap.winner.userId}>`, embeds: [embed] })
      .catch((error) => console.error('Could not post the recap:', error));
  }
  markRecapAnnounced(db, guild.id, now, RECAP_PERIOD);
  return recap;
}

const CARD_TABS = [
  { id: 'stats', label: '📊 Statistics' },
  { id: 'games', label: '🎮 Games' },
  { id: 'achievements', label: '🏆 Achievements' },
  { id: 'leaderboard', label: '📈 Leaderboard' },
  { id: 'server', label: '🏰 Server' },
];
const ACHIEVEMENTS_PAGE_SIZE = 8;
const CARD_ACCENT_COLOR = 0x5865F2;

async function leaderboardLines(rows, guild, { showRank = true } = {}) {
  if (!rows.length) return null;
  return Promise.all(rows.map(async (row, index) => {
    const member = await guild.members.fetch(row.user_id).catch(() => null);
    const nickname = member ? escapeMarkdown(member.displayName) : 'Former member';
    const prefix = showRank ? `**${RANKS[rankForSeconds(row.total_seconds)] ?? 'Unranked'}** ` : '';
    return `${index + 1}. ${prefix}${nickname} — **${formatPlayTime(row.total_seconds)}**`;
  }));
}

async function buildLeaderboardLines(guild) {
  const lines = await leaderboardLines(db.getLeaderboard(guild.id), guild);
  return lines ?? ['No tracked play time yet.'];
}

async function buildMonthlyLeaderboardLines(guild) {
  const now = Date.now();
  const nowDate = new Date(now);
  const monthStart = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1);
  const lines = await leaderboardLines(db.getMonthlyLeaderboard(guild.id, monthStart, now), guild, { showRank: false });
  return lines ?? ['No tracked play time yet this month.'];
}

async function buildServerProfileParts(guild) {
  const profile = db.getServerProfile(guild.id);
  const medals = ['🥇', '🥈', '🥉'];
  const topGames = profile.topGames.length
    ? profile.topGames.map((game, index) => `└ ${medals[index]} ${escapeMarkdown(game.game_name)} — **${formatPlayTime(game.total_seconds)}**`)
    : ['└ No game activity recorded yet'];
  const topPlayers = profile.topPlayers.length
    ? await Promise.all(profile.topPlayers.map(async (row, index) => {
        const member = await guild.members.fetch(row.user_id).catch(() => null);
        const name = escapeMarkdown(member?.displayName ?? 'Former member');
        return `└ ${medals[index]} ${name} — **${formatPlayTime(row.total_seconds)}**`;
      }))
    : ['└ No player activity recorded yet'];
  return { profile, topGames, topPlayers };
}

function buildEventEmbed(event, signups) {
  const going = signups.filter((row) => row.status === 'going');
  const maybe = signups.filter((row) => row.status === 'maybe');
  const unixSeconds = Math.floor(event.starts_at / 1000);
  const embed = new EmbedBuilder()
    .setColor(CARD_ACCENT_COLOR)
    .setTitle(event.title)
    .addFields({ name: '🗓️ When', value: `<t:${unixSeconds}:F>\n<t:${unixSeconds}:R>`, inline: true });
  if (event.description) embed.setDescription(event.description);
  if (event.game_name) embed.addFields({ name: '🎮 Game', value: event.game_name, inline: true });
  embed.addFields({
    name: `✅ Going (${going.length})`,
    value: going.length ? going.map((row) => `<@${row.user_id}>`).join(', ') : 'Nobody yet — be the first!',
  });
  if (maybe.length) embed.addFields({ name: `🤔 Maybe (${maybe.length})`, value: maybe.map((row) => `<@${row.user_id}>`).join(', ') });
  return embed;
}

function buildEventComponents(eventId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`event:going:${eventId}`).setLabel("I'm in").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`event:maybe:${eventId}`).setLabel('Maybe').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`event:declined:${eventId}`).setLabel("Can't make it").setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`event:edit:${eventId}`).setLabel('✏️ Edit').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`event:delete:${eventId}`).setLabel('🗑️ Delete').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildEventModal(customId, title, timezoneLabel, values = {}) {
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short)
        .setValue(values.title ?? '').setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('at').setLabel(`Start (DD-MM-YYYY HH:mm), ${timezoneLabel}`).setStyle(TextInputStyle.Short)
        .setValue(values.at ?? '').setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('game').setLabel('Game (optional)').setStyle(TextInputStyle.Short)
        .setValue(values.game ?? '').setRequired(false),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('description').setLabel('Description (optional)').setStyle(TextInputStyle.Paragraph)
        .setValue(values.description ?? '').setRequired(false),
    ),
  );
}

function buildTimezoneSelectRow(customId) {
  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Choose a timezone for this event')
      .addOptions(EVENT_TIMEZONE_PRESETS.map((preset) => ({ label: preset.label, value: preset.value }))),
  )];
}

function timezoneLabelFor(zone) {
  return EVENT_TIMEZONE_PRESETS.find((preset) => preset.value === zone)?.label ?? zone;
}

/** After an edit/delete triggered somewhere other than the original announcement (e.g. via /event list),
 *  keep the original channel message in sync too, so it doesn't show stale info or dead buttons. */
async function syncOriginalEventMessage(event, interaction, embed, components) {
  if (!event.message_id || event.message_id === interaction.message?.id) return;
  const guild = client.guilds.cache.get(event.guild_id);
  const channel = guild?.channels.cache.get(event.channel_id);
  if (!channel?.isTextBased()) return;
  const original = await channel.messages.fetch(event.message_id).catch(() => null);
  if (original) await original.edit({ embeds: [embed], components }).catch(() => {});
}

function buildCardComponents(view, targetUserId, requesterId, page = 0, totalPages = 1) {
  const buttons = CARD_TABS.map(({ id, label }) => new ButtonBuilder()
    .setCustomId(`card:${id}:${targetUserId}:${requesterId}:tab`)
    .setLabel(label)
    .setStyle(id === view ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(id === view));
  const rows = [new ActionRowBuilder().addComponents(buttons)];
  if ((view === 'achievements' || view === 'server' || view === 'leaderboard') && totalPages > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`card:${view}:${targetUserId}:${requesterId}:${page - 1}`)
        .setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`card:${view}:${targetUserId}:${requesterId}:pageinfo`)
        .setLabel(`Page ${page + 1}/${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`card:${view}:${targetUserId}:${requesterId}:${page + 1}`)
        .setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    ));
  }
  return rows;
}

async function buildCardEmbed(view, guild, member, user, requestedPage = 0) {
  const embed = new EmbedBuilder();
  let page = 0;
  let totalPages = 1;

  if (view === 'leaderboard') {
    totalPages = 2;
    page = Math.min(Math.max(0, requestedPage), totalPages - 1);
    embed.setColor(CARD_ACCENT_COLOR);
    if (page === 0) {
      embed.setTitle('📈 Leaderboard — All-Time').setDescription((await buildLeaderboardLines(guild)).join('\n'));
    } else {
      embed.setTitle('📈 Leaderboard — This Month').setDescription((await buildMonthlyLeaderboardLines(guild)).join('\n'));
    }
  } else if (view === 'server') {
    const { profile, topGames, topPlayers } = await buildServerProfileParts(guild);
    const serverAchievements = getUnlockedServerAchievements(db, guild.id);
    const achievementPages = Math.max(1, Math.ceil(serverAchievements.length / ACHIEVEMENTS_PAGE_SIZE));
    totalPages = 1 + achievementPages;
    page = Math.min(Math.max(0, requestedPage), totalPages - 1);

    embed.setColor(CARD_ACCENT_COLOR);

    if (page === 0) {
      embed.setTitle('🏰 Server Stats').addFields(
        { name: '⏱️ Total gaming time', value: formatPlayTime(profile.totalSeconds), inline: true },
        { name: '🏆 Most played games', value: topGames.join('\n'), inline: false },
        { name: '🔥 Most active players', value: topPlayers.join('\n'), inline: false },
        { name: '🏆 Server achievements', value: `${serverAchievements.length}/${SERVER_ACHIEVEMENTS.length}`, inline: false },
      );
    } else {
      const achievementPage = page - 1;
      const pageItems = serverAchievements.slice(achievementPage * ACHIEVEMENTS_PAGE_SIZE, (achievementPage + 1) * ACHIEVEMENTS_PAGE_SIZE);
      const list = pageItems.length
        ? pageItems.map((row) => {
            const achievement = serverAchievementById(row.achievement_id);
            return achievement ? `${achievement.emoji} **${achievement.name}** — ${achievement.description}` : null;
          }).filter(Boolean).join('\n')
        : 'None yet — keep growing!';
      embed.setTitle('🏆 Server Achievements').setDescription(list);
    }
  } else {
    const profileName = escapeMarkdown(member?.displayName ?? user.username);
    const profile = db.getPlayerProfile(guild.id, user.id, Date.now(), view === 'games' ? 10 : 3);
    const rankIndex = rankForSeconds(profile.totalSeconds);
    const rank = RANKS[rankIndex] ?? 'Unranked';
    const level = rankIndex >= 0 ? `Level ${rankIndex + 1} — ${rank}` : 'Level 0 — Unranked';

    embed.setColor(rankIndex >= 0 ? DEFAULT_ROLE_COLORS[rankIndex % DEFAULT_ROLE_COLORS.length] : 0x99AAB5)
      .setAuthor({ name: `${profileName}'s Profile`, iconURL: (member ?? user).displayAvatarURL() });

    if (view === 'games') {
      embed.setTitle('🎮 Games').setDescription(profile.topGames.length
        ? profile.topGames.map((game, index) => `**${index + 1}.** ${escapeMarkdown(game.game_name)} — ${formatPlayTime(game.total_seconds)}`).join('\n')
        : 'No game activity recorded yet.');
    } else if (view === 'achievements') {
      const achievements = getUnlockedAchievements(db, guild.id, user.id);
      totalPages = Math.max(1, Math.ceil(achievements.length / ACHIEVEMENTS_PAGE_SIZE));
      page = Math.min(Math.max(0, requestedPage), totalPages - 1);
      const pageItems = achievements.slice(page * ACHIEVEMENTS_PAGE_SIZE, (page + 1) * ACHIEVEMENTS_PAGE_SIZE);
      const list = pageItems.length
        ? pageItems.map((row) => {
            const achievement = achievementById(row.achievement_id);
            return achievement ? `${achievement.emoji} **${achievement.name}** — ${achievement.description}` : null;
          }).filter(Boolean).join('\n')
        : 'None yet — keep playing!';
      embed.setTitle('🏆 Achievements')
        .setDescription(`**${achievements.length}/${ACHIEVEMENTS.length}** unlocked`)
        .addFields({ name: 'Unlocked', value: list });
    } else {
      const achievements = getUnlockedAchievements(db, guild.id, user.id);
      embed.setTitle('📊 Statistics').addFields(
        { name: '⭐ Rank', value: level, inline: true },
        { name: '⏱️ Total playtime', value: formatPlayTime(profile.totalSeconds), inline: true },
        { name: '🎯 This month', value: formatPlayTime(profile.monthSeconds), inline: true },
        { name: '🔥 Longest session', value: formatPlayTime(profile.longestSeconds), inline: true },
        { name: '🎮 Games played', value: `${profile.gamesPlayed}`, inline: true },
        { name: '🏆 Achievements', value: `${achievements.length}/${ACHIEVEMENTS.length}`, inline: true },
      );
    }
  }
  return { embed, page, totalPages };
}

function splitDiscordMessage(content, maxLength = 2000) {
  const chunks = [];
  let remaining = content;
  while (remaining.length > maxLength) {
    const boundary = Math.max(remaining.lastIndexOf('\n', maxLength), remaining.lastIndexOf(' ', maxLength));
    const cutAt = boundary > 0 ? boundary : maxLength;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function fetchLatestRelease(repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must use the format owner/repository.');
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Discord-Game-Tracker',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, { headers });
  if (response.status === 404) throw new Error('No published GitHub Release was found yet.');
  if (!response.ok) throw new Error(`GitHub could not load the latest release (HTTP ${response.status}).`);
  return response.json();
}

/** Drops a release body's own leading title line if it has one, so it never duplicates the
 *  header this command already adds. Only strips a line that is bold end-to-end (e.g.
 *  "**📣 Game Tracker v1.0.0**") — a line that merely starts with bold text is left alone,
 *  so normal release notes are never touched by accident. */
function stripLeadingTitleLine(body) {
  const lines = body.split('\n');
  if (lines[0] && /^\*\*.+\*\*$/.test(lines[0].trim())) {
    lines.shift();
    while (lines[0] === '') lines.shift();
  }
  return lines.join('\n');
}

async function syncRank(member) {
  if (member.user.bot) return;
  const total = db.getTotalSeconds(member.guild.id, member.id);
  const rankIndex = rankForSeconds(total);
  const rankRoles = db.getRankRoles(member.guild.id);
  const trackedRoleIds = new Set(rankRoles.map((entry) => entry.role_id));
  const targetId = rankRoles.find((entry) => entry.rank_index === rankIndex)?.role_id;
  const target = targetId ? member.guild.roles.cache.get(targetId) : (rankIndex >= 0 ? member.guild.roles.cache.find((role) => role.name === roleName(RANKS[rankIndex])) : null);
  const roles = member.guild.roles.cache.filter((role) => trackedRoleIds.has(role.id));
  const remove = roles.filter((role) => role.id !== target?.id && member.roles.cache.has(role.id));
  if (remove.size) await member.roles.remove(remove, 'Game tracker rank changed');
  if (!target) return roles.size > 0; // No rank below the first configured threshold.
  if (!member.roles.cache.has(target.id)) await member.roles.add(target, 'Game tracker rank changed');
  return true;
}

async function announceRankUp(member, oldRank) {
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

async function reconcileRank(member, oldRank) {
  const roleWasSynced = await syncRank(member);
  if (roleWasSynced) await announceRankUp(member, oldRank);
}

async function updateActivity(member, presence) {
  if (member.user.bot) return;
  const oldRank = rankForSeconds(db.getTotalSeconds(member.guild.id, member.id));
  const game = playingGame(presence);
  const now = Date.now();

  if (game) {
    const { changed, previous } = db.startSession(member.guild.id, member.id, game, now);
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

async function setupRoles(guild) {
  const savedRoles = new Map(db.getRankRoles(guild.id).map((entry) => [entry.rank_index, entry.role_id]));
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

async function syncGuildRanks(guild) {
  await guild.members.fetch();
  for (const member of guild.members.cache.values()) {
    await syncRank(member).catch((error) => console.error(`Could not sync rank for ${memberRef(member.id)}:`, error));
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  for (const guild of readyClient.guilds.cache.values()) {
    const scope = process.env.GUILD_ID ? (guild.id === process.env.GUILD_ID ? guild : null) : guild;
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

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.guild) return;
  try {
    if (interaction.isButton() && interaction.customId.startsWith('card:')) {
      const [, view, targetUserId, requesterId, pageStr] = interaction.customId.split(':');
      if (interaction.user.id !== requesterId) {
        await interaction.reply({ content: 'Only the person who ran `/stats` can use these buttons — run it yourself to get your own.', flags: MessageFlags.Ephemeral });
        return;
      }
      const user = await client.users.fetch(targetUserId).catch(() => null);
      if (!user) return;
      const member = await interaction.guild.members.fetch(targetUserId).catch(() => null);
      const { embed, page, totalPages } = await buildCardEmbed(view, interaction.guild, member, user, parseInt(pageStr, 10) || 0);
      await interaction.update({
        embeds: [embed],
        components: buildCardComponents(view, targetUserId, requesterId, page, totalPages),
      });
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith('event:')) {
      const [, action, eventIdStr] = interaction.customId.split(':');
      const eventId = Number(eventIdStr);
      const event = db.getEvent(eventId);
      if (!event) {
        await interaction.reply({ content: 'This event no longer exists.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (action === 'edit' || action === 'delete') {
        if (interaction.user.id !== event.creator_id) {
          await interaction.reply({ content: 'Only the person who created this event can do that.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (action === 'delete') {
          db.deleteEvent(eventId);
          const cancelledEmbed = new EmbedBuilder()
            .setColor(0x99AAB5)
            .setTitle(`~~${event.title}~~ (cancelled)`)
            .setDescription('This event was cancelled by its creator.');
          await syncOriginalEventMessage(event, interaction, cancelledEmbed, []);
          await interaction.update({ embeds: [cancelledEmbed], components: [] });
          return;
        }
        await interaction.reply({
          content: 'Which timezone is the new start time in?',
          components: buildTimezoneSelectRow(`event:tzedit:${eventId}`),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      db.upsertEventSignup(eventId, interaction.user.id, action);
      const signups = db.getEventSignups(eventId);
      await interaction.update({ embeds: [buildEventEmbed(event, signups)], components: buildEventComponents(eventId) });
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'event:manage') {
      const eventId = Number(interaction.values[0]);
      const event = db.getEvent(eventId);
      if (!event) {
        await interaction.update({ content: 'That event no longer exists.', embeds: [], components: [] });
        return;
      }
      const signups = db.getEventSignups(eventId);
      await interaction.update({ content: null, embeds: [buildEventEmbed(event, signups)], components: buildEventComponents(eventId) });
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'event:tzcreate') {
      const zone = interaction.values[0];
      await interaction.showModal(buildEventModal(`event:createmodal:${zone}`, 'Create event', timezoneLabelFor(zone)));
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('event:tzedit:')) {
      const eventId = Number(interaction.customId.split(':')[2]);
      const event = db.getEvent(eventId);
      if (!event) {
        await interaction.update({ content: 'This event no longer exists.', components: [] });
        return;
      }
      const zone = interaction.values[0];
      const modal = buildEventModal(`event:editmodal:${eventId}:${zone}`, 'Edit event', timezoneLabelFor(zone), {
        title: event.title,
        at: formatEventTime(event.starts_at, zone),
        game: event.game_name ?? '',
        description: event.description ?? '',
      });
      await interaction.showModal(modal);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('event:createmodal:')) {
      const zone = interaction.customId.split(':')[2];
      const title = interaction.fields.getTextInputValue('title');
      const atText = interaction.fields.getTextInputValue('at');
      const description = interaction.fields.getTextInputValue('description') || null;
      const game = interaction.fields.getTextInputValue('game') || null;
      const { utcMs, error: parseError } = parseEventTime(atText, zone);
      if (parseError) {
        await interaction.reply({ content: `${parseError} (interpreted in ${timezoneLabelFor(zone)} time)`, flags: MessageFlags.Ephemeral });
        return;
      }
      if (utcMs <= Date.now()) {
        await interaction.reply({ content: 'That time is in the past — pick a time in the future.', flags: MessageFlags.Ephemeral });
        return;
      }
      const eventId = db.createEvent(interaction.guild.id, interaction.channelId, interaction.user.id, title, description, game, utcMs);
      const event = db.getEvent(eventId);
      await interaction.reply({ embeds: [buildEventEmbed(event, [])], components: buildEventComponents(eventId) });
      const reply = await interaction.fetchReply().catch(() => null);
      if (reply) db.setEventMessageId(eventId, reply.id);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('event:editmodal:')) {
      const [, , eventIdStr, zone] = interaction.customId.split(':');
      const eventId = Number(eventIdStr);
      const event = db.getEvent(eventId);
      if (!event) {
        await interaction.reply({ content: 'This event no longer exists.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.user.id !== event.creator_id) {
        await interaction.reply({ content: 'Only the person who created this event can do that.', flags: MessageFlags.Ephemeral });
        return;
      }
      const title = interaction.fields.getTextInputValue('title');
      const atText = interaction.fields.getTextInputValue('at');
      const description = interaction.fields.getTextInputValue('description') || null;
      const game = interaction.fields.getTextInputValue('game') || null;
      const { utcMs, error: parseError } = parseEventTime(atText, zone);
      if (parseError) {
        await interaction.reply({ content: `${parseError} (interpreted in ${timezoneLabelFor(zone)} time)`, flags: MessageFlags.Ephemeral });
        return;
      }
      if (utcMs <= Date.now()) {
        await interaction.reply({ content: 'That time is in the past — pick a time in the future.', flags: MessageFlags.Ephemeral });
        return;
      }
      db.updateEvent(eventId, title, description, game, utcMs);
      const updatedEvent = db.getEvent(eventId);
      const signups = db.getEventSignups(eventId);
      const updatedEmbed = buildEventEmbed(updatedEvent, signups);
      const updatedComponents = buildEventComponents(eventId);
      await syncOriginalEventMessage(updatedEvent, interaction, updatedEmbed, updatedComponents);
      await interaction.update({ embeds: [updatedEmbed], components: updatedComponents });
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'setup') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await setupRoles(interaction.guild);
      await syncGuildRanks(interaction.guild);
      db.setNotificationChannel(interaction.guild.id, interaction.channelId);
      await interaction.editReply(`The ${RANKS.length} tracker roles are ready and member ranks have been synchronized. Rank-up announcements will be posted in this channel. Ensure the bot role is above them.`);
    }
    if (interaction.commandName === 'stats') {
      const user = interaction.options.getUser('member') ?? interaction.user;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      const { embed, page, totalPages } = await buildCardEmbed('stats', interaction.guild, member, user);
      await interaction.reply({
        embeds: [embed],
        components: buildCardComponents('stats', user.id, interaction.user.id, page, totalPages),
      });
    }
    if (interaction.commandName === 'leaderboard') {
      const [allTime, monthly] = await Promise.all([
        buildLeaderboardLines(interaction.guild),
        buildMonthlyLeaderboardLines(interaction.guild),
      ]);
      await interaction.reply([
        '**All-Time Leaderboard**',
        allTime.join('\n'),
        '',
        '**This Month Best Gamer**',
        monthly.join('\n'),
      ].join('\n'));
    }
    if (interaction.commandName === 'info') {
      const lines = RANKS.map((rank, index) => {
        const marker = DEFAULT_RANK_EMOJIS[index % DEFAULT_RANK_EMOJIS.length];
        return `${marker} **Level ${index + 1} — ${rank}**`;
      });
      await interaction.reply(`**Game Tracker ranks**\n${lines.join('\n\n')}`);
    }
    if (interaction.commandName === 'server') {
      const { profile, topGames, topPlayers } = await buildServerProfileParts(interaction.guild);
      const serverAchievements = getUnlockedServerAchievements(db, interaction.guild.id);
      const achievementLines = serverAchievements.length
        ? serverAchievements.map((row) => {
            const a = serverAchievementById(row.achievement_id);
            return `└ ${a.emoji} **${a.name}** — ${a.description}`;
          })
        : ['└ None yet — keep growing!'];
      const text = [
        '🏰 **Server Gaming Statistics**',
        '',
		`⏱️ **Total gaming time:** ${formatPlayTime(profile.totalSeconds)}`,
		'',
		'🏆 **Most played games**',
		...topGames,
		'',
		'🔥 **Most active players**',
		...topPlayers,
		'',
		`🏆 **Server achievements (${serverAchievements.length}/${SERVER_ACHIEVEMENTS.length})**`,
		...achievementLines,
	  ].join('\n');
      const [firstChunk, ...restChunks] = splitDiscordMessage(text);
      await interaction.reply(firstChunk);
      for (const chunk of restChunks) await interaction.followUp(chunk);
    }
    if (interaction.commandName === 'changes') {
      const channelName = process.env.CHANGES_CHANNEL?.trim();
      const repository = process.env.GITHUB_REPOSITORY?.trim();
      const force = interaction.options.getBoolean('force') ?? false;
      if (!channelName || !repository) {
        await interaction.reply({ content: 'Set CHANGES_CHANNEL and GITHUB_REPOSITORY in `.env` before using `/changes`.', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.guild.channels.fetch();
      const channel = findTextChannel(interaction.guild, channelName);
      if (!channel) {
        await interaction.reply({ content: `I could not find a text channel named #${channelName}.`, flags: MessageFlags.Ephemeral });
        return;
      }
      let release;
      try {
        release = await fetchLatestRelease(repository);
      } catch (error) {
        await interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
        return;
      }
      if (!force && db.getLastAnnouncedRelease(interaction.guild.id) === String(release.id)) {
        await interaction.reply({ content: 'The latest GitHub Release has already been announced. Use `/changes force:True` to post it again.', flags: MessageFlags.Ephemeral });
        return;
      }
      const body = stripLeadingTitleLine(release.body?.trim() || 'No release notes were provided.');
      const announcement = `📣 **New Game Tracker version ${release.tag_name} released!**\n${body}`;
      for (const message of splitDiscordMessage(announcement)) {
        await channel.send({ content: message, allowedMentions: { parse: [] } });
      }
      db.setLastAnnouncedRelease(interaction.guild.id, release.id);
      await interaction.reply({ content: `Posted the latest GitHub Release in ${channel}.`, flags: MessageFlags.Ephemeral });
    }
    if (interaction.commandName === 'event' && interaction.options.getSubcommand() === 'create') {
      await interaction.reply({
        content: 'Which timezone is this event in?',
        components: buildTimezoneSelectRow('event:tzcreate'),
        flags: MessageFlags.Ephemeral,
      });
    }
    if (interaction.commandName === 'event' && interaction.options.getSubcommand() === 'list') {
      const upcoming = db.getUpcomingEventsForGuild(interaction.guild.id, Date.now(), 10);
      if (!upcoming.length) {
        await interaction.reply({ content: 'No upcoming events. Create one with `/event create`.', flags: MessageFlags.Ephemeral });
        return;
      }
      const lines = upcoming.map((event) => {
        const unixSeconds = Math.floor(event.starts_at / 1000);
        const link = event.message_id ? `https://discord.com/channels/${event.guild_id}/${event.channel_id}/${event.message_id}` : null;
        const going = db.getEventSignups(event.id).filter((row) => row.status === 'going').length;
        return `**${event.title}** — <t:${unixSeconds}:F> (<t:${unixSeconds}:R>) — ${going} going${link ? ` — [jump](${link})` : ''}`;
      });
      const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('event:manage').setPlaceholder('Select an event to edit or delete it')
          .addOptions(upcoming.map((event) => ({
            label: event.title.slice(0, 100),
            value: String(event.id),
            description: new Date(event.starts_at).toISOString().slice(0, 16).replace('T', ' '),
          }))),
      );
      await interaction.reply({ content: `**Upcoming events**\n${lines.join('\n')}`, components: [selectRow], flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    console.error('Command failed:', error);
    const message = 'Something went wrong. Confirm the bot has the required permissions and role position.';
    try {
      if (interaction.deferred) await interaction.editReply(message);
      else if (!interaction.replied) await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    } catch (replyError) {
      console.error('Could not report the error back to Discord:', replyError);
    }
  }
});

// Persist elapsed time and re-evaluate ranks/achievements even if Discord did not send a new presence event.
setInterval(async () => {
  const now = Date.now();
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
    await channel.send(`${text}\n${mentions}`)
      .catch((error) => console.error('Could not send event reminder:', error));
  }
  // Clean up events well after they've started so the table doesn't grow unbounded.
  for (const eventId of db.getStaleEvents(now - 24 * 60 * 60_000)) db.deleteEvent(eventId);
}, 60_000).unref();

function shutdown() {
  db.flushAll();
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

client.login(process.env.DISCORD_TOKEN);
