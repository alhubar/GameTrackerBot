import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { RANKS } from '../ranks.js';
import { handleSetup } from './setup.js';
import { handleStats } from './stats.js';
import { handleLeaderboard } from './leaderboard.js';
import { handleInfo } from './info.js';
import { handleServer } from './server.js';
import { handleChanges } from './changes.js';
import { handleEvent } from './event.js';
import { handleHealth } from './health.js';

/**
 * Slash command definitions and the name → handler table.
 *
 * Commands are always registered per-guild (`scope.commands.set`), which is why edits here show up
 * instantly rather than after Discord's global propagation delay.
 *
 * `setDefaultMemberPermissions` is what hides a command from members who lack the permission — it
 * is enforced by Discord, but each restricted handler still re-checks, because a server owner can
 * override the default in Server Settings → Integrations.
 */

export const commands = [
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
  // Administrator-only in both directions: Discord hides it from everyone else, and the handler
  // re-checks, because the default can be overridden per-command in Server Settings.
  new SlashCommandBuilder().setName('health').setDescription('Check that tracking, the database and the loops are alive')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((command) => command.toJSON());

const HANDLERS = {
  setup: handleSetup,
  stats: handleStats,
  leaderboard: handleLeaderboard,
  info: handleInfo,
  server: handleServer,
  changes: handleChanges,
  event: handleEvent,
  health: handleHealth,
};

export async function handleChatInputCommand(interaction) {
  const handler = HANDLERS[interaction.commandName];
  if (handler) await handler(interaction);
}
