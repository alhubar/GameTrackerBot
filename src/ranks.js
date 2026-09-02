import 'dotenv/config';

const DEFAULT_RANKS = [
  'Villager',
  'Pathfinder',
  'Dungeon Delver',
  'Dragon Slayer',
  'Realm Guardian',
  'Mythic Hero',
  'Eternal Legend',
];

const DEFAULT_RANK_HOURS = [1, 2, 3, 4, 5, 6, 7];

function csvValues(variable, fallback) {
  const value = process.env[variable];
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : fallback;
}

export const RANKS = csvValues('RANK_NAMES', DEFAULT_RANKS);
export const RANK_HOURS = csvValues('RANK_HOURS', DEFAULT_RANK_HOURS.map(String)).map(Number);

if (RANKS.length < 2 || RANKS.length !== RANK_HOURS.length || RANK_HOURS[0] < 0
  || RANK_HOURS.some((hours, index) => !Number.isFinite(hours) || hours < 0 || (index > 0 && hours <= RANK_HOURS[index - 1]))) {
  throw new Error('Invalid rank configuration: RANK_NAMES and RANK_HOURS must have matching lengths; hours must be non-negative and strictly increase.');
}

export const roleName = (rank) => rank;

export function rankForSeconds(seconds) {
  const hours = seconds / 3600;
  return RANK_HOURS.reduce((rank, requiredHours, index) => (hours >= requiredHours ? index : rank), -1);
}

export function formatPlayTime(seconds) {
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes}m`;
  const formattedHours = hours.toLocaleString('en-US');
  return minutes ? `${formattedHours}h ${minutes}m` : `${formattedHours}h`;
}

export function formatHours(hours) {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1).replace(/\.0$/, '')}h`;
}

export function levelUpMessageTemplate(rankIndex) {
  return process.env[`LEVEL_UP_MESSAGE_${rankIndex + 1}`]
    ?? '🎮 {user} has become **Level {level} — {rank}** after **{hours}** of playtime!';
}

/**
 * Detects the RANK_NAMES insertion trap (#19): inserting a rank anywhere but the end shifts every
 * saved role down one index with no error, since each role still gets *a* name from the new list —
 * just the wrong one.
 *
 * The signature is a saved role whose *current* Discord name still names one of the configured
 * ranks, just not the one it's saved under. A deliberate rename retires the old name entirely, so it
 * won't match anything in `RANKS`; an insertion or reorder only moves the name, so the same string
 * reappears at a different index. `roleNames` maps role id → current Discord role name.
 */
export function detectRankShift(savedRoles, roleNames) {
  const indexByName = new Map(RANKS.map((rank, index) => [roleName(rank), index]));
  return savedRoles
    .map(({ rank_index: savedIndex, role_id: roleId }) => {
      const name = roleNames.get(roleId);
      const foundIndex = name === undefined ? undefined : indexByName.get(name);
      return foundIndex === undefined || foundIndex === savedIndex
        ? null
        : { savedIndex, foundIndex, roleId, name };
    })
    .filter((shift) => shift !== null);
}
