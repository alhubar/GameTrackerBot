import { memberRef } from './log.js';

/**
 * The console-presence spike (issue #5), off unless PRESENCE_PLATFORM_LOG is set.
 *
 * A PlayStation banked roughly eight hours nobody played: Discord's console integration keeps
 * broadcasting the Playing activity after play stops — rest mode in particular often leaves it
 * running until the console fully powers down — and the bot recorded exactly what it was told.
 * Neither existing guard catches it. `PAUSE_ON_IDLE` reads `presence.status`, which is Discord's
 * *desktop-input* heuristic and stays `online` indefinitely while the member is on their phone;
 * `MAX_SESSION_HOURS` cannot go below about 11.5 without making the longest session achievement
 * unreachable, and an eight-hour phantom passes under every legal value.
 *
 * The candidate fix is a much shorter cap for sessions that are demonstrably a console — but
 * nothing in discord.js exposes what platform an activity came from. The raw `PRESENCE_UPDATE`
 * payload carries a per-activity `platform` field (`ps5`, `xbox`, `desktop`) in
 * `discord-api-types`; discord.js v14's `Activity` constructor copies a fixed list of fields that
 * excludes it, so it is dropped before any handler sees it. `Events.Raw` is where it survives.
 *
 * **This module logs and nothing else, deliberately.** The next step on that issue is confirming
 * `platform` actually arrives for a genuine console presence before any logic is built on it —
 * so this exists to produce that evidence, not to act on it. `client_status` and `application_id`
 * are logged alongside because if `platform` turns out to be absent they are the other candidate
 * signals, and one run of the spike should answer the question either way.
 *
 * **Two packet types, and the second one is why a mid-session start is not a wasted run.**
 * Discord announces presences that are *already* running inside the `GUILD_CREATE` sent on
 * connect, not as `PRESENCE_UPDATE`s — so a spike watching only updates is blind until something
 * changes, which for a console left broadcasting in rest mode may be hours. That is precisely the
 * state this exists to photograph, so the connect snapshot is read too. It is tagged `:startup`
 * rather than folded in with the updates because the two answer different questions: an update is
 * a transition and carries the moment it happened, while a snapshot says only that this was true
 * at connect and nothing at all about how long it had been true.
 */

/** Raw gateway activity type for "Playing" — the only kind that banks time. */
const PLAYING = 0;

function describeActivity(activity) {
  const fields = [
    `name=${JSON.stringify(activity?.name ?? null)}`,
    `platform=${activity?.platform ?? '(absent)'}`,
    `application_id=${activity?.application_id ?? '(absent)'}`,
  ];
  return `{ ${fields.join(' ')} }`;
}

/**
 * Describes one presence object, or returns `null` for anything not worth logging.
 *
 * Takes the presence rather than the packet because the same shape arrives two ways: as the `d`
 * of a `PRESENCE_UPDATE`, and as an entry in `GUILD_CREATE`'s `presences` array. `tag` is what
 * tells the two apart in the log.
 *
 * Only presences carrying a Playing activity are described. Everything else — status flips,
 * custom-status edits, Spotify — is noise here: this is asking what a *session-starting* presence
 * looks like, and a busy server produces far more of the rest.
 */
function describePresence(presence, tag) {
  const playing = (Array.isArray(presence?.activities) ? presence.activities : []).filter((activity) => activity?.type === PLAYING);
  if (!playing.length) return null;
  // Logged through memberRef like every other identifier the bot writes, so pasting the spike's
  // output into an issue does not publish who it was about.
  const who = memberRef(presence.user?.id ?? 'unknown');
  const clientStatus = Object.entries(presence.client_status ?? {}).map(([source, value]) => `${source}=${value}`).join(',') || '(none)';
  return `[PRESENCE-SPIKE${tag}] ${who} status=${presence.status ?? '(absent)'} client_status=${clientStatus} ${playing.map(describeActivity).join(' ')}`;
}

/**
 * Turns a raw gateway packet into log output, or `null` for anything not worth logging.
 *
 * A `GUILD_CREATE` can describe several members at once, so the return is one string of newline
 * separated lines rather than one line — `console.log` prints it identically and the caller stays
 * a single statement.
 *
 * Pure, and takes the packet rather than a client, so the shape can be tested without Discord.
 */
export function describeRawPresence(packet) {
  if (packet?.t === 'PRESENCE_UPDATE') return describePresence(packet.d, '');
  if (packet?.t === 'GUILD_CREATE') {
    const presences = Array.isArray(packet.d?.presences) ? packet.d.presences : [];
    const lines = presences.map((presence) => describePresence(presence, ':startup')).filter(Boolean);
    return lines.length ? lines.join('\n') : null;
  }
  return null;
}
