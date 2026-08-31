import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The one guard standing between a handler and an event Discord never sends.
 *
 * Every other test in this suite drives a module directly with a fake guild, so the whole social
 * and presence surface can be green while the client is subscribed to none of it — which is
 * exactly what happened. The voice path shipped complete, with 365 lines of its own tests, and
 * without GuildVoiceStates: `voice_minutes` was zero for every member until a recap months later
 * awarded no Bard. Nothing threw, because nothing ran.
 *
 * runtime.js is read as *text* rather than imported on purpose. Importing it calls openDatabase()
 * at module scope, and nothing under test/ may open a database as a side effect — the same rule
 * that keeps ui.js and records.js taking `db` as a parameter. Reading the source is the crude half
 * of that trade and the only half available.
 */

const source = readFileSync(fileURLToPath(new URL('../src/runtime.js', import.meta.url)), 'utf8');

/** Every `GatewayIntentBits.X` the file names, by identifier. */
const declared = new Set(
  source.split('GatewayIntentBits.').slice(1)
    .map((rest) => rest.match(/^[A-Za-z]+/)?.[0])
    .filter(Boolean),
);

// Each intent paired with what silently stops working without it, so a failure says why it matters
// rather than only that a name is absent.
const REQUIRED_INTENTS = [
  ['Guilds', 'the bot receives no guilds at all'],
  ['GuildMembers', 'member fetches and every role change'],
  ['GuildPresences', 'PresenceUpdate — the entire playtime tracker'],
  ['GuildMessages', 'MessageCreate — text minutes and the Scribe badge'],
  ['GuildVoiceStates', 'VoiceStateUpdate, and channel.members reads the voice-state cache, so both '
    + 'the handler and the startup sweep see empty rooms — no voice minutes, no Bard badge'],
];

test('runtime.js requests every intent the event handlers depend on', () => {
  for (const [intent, breaks] of REQUIRED_INTENTS) {
    assert.ok(
      declared.has(intent),
      `GatewayIntentBits.${intent} is missing from src/runtime.js — without it, ${breaks}. `
        + 'Registering a client.on(...) handler is only half the change.',
    );
  }
});

test('MessageContent is never requested', () => {
  // The privileged one. Counting who posted needs GuildMessages alone; the bot has no reason to
  // see what anybody wrote, and asking for it would change what the install prompt tells members.
  assert.ok(!declared.has('MessageContent'), 'src/runtime.js must never request MessageContent.');
});
