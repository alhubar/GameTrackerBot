import { RANKS, RANK_HOURS, rankForSeconds } from './ranks.js';
import { currentStreak, DUO_DAYS_NEEDED, COUNTS_AS_PLAYED_SECONDS } from './achievements.js';

function csvNumbers(variable, fallback) {
  const value = process.env[variable];
  if (!value) return fallback;
  const numbers = value.split(',').map((item) => Number(item.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return numbers.length ? numbers : fallback;
}

function dayStartUTC(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

const CATEGORIES = [
  {
    key: 'players',
    metric: 'trackedPlayers',
    thresholds: csvNumbers('SERVER_PLAYER_THRESHOLDS', [5, 10, 25, 50]),
    tiers: [
      { id: 'welcome_to_the_club', emoji: '🎟️', name: 'Welcome to the Club' },
      { id: 'growing_community', emoji: '🌱', name: 'Growing Community' },
      { id: 'full_house', emoji: '🏠', name: 'Full House' },
      { id: 'thriving_hub', emoji: '🏙️', name: 'Thriving Hub' },
    ],
    describe: (n) => `Track ${n} different players.`,
    celebrate: (n, metrics) => `The server is now tracking **${metrics.trackedPlayers} players**!`,
  },
  {
    key: 'games',
    metric: 'gamesTracked',
    thresholds: csvNumbers('SERVER_GAME_THRESHOLDS', [10, 25, 50, 100]),
    tiers: [
      { id: 'getting_started', emoji: '🕹️', name: 'Getting Started' },
      { id: 'game_library', emoji: '📚', name: 'Game Library' },
      { id: 'game_store', emoji: '🏪', name: 'Game Store' },
      { id: 'steam_sale_survivor', emoji: '💸', name: 'Steam Sale Survivor' },
    ],
    describe: (n) => `Track ${n} different games, with at least an hour played in each.`,
    celebrate: (n, metrics) => `The server has now tracked **${metrics.gamesTracked} different games**!`,
  },
  {
    key: 'playtime',
    metric: 'totalHours',
    thresholds: csvNumbers('SERVER_PLAYTIME_HOURS', [100, 500, 1000, 5000, 10000]),
    tiers: [
      { id: 'getting_somewhere', emoji: '🚶', name: "We're Getting Somewhere" },
      { id: 'getting_serious', emoji: '😅', name: 'Getting Serious' },
      { id: 'no_one_has_a_life', emoji: '💀', name: 'No One Has A Life' },
      { id: 'we_need_to_talk', emoji: '🫠', name: 'We Need To Talk' },
      { id: 'civilization_has_fallen', emoji: '☠️', name: 'Civilization Has Fallen' },
    ],
    describe: (n) => `Reach ${n.toLocaleString()} combined hours of playtime.`,
    celebrate: (n, metrics) => `The server has accumulated **${Math.floor(metrics.totalHours).toLocaleString()} hours** of gaming!`,
  },
  {
    key: 'dominanceHours',
    metric: 'topGameHours',
    thresholds: csvNumbers('SERVER_DOMINANCE_HOURS', [100, 500, 1000, 2500]),
    tiers: [
      { id: 'server_favorite', emoji: '❤️', name: 'Server Favorite' },
      { id: 'community_obsession', emoji: '🔥', name: 'Community Obsession' },
      { id: 'cult_classic', emoji: '🕯️', name: 'Cult Classic' },
      { id: 'this_game_owns_us', emoji: '⛓️', name: 'This Game Owns Us' },
    ],
    describe: (n) => `One game reaches ${n.toLocaleString()} combined hours.`,
    celebrate: (n, metrics) => `**${metrics.topGameHoursName ?? 'A game'}** has been played for **${Math.floor(metrics.topGameHours).toLocaleString()} combined hours**!`,
  },
  {
    key: 'dominancePlayers',
    metric: 'topGamePlayerCount',
    thresholds: csvNumbers('SERVER_DOMINANCE_PLAYERS', [10, 20]),
    tiers: [
      { id: 'we_all_play_this', emoji: '👥', name: 'We All Play This Apparently' },
      { id: 'the_server_game', emoji: '👑', name: 'The Server Game' },
    ],
    describe: (n) => `${n} different members have each played the same game for an hour.`,
    celebrate: (n, metrics) => `**${metrics.topGamePlayerCount} different members** have all played **${metrics.topGamePlayerCountName ?? 'the same game'}**!`,
  },
  {
    key: 'meltingPot',
    metric: 'concurrentGames',
    thresholds: csvNumbers('SERVER_MELTING_POT_THRESHOLD', [3]),
    tiers: [
      { id: 'melting_pot', emoji: '🍲', name: 'Melting Pot' },
    ],
    describe: (n) => `${n}+ different games being played on the server at the same time.`,
    celebrate: (n, metrics) => `**${metrics.concurrentGames} different games** are being played on the server right now!`,
  },
  {
    key: 'topRank',
    metric: 'topRankHolders',
    thresholds: csvNumbers('SERVER_TOP_RANK_THRESHOLDS', [3]),
    tiers: [
      { id: 'top_of_the_mountain', emoji: '👑', name: 'Top of the Mountain' },
    ],
    describe: (n) => `${n} different members reach ${RANKS[RANKS.length - 1]} (the highest rank) at the same time.`,
    celebrate: (n, metrics) => `**${metrics.topRankHolders} members** have all reached **${RANKS[RANKS.length - 1]}**!`,
  },
  {
    key: 'rushHour',
    metric: 'gamesToday',
    thresholds: csvNumbers('SERVER_RUSH_HOUR_THRESHOLDS', [8]),
    tiers: [
      { id: 'rush_hour', emoji: '🚦', name: 'Rush Hour' },
    ],
    describe: (n) => `${n}+ different games started on the server in a single day.`,
    celebrate: (n, metrics) => `**${metrics.gamesToday} different games** were started on the server today!`,
  },
  {
    key: 'alwaysOn',
    metric: 'guildStreak',
    thresholds: csvNumbers('SERVER_ALWAYS_ON_THRESHOLDS', [14]),
    tiers: [
      { id: 'always_on', emoji: '🔌', name: 'Always On' },
    ],
    describe: (n) => `Someone on the server plays every day, ${n} days in a row.`,
    celebrate: (n, metrics) => `The server has had **someone playing every day for ${metrics.guildStreak} days straight**!`,
  },
  {
    key: 'trophyCase',
    metric: 'totalPersonalUnlocks',
    thresholds: csvNumbers('SERVER_TROPHY_CASE_THRESHOLDS', [50, 150]),
    tiers: [
      { id: 'trophy_case', emoji: '🏆', name: 'Trophy Case' },
      { id: 'hall_of_fame', emoji: '🏛️', name: 'Hall of Fame' },
    ],
    describe: (n) => `The server's members unlock ${n} personal achievements combined.`,
    celebrate: (n, metrics) => `The server's members have unlocked **${metrics.totalPersonalUnlocks} personal achievements** combined!`,
  },
  {
    key: 'fullSpectrum',
    metric: 'rankSpectrumCoverage',
    thresholds: [RANKS.length],
    tiers: [
      { id: 'full_spectrum', emoji: '🌈', name: 'Full Spectrum' },
    ],
    describe: (n) => `Have at least one tracked member at every rank tier (${n} tiers) at the same time.`,
    celebrate: () => `The server has at least one member at **every rank tier**, right now!`,
  },
  {
    key: 'squadBonds',
    metric: 'qualifiedDuoPairs',
    thresholds: csvNumbers('SERVER_SQUAD_BONDS_THRESHOLDS', [3, 6]),
    tiers: [
      { id: 'squad_bonds', emoji: '👨‍👩‍👧‍👦', name: 'Squad Bonds' },
      { id: 'found_family', emoji: '🫂', name: 'Found Family' },
    ],
    describe: (n) => `${n} different member pairs have each played together on ${DUO_DAYS_NEEDED}+ different days.`,
    celebrate: (n, metrics) => `**${metrics.qualifiedDuoPairs} different pairs** of members have each played together on ${DUO_DAYS_NEEDED}+ days!`,
  },
];

function tierFor(category, index) {
  return category.tiers[index] ?? { id: `${category.key}_tier_${index + 1}`, emoji: '🎉', name: `Milestone ${index + 1}` };
}

export const SERVER_ACHIEVEMENTS = CATEGORIES.flatMap((category) => category.thresholds.map((threshold, index) => {
  const tier = tierFor(category, index);
  return { ...tier, description: category.describe(threshold), category: category.key };
}));

const SERVER_ACHIEVEMENT_BY_ID = new Map(SERVER_ACHIEVEMENTS.map((achievement) => [achievement.id, achievement]));
export const serverAchievementById = (id) => SERVER_ACHIEVEMENT_BY_ID.get(id);

/** Unlocked rows for a guild, excluding any achievement id no longer in the current roster. */
export function getUnlockedServerAchievements(db, guildId) {
  return db.getServerAchievements(guildId).filter((row) => serverAchievementById(row.achievement_id));
}

const TOP_RANK_SECONDS = RANK_HOURS[RANK_HOURS.length - 1] * 3600;

export function computeServerMetrics(db, guildId, now = Date.now()) {
  const totalSeconds = db.getGuildTotalSeconds(guildId, now);
  const topByHours = db.getTopGameByHours(guildId, now);
  const topByPlayers = db.getTopGameByPlayerCount(guildId, COUNTS_AS_PLAYED_SECONDS);
  const memberTotals = db.getAllMemberTotals(guildId, now);
  const rankTiersPresent = new Set(memberTotals.map((row) => rankForSeconds(row.total_seconds)).filter((rank) => rank >= 0));
  return {
    trackedPlayers: db.getTrackedPlayerCount(guildId),
    gamesTracked: db.getGuildGameCount(guildId, COUNTS_AS_PLAYED_SECONDS),
    totalSeconds,
    totalHours: totalSeconds / 3600,
    topGameHours: (topByHours?.total_seconds ?? 0) / 3600,
    topGameHoursName: topByHours?.game_name ?? null,
    topGamePlayerCount: topByPlayers?.players ?? 0,
    topGamePlayerCountName: topByPlayers?.game_name ?? null,
    concurrentGames: db.getConcurrentGameCount(guildId),
    topRankHolders: db.getPlayersAboveSeconds(guildId, TOP_RANK_SECONDS),
    gamesToday: db.getGuildGamesToday(guildId, dayStartUTC(now)),
    guildStreak: currentStreak(db.getGuildPlayDates(guildId)),
    totalPersonalUnlocks: db.getTotalAchievementUnlockCount(guildId),
    rankSpectrumCoverage: rankTiersPresent.size,
    qualifiedDuoPairs: db.getQualifiedDuoPairCount(guildId, DUO_DAYS_NEEDED),
  };
}

/** Call after guild-wide stats change (a session starts/stops, or periodically to catch idle accrual). */
export function evaluateServerAchievements(db, guildId, now = Date.now()) {
  const metrics = computeServerMetrics(db, guildId, now);
  const unlocked = [];
  for (const category of CATEGORIES) {
    const value = metrics[category.metric];
    category.thresholds.forEach((threshold, index) => {
      if (value < threshold) return;
      const tier = tierFor(category, index);
      if (db.unlockServerAchievement(guildId, tier.id, now)) {
        unlocked.push({ ...tier, description: category.describe(threshold), celebration: category.celebrate(threshold, metrics) });
      }
    });
  }
  return { unlocked, metrics };
}
