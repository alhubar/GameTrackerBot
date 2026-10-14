/**
 * Who gets which weekly badge.
 *
 * One member, one badge. The point of the whole feature is that something visibly changes hands
 * every week on a server where the next rank is two hundred hours away, and three badges stacked
 * on one person achieves nothing that one badge would not.
 *
 * Pure: no database, no Discord, no clock. It takes two already-ranked boards and answers who
 * holds what, so the rule can be tested exhaustively without standing a server up.
 */

/**
 * Assignment order, and it is deliberately fixed rather than clever.
 *
 * Champion of the Realm is decided by the existing playtime recap and passed in already settled —
 * it has first claim and is never displaced. Bard and Scribe are then walked in this order.
 *
 * A rule like "give them whichever board they dominate most" is defensible and was considered, but
 * it cannot be explained in one sentence, and a member who cannot predict why they got the badge
 * they got will read the result as arbitrary.
 */
const BOARD_ORDER = [
  { key: 'bard', metric: 'voice_minutes', label: 'voice' },
  { key: 'scribe', metric: 'text_minutes', label: 'text' },
];

const minutesOn = (row, metric) => row?.[metric] ?? 0;

/**
 * Ranked descending on the board's own metric, ties broken by id.
 *
 * The SQL already returns them this way. Re-sorting here anyway makes the function total: a caller
 * that hands over rows in some other order gets the right answer rather than a silently wrong
 * leader, and "who topped this board" is the one thing the whole pass hangs on.
 */
const ranked = (rows, metric) => [...rows].sort((a, b) => {
  const diff = minutesOn(b, metric) - minutesOn(a, metric);
  return diff !== 0 ? diff : String(a.user_id).localeCompare(String(b.user_id));
});

/**
 * Decides the week's Bard and Scribe.
 *
 * `voice` and `text` are candidate rows — `{ user_id, voice_minutes, text_minutes }` — already
 * narrowed to members still in the guild. They are candidates rather than winners on purpose:
 * the floor and the one-badge-per-member rule have to be applied together while walking the list,
 * and splitting them between SQL and here is how a badge ends up handed to somebody who should
 * have been skipped.
 *
 * Returns `{ bard, scribe, alsoTopped }`. A null award means the badge goes unclaimed, which is a
 * real outcome the recap renders rather than an error. `alsoTopped` maps a member id to the boards
 * they led but were not given, so the recap can say "also topped voice this week" under their name
 * — they still spread the badges around, without the person who genuinely won twice being quietly
 * written out of the result.
 */
export function awardSocialBadges({
  championId = null,
  voice = [],
  text = [],
  voiceFloorMinutes = 0,
  textFloorMinutes = 0,
} = {}) {
  const boards = [
    { ...BOARD_ORDER[0], rows: voice, floor: voiceFloorMinutes },
    { ...BOARD_ORDER[1], rows: text, floor: textFloorMinutes },
  ];

  // Champion has first claim, so it is already spoken for before anything else is decided.
  const taken = new Set(championId ? [championId] : []);
  const alsoTopped = new Map();
  const noteTopped = (userId, label) => {
    if (!alsoTopped.has(userId)) alsoTopped.set(userId, []);
    alsoTopped.get(userId).push(label);
  };

  const awards = { bard: null, scribe: null };
  for (const board of boards) {
    // Zero never qualifies however low the floor is set — a badge for having done nothing is the
    // opposite of the point, and floor 0 is a legitimate "no minimum" setting.
    const eligible = ranked(board.rows, board.metric)
      .filter((row) => minutesOn(row, board.metric) > 0 && minutesOn(row, board.metric) >= board.floor);
    if (!eligible.length) continue;

    const leader = eligible[0];
    const winner = eligible.find((row) => !taken.has(row.user_id)) ?? null;
    if (winner) {
      taken.add(winner.user_id);
      awards[board.key] = winner;
    }
    // The leader was passed over — either they already hold a badge, or everyone eligible does and
    // this one goes unclaimed. Either way the recap should still say they topped it.
    if (!winner || winner.user_id !== leader.user_id) noteTopped(leader.user_id, board.label);
  }

  return { ...awards, alsoTopped };
}
