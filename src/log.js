import { createHash } from 'node:crypto';

/**
 * Discord identifiers written to the log end up in GitHub issues, support threads and LLM chats
 * the moment anyone pastes a stack trace, so error lines refer to members by a short stable hash
 * instead of a username or a snowflake. The hash is consistent within a run of the bot, which is
 * all a "why does this keep failing for the same person" question actually needs.
 *
 * Set DEBUG_IDENTIFIERS=true to log the real id when you genuinely need to act on it.
 */
const SHOW_IDENTIFIERS = process.env.DEBUG_IDENTIFIERS?.trim().toLowerCase() === 'true';

export function memberRef(value) {
  const raw = typeof value === 'string' ? value : (value?.id ?? String(value));
  if (SHOW_IDENTIFIERS) return raw;
  return `member:${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
}
