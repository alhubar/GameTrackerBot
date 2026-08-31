import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { openDatabase } from './database.js';
import { DATABASE_PATH } from './config.js';

/**
 * The two process-wide singletons every feature module needs.
 *
 * They live here rather than in index.js so commands and interaction handlers can reach them
 * without importing index.js back — that would be a cycle, since index.js imports the handlers.
 * Nothing under test/ imports this module, so opening the database is never a test side effect.
 */

export const db = openDatabase(DATABASE_PATH);

// GuildMessages is non-privileged and carries no message text: it delivers who posted and where,
// which is all the Scribe badge counts. MessageContent is the privileged one and is deliberately
// never requested — the bot has no reason to see what anybody wrote.
//
// GuildVoiceStates is what the Bard badge runs on, and it is load-bearing twice over: without it
// the gateway never sends VOICE_STATE_UPDATE, *and* it omits the voice_states array from
// GUILD_CREATE, so `channel.members` on a voice channel is permanently empty. Both halves of the
// voice path — the event handler and the startup sweep — then run against an empty room and bank
// nothing, silently, forever. It is non-privileged: nothing to enable in the Developer Portal.
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates,
  ],
});
