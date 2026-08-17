import 'dotenv/config';
import { Client, Events, GatewayIntentBits, ActivityType, PermissionFlagsBits, SlashCommandBuilder, escapeMarkdown } from 'discord.js';
import { openDatabase } from './database.js';
import { RANKS, RANK_HOURS, formatHours, formatPlayTime, levelUpMessageTemplate, rankForSeconds, roleName } from './ranks.js';

if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN is missing. Copy .env.example to .env and add your token.');

const db = openDatabase();
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences],
});

const commands = [
  new SlashCommandBuilder().setName('setup').setDescription('Create the ten game-tracker rank roles')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('stats').setDescription('Show a member’s tracked play time')
    .addUserOption((option) => option.setName('member').setDescription('Member to look up (defaults to you)')),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show the top tracked players'),
  new SlashCommandBuilder().setName('info').setDescription('Show the server’s game tracker rank progression'),
  new SlashCommandBuilder().setName('server').setDescription('Show this server’s gaming statistics'),
  new SlashCommandBuilder().setName('changes').setDescription('Post the configured game tracker update')
    .addBooleanOption((option) => option.setName('force').setDescription('Post the latest release even if it was announced already'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
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

  const channelId = db.getNotificationChannel(member.guild.id);
  const channel = channelId ? member.guild.channels.cache.get(channelId) : null;
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
  if (game) db.startSession(member.guild.id, member.id, game);
  else db.stopSession(member.guild.id, member.id);
  await reconcileRank(member, oldRank);
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
    await syncRank(member).catch((error) => console.error(`Could not sync rank for ${member.user.tag}:`, error));
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
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  try {
    if (interaction.commandName === 'setup') {
      await interaction.deferReply({ ephemeral: true });
      await setupRoles(interaction.guild);
      await syncGuildRanks(interaction.guild);
      db.setNotificationChannel(interaction.guild.id, interaction.channelId);
      await interaction.editReply(`The ${RANKS.length} tracker roles are ready and member ranks have been synchronized. Rank-up announcements will be posted in this channel. Ensure the bot role is above them.`);
    }
    if (interaction.commandName === 'stats') {
      const user = interaction.options.getUser('member') ?? interaction.user;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      const profileName = escapeMarkdown(member?.displayName ?? user.username);
      const profile = db.getPlayerProfile(interaction.guild.id, user.id);
      const rankIndex = rankForSeconds(profile.totalSeconds);
      const rank = RANKS[rankIndex] ?? 'Unranked';
      const level = rankIndex >= 0 ? `Level ${rankIndex + 1} — ${rank}` : 'Level 0 — Unranked';
      const topGames = profile.topGames.length
		? profile.topGames.map((game, index) => {
			const medals = ['🥇', '🥈', '🥉'];
			return `└ ${medals[index]} ${escapeMarkdown(game.game_name)} — **${formatPlayTime(game.total_seconds)}**`;
		})
		: ['└ No game activity recorded yet'];
      await interaction.reply([
        `🎮 __**${profileName}'s Gaming Profile**__`,
		`⭐ **${level}**`,
		'',
		`⏱️ **Total playtime:** ${formatPlayTime(profile.totalSeconds)}`,
		'',
		'🏆 **Most played games**',
		...topGames,
		'',
		'🎯 **This month**',
		`└ ${formatPlayTime(profile.monthSeconds)}`,
		'',
		'🔥 **Longest session**',
		`└ ${formatPlayTime(profile.longestSeconds)}`,
		'',
		'🎮 **Games played**',
		`└ ${profile.gamesPlayed}`,
      ].join('\n'));
    }
    if (interaction.commandName === 'leaderboard') {
      const rows = db.getLeaderboard(interaction.guild.id);
      const text = rows.length ? (await Promise.all(rows.map(async (row, index) => {
        const member = await interaction.guild.members.fetch(row.user_id).catch(() => null);
        const nickname = member ? escapeMarkdown(member.displayName) : 'Former member';
        const rank = RANKS[rankForSeconds(row.total_seconds)] ?? 'Unranked';
        return `${index + 1}. **${rank}** ${nickname} — **${formatPlayTime(row.total_seconds)}**`;
      }))).join('\n') : 'No tracked play time yet.';
      await interaction.reply(`**Game time leaderboard**\n${text}`);
    }
    if (interaction.commandName === 'info') {
      const lines = RANKS.map((rank, index) => {
        const marker = DEFAULT_RANK_EMOJIS[index % DEFAULT_RANK_EMOJIS.length];
        return `${marker} **Level ${index + 1} — ${rank}**`;
      });
      await interaction.reply(`**Game Tracker ranks**\n${lines.join('\n\n')}`);
    }
    if (interaction.commandName === 'server') {
      const profile = db.getServerProfile(interaction.guild.id);
      const topGames = profile.topGames.length
  ? profile.topGames.map((game, index) => {
      const medals = ['🥇', '🥈', '🥉'];
      return `└ ${medals[index]} ${escapeMarkdown(game.game_name)} — **${formatPlayTime(game.total_seconds)}**`;
    })
  : ['└ No game activity recorded yet'];
      const activeMember = profile.mostActivePlayer
        ? await interaction.guild.members.fetch(profile.mostActivePlayer.user_id).catch(() => null)
        : null;
      const mostActive = profile.mostActivePlayer
        ? `${escapeMarkdown(activeMember?.displayName ?? 'Former member')} — ${formatPlayTime(profile.mostActivePlayer.total_seconds)}`
        : 'No player activity recorded yet';
      await interaction.reply([
        '🏰 **Server Gaming Statistics**',
        '',
		`👥 **Tracked players:** ${profile.trackedPlayers}`,
		`🎮 **Total gaming time:** ${formatPlayTime(profile.totalSeconds)}`,
		`🎮 **Games tracked:** ${profile.gamesTracked}`,
		'',
		'🏆 **Most played games**',
		...topGames,
		'',
		'🔥 **Most active player**',
		`└ ${mostActive}`,
	  ].join('\n'));
    }
    if (interaction.commandName === 'changes') {
      const channelName = process.env.CHANGES_CHANNEL?.trim();
      const repository = process.env.GITHUB_REPOSITORY?.trim();
      const force = interaction.options.getBoolean('force') ?? false;
      if (!channelName || !repository) {
        await interaction.reply({ content: 'Set CHANGES_CHANNEL and GITHUB_REPOSITORY in `.env` before using `/changes`.', ephemeral: true });
        return;
      }
      await interaction.guild.channels.fetch();
      const channel = interaction.guild.channels.cache.find((candidate) => candidate.isTextBased() && candidate.name === channelName);
      if (!channel) {
        await interaction.reply({ content: `I could not find a text channel named #${channelName}.`, ephemeral: true });
        return;
      }
      let release;
      try {
        release = await fetchLatestRelease(repository);
      } catch (error) {
        await interaction.reply({ content: error.message, ephemeral: true });
        return;
      }
      if (!force && db.getLastAnnouncedRelease(interaction.guild.id) === String(release.id)) {
        await interaction.reply({ content: 'The latest GitHub Release has already been announced. Use `/changes force:True` to post it again.', ephemeral: true });
        return;
      }
      const title = release.name?.trim() || release.tag_name;
      const body = release.body?.trim() || 'No release notes were provided.';
      const announcement = `📣 **New version ${release.tag_name} released!**\n${body}`;
      for (const message of splitDiscordMessage(announcement)) {
        await channel.send({ content: message, allowedMentions: { parse: [] } });
      }
      db.setLastAnnouncedRelease(interaction.guild.id, release.id);
      await interaction.reply({ content: `Posted the latest GitHub Release in ${channel}.`, ephemeral: true });
    }
  } catch (error) {
    console.error('Command failed:', error);
    const message = 'Something went wrong. Confirm the bot has the required permissions and role position.';
    if (interaction.deferred) await interaction.editReply(message);
    else if (!interaction.replied) await interaction.reply({ content: message, ephemeral: true });
  }
});

// Persist elapsed time and re-evaluate ranks even if Discord did not send a new presence event.
setInterval(async () => {
  for (const { guild_id, user_id, elapsed_seconds } of db.checkpointAll()) {
    const guild = client.guilds.cache.get(guild_id);
    const member = guild?.members.cache.get(user_id);
    const oldRank = rankForSeconds(db.getTotalSeconds(guild_id, user_id) - elapsed_seconds);
    if (member) await reconcileRank(member, oldRank).catch(console.error);
  }
}, 60_000).unref();

function shutdown() {
  db.flushAll();
  db.close();
  client.destroy();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
client.login(process.env.DISCORD_TOKEN);
