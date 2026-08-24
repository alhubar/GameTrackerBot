import { MessageFlags } from 'discord.js';
import { handleCardButton } from './cards.js';
import {
  handleEventButton, handleEventManageSelect, handleEventInviteSelect,
  handleTimezoneCreateSelect, handleTimezoneEditSelect,
  handleEventCreateModal, handleEventEditModal,
} from './events.js';
import { handleChatInputCommand } from '../commands/index.js';

/**
 * The single InteractionCreate entry point.
 *
 * Routing is by `customId` prefix because that string is the only state Discord carries back from a
 * component — see the two id schemes documented in `cards.js` and `events.js`.
 *
 * Every branch is wrapped in one try/catch that reports back to Discord, so a thrown handler
 * surfaces as an ephemeral "something went wrong" rather than an interaction that hangs unanswered.
 */

function route(interaction) {
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('card:')) return handleCardButton;
    if (interaction.customId.startsWith('event:')) return handleEventButton;
    return null;
  }
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'event:manage') return handleEventManageSelect;
    if (interaction.customId === 'event:tzcreate') return handleTimezoneCreateSelect;
    if (interaction.customId.startsWith('event:tzedit:')) return handleTimezoneEditSelect;
    return null;
  }
  if (interaction.isUserSelectMenu()) {
    if (interaction.customId.startsWith('event:invite:')) return handleEventInviteSelect;
    return null;
  }
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('event:createmodal:')) return handleEventCreateModal;
    if (interaction.customId.startsWith('event:editmodal:')) return handleEventEditModal;
    return null;
  }
  if (interaction.isChatInputCommand()) return handleChatInputCommand;
  return null;
}

export async function handleInteraction(interaction) {
  if (!interaction.guild) return;
  try {
    const handler = route(interaction);
    if (handler) await handler(interaction);
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
}
