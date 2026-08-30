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
import { handleBackup } from './backup.js';
import { handleAdjust, handleAdjustAutocomplete } from './adjust.js';
import { handlePrivacy } from './privacy.js';

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
  new SlashCommandBuilder().setName('info').setDescription('What this bot does, the ranks, and everything you can run'),
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
  new SlashCommandBuilder().setName('backup').setDescription('Take an on-demand copy of the tracker database')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  // Administrator rather than Manage Server: these are the only commands that can lower a member's
  // total and take a rank role back off them.
  new SlashCommandBuilder().setName('adjust').setDescription('Correct tracked playtime that does not match reality')
    .addSubcommand((sub) => sub.setName('time').setDescription('Add or remove minutes on one game for a member')
      .addUserOption((option) => option.setName('member').setDescription('Member to correct').setRequired(true))
      .addStringOption((option) => option.setName('game').setDescription('Game to correct (pick from the list)').setRequired(true).setAutocomplete(true))
      .addIntegerOption((option) => option.setName('minutes').setDescription('Minutes to add, or a negative number to remove').setRequired(true)
        .setMinValue(-525600).setMaxValue(525600))
      .addStringOption((option) => option.setName('reason').setDescription('Why — recorded in the audit log').setMaxLength(200)))
    .addSubcommand((sub) => sub.setName('session').setDescription('Void a bogus session and take back the time it credited')
      .addUserOption((option) => option.setName('member').setDescription('Member whose session it is').setRequired(true))
      .addIntegerOption((option) => option.setName('session').setDescription('Session to void (pick from the list)').setRequired(true).setAutocomplete(true))
      .addStringOption((option) => option.setName('reason').setDescription('Why — recorded in the audit log').setMaxLength(200)))
    .addSubcommand((sub) => sub.setName('log').setDescription('Show recent corrections')
      .addUserOption((option) => option.setName('member').setDescription('Only this member (defaults to the whole server)')))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  // Deliberately available to everyone and deliberately has no member option: these are controls
  // over the caller's own data, and every reply is ephemeral.
  new SlashCommandBuilder().setName('privacy').setDescription('Control whether you are tracked, and see what is stored about you')
    .addSubcommand((sub) => sub.setName('status').setDescription('Show your tracking status and what is stored about you'))
    .addSubcommand((sub) => sub.setName('optout').setDescription('Stop being tracked and hide yourself from the rankings'))
    .addSubcommand((sub) => sub.setName('optin').setDescription('Resume tracking and reappear on the rankings'))
    .addSubcommand((sub) => sub.setName('forgetme').setDescription('Permanently erase everything stored about you')),
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
  backup: handleBackup,
  adjust: handleAdjust,
  privacy: handlePrivacy,
};

// Separate from HANDLERS: an autocomplete interaction is a different Discord type that must be
// answered with choices rather than a message, and only some commands have any.
const AUTOCOMPLETE_HANDLERS = {
  adjust: handleAdjustAutocomplete,
};

export async function handleChatInputCommand(interaction) {
  const handler = HANDLERS[interaction.commandName];
  if (handler) await handler(interaction);
}

export async function handleAutocomplete(interaction) {
  const handler = AUTOCOMPLETE_HANDLERS[interaction.commandName];
  if (handler) await handler(interaction);
}
