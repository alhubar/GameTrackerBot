/**
 * Which game names are probably two spellings of one game.
 *
 * `/adjust merge` folds a split back together, but somebody has to *notice* the split first, and
 * nobody goes looking — a split shows up as a game with suspiciously little time on it, sitting a
 * character away from one with a lot. This is the noticing half, and it is the only half that can
 * be safe: a merge is a guild-wide judgement with no undo, so this suggests and never acts.
 *
 * Pure on purpose — no db, no Discord — so the rule can be tested against a list of names directly,
 * the same shape `recap.js` and `socialBadges.js` use.
 *
 * **Three classes, deliberately ranked, because they are not equally trustworthy.**
 *
 * - `IDENTICAL` — the same name once case, punctuation, spacing and accents are ignored. A
 *   guaranteed true positive rather than a guess: `game_stats` is keyed on the exact string Discord
 *   reported while `getPlayersForGame` matches `COLLATE NOCASE`, so these two rows already behave
 *   inconsistently across the bot whether or not anybody merges them.
 * - `NEAR` — one or two characters apart. What edit distance is actually good at: a typo, a dropped
 *   letter, a transposition.
 * - `EXTENDS` — one name is the other plus words. Catches the re-title edit distance never will
 *   (`Realm Royale` → `Realm Royale Reforged`), and is the loosest of the three: `Fallout` and
 *   `Fallout Shelter` land here too and are not the same game. Listed last and labelled for that
 *   reason.
 *
 * **A difference in numbers is a sequel, never a typo — and that rule outranks the other two.**
 * `Diablo II` and `Diablo III` are one character apart; `F1 23` and `F1 24` one digit apart;
 * `Portal` and `Portal 2` are one an extension of the other. Every one of those is two different
 * games, and suggesting a merge for them is worse than suggesting nothing, because a merge cannot
 * be undone. So both weaker classes require the two names to carry the *same* numbers, arabic and
 * roman counted alike.
 *
 * **What this cannot find, and does not pretend to:** an upstream rename that shares no words with
 * the old title. `Counter-Strike: Global Offensive` became `Counter-Strike 2` — the case that
 * motivated `/adjust merge` in the first place — and nothing here will ever spot it. A human does.
 */

/**
 * Roman numerals are read only to *reject* a pair, never to match one. A misreading can therefore
 * only cost a suggestion, which is the safe direction: `Mega Man X` staying unflagged is a shrug,
 * `Mega Man X` merged into `Mega Man 10` is unrecoverable. That is also why numerals are not
 * folded into the comparison key — `civ`, `mix` and the English word "I" are all valid numerals to
 * a parser and are not numbers to anybody else.
 */
const ROMAN_VALUES = { i: 1, v: 5, x: 10, l: 50, c: 100 };

function romanToNumber(token) {
  if (!/^[ivxlc]+$/.test(token)) return null;
  let total = 0;
  for (let index = 0; index < token.length; index += 1) {
    const value = ROMAN_VALUES[token[index]];
    const next = ROMAN_VALUES[token[index + 1]] ?? 0;
    total += value < next ? -value : value;
  }
  return total;
}

/**
 * The name with case, accents, punctuation and spacing taken out, as words and as one run.
 *
 * `words` keeps the spacing, because an extension has to start on a word boundary — `Port` must
 * not read as the start of `Portal`. `key` throws the spacing away too, because `Fall Guys` and
 * `Fallguys` are the same game and `Counter-Strike 2` and `Counter Strike 2` have to survive the
 * same treatment as `R.E.P.O.` and `REPO`, which a punctuation-to-space rule cannot do at once.
 */
export function normalizeGameName(name) {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return { words, key: words.replace(/ /g, '') };
}

/**
 * Every number in a name, arabic and roman alike, sorted so order cannot make two equal signatures
 * look different. Digit runs are read from anywhere (`cs2` counts), roman numerals only as whole
 * words — inside a word every second title would be a numeral.
 */
export function numberSignature(words) {
  const numbers = (words.match(/\d+/g) ?? []).map(Number);
  for (const word of words.split(' ')) {
    if (/\d/.test(word)) continue;
    const roman = romanToNumber(word);
    if (roman !== null) numbers.push(roman);
  }
  return numbers.sort((a, b) => a - b).join(',');
}

/**
 * Levenshtein distance, abandoned as soon as it is certainly past `max`. Two rows rather than a
 * full matrix: nothing here needs the edit script, only whether the two names are close.
 */
export function editDistance(a, b, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (current[j] < best) best = current[j];
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

export const DUPLICATE_REASONS = {
  IDENTICAL: 'identical',
  NEAR: 'near',
  EXTENDS: 'extends',
};

const REASON_ORDER = [DUPLICATE_REASONS.IDENTICAL, DUPLICATE_REASONS.NEAR, DUPLICATE_REASONS.EXTENDS];

/**
 * A one-character difference means something quite different in a four-letter name than in a
 * twenty-letter one: `PEAK` and `PEAR` are a character apart and are not the same game, while two
 * characters in `Assassin's Creed Black Flag Resynced` is a typo every time. Short names are
 * therefore left alone entirely and only long ones are allowed a second edit.
 */
const NEAR_MIN_LENGTH = 6;
const NEAR_TWO_EDITS_LENGTH = 12;

/** An extension needs a base long enough to mean something — `Ark` extends half a library. */
const EXTENDS_MIN_LENGTH = 5;

const maxEdits = (shorter) => (shorter.length >= NEAR_TWO_EDITS_LENGTH ? 2 : 1);

/**
 * Groups of names that are probably one game, strongest evidence first.
 *
 * `games` are `{ name, totalSeconds, playerCount }` rows — everything the guild has under any name,
 * including a name only a running session knows about. Each returned group carries its names sorted
 * by time held, so the first is the obvious one to keep and the rest are the obvious ones to retire;
 * the caller decides, and a human decides after that.
 *
 * Nothing is deduplicated between groups on purpose beyond the one case that would be noise: two
 * names already reported as `IDENTICAL` are never reported again as `NEAR` or `EXTENDS`. A name
 * genuinely close to two *different* games belongs in both suggestions.
 */
export function findDuplicateGameNames(games) {
  const entries = games.map((game) => ({ ...game, ...normalizeGameName(game.name) }))
    .filter((entry) => entry.key.length > 0);

  // Identical-after-normalisation is a bucketing job, not a comparison one, so it costs one pass.
  const buckets = new Map();
  for (const entry of entries) {
    const bucket = buckets.get(entry.key);
    if (bucket) bucket.push(entry);
    else buckets.set(entry.key, [entry]);
  }

  const suggestions = [];
  for (const bucket of buckets.values()) {
    if (bucket.length > 1) suggestions.push({ reason: DUPLICATE_REASONS.IDENTICAL, names: bucket.slice().sort(byTimeDesc) });
  }

  // Compared bucket by bucket rather than name by name: two spellings that already share a bucket
  // would otherwise each raise the same near-match against a third name.
  const candidates = [...buckets.values()].map((bucket) => bucket.slice().sort(byTimeDesc));
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const [left, right] = [candidates[i][0], candidates[j][0]];
      // A sequel is not a typo, and this rule outranks both tests below.
      if (numberSignature(left.words) !== numberSignature(right.words)) continue;
      const reason = compare(left, right);
      if (reason) suggestions.push({ reason, names: [left, right].sort(byTimeDesc) });
    }
  }

  // Strongest class first, then whichever pair holds the most time between the two names — that is
  // the split doing the most damage to the leaderboard and the most-played list, and the one an
  // admin reading a truncated list most needs to see.
  return suggestions
    .sort((a, b) => REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason)
      || groupSeconds(b) - groupSeconds(a)
      || a.names[0].name.localeCompare(b.names[0].name))
    .map(({ reason, names }) => ({
      reason,
      names: names.map(({ name, totalSeconds, playerCount }) => ({ name, totalSeconds, playerCount })),
    }));

  function compare(left, right) {
    const [shorter, longer] = left.key.length <= right.key.length ? [left, right] : [right, left];
    if (shorter.key.length >= NEAR_MIN_LENGTH
      && editDistance(left.key, right.key, maxEdits(shorter.key)) <= maxEdits(shorter.key)) {
      return DUPLICATE_REASONS.NEAR;
    }
    // On words rather than the key, so the extension starts where a word does: `Port` is not the
    // beginning of `Portal`, but `Realm Royale` is the beginning of `Realm Royale Reforged`.
    if (shorter.key.length >= EXTENDS_MIN_LENGTH && longer.words.startsWith(`${shorter.words} `)) {
      return DUPLICATE_REASONS.EXTENDS;
    }
    return null;
  }
}

const byTimeDesc = (a, b) => b.totalSeconds - a.totalSeconds || a.name.localeCompare(b.name);
const groupSeconds = (suggestion) => suggestion.names.reduce((sum, entry) => sum + entry.totalSeconds, 0);
