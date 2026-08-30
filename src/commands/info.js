import { EmbedBuilder } from 'discord.js';
import { db } from '../runtime.js';
import {
  DEFAULT_RANK_EMOJIS, CARD_ACCENT_COLOR, RECAP_WINNER_ROLE, BARD_ROLE, SCRIBE_ROLE,
} from '../config.js';
import { RANKS, rankForSeconds } from '../ranks.js';
import { ACHIEVEMENTS } from '../achievements.js';

/**
 * `/info` — the front door: what this bot is, where you stand, and what you can run.
 *
 * It used to print the rank names and nothing else, which made it the thinnest command here while
 * also being the one members reach for to find out what any of this is. Everything below was chosen
 * to answer that question once, in one place, rather than to add a command per answer.
 *
 * Three things are deliberately absent:
 *
 *   - **Rank hours.** The whole reason this command lists names and no numbers. Anyone browsing
 *     the repo can read `.env.example`, so the placeholder there is fake; putting the real cost of
 *     the next rank in a public reply would give it away far more directly.
 *   - **The achievement list.** Unlocking one is meant to be a surprise. The *count* is fine and
 *     already public — the /stats card shows "3/40" — so it sets the expectation without spoiling
 *     anything.
 *   - **Server achievements.** /server already shows all of them with progress, locked and
 *     unlocked. Repeating them here is exactly the wall of text this command exists to avoid.
 */

/**
 * Only the commands every member can actually run. The rest are hidden by Discord from anyone
 * without the permission (see `setDefaultMemberPermissions` in commands/index.js), so listing them
 * here would advertise commands most readers cannot use and would not answer for why.
 */
const MEMBER_COMMANDS = [
  ['/stats', 'your profile card: games, achievements, boards'],
  ['/leaderboard', 'who has played the most'],
  ['/server', 'server stats, records and the Hall of Fame'],
  ['/event', 'plan a game night and take RSVPs'],
  ['/privacy', 'what’s stored about you, or opt out'],
];

/**
 * How many recap badges this server actually hands out.
 *
 * Counted from the configured names rather than hardcoded at three, because blanking one disables
 * it — a server with no Bard should not be promised one. Cave Dweller is not among them: it is not
 * a badge anybody wins, and "changing hands every week" would be a lie about it.
 */
const enabledBadgeCount = () =>
  [RECAP_WINNER_ROLE, BARD_ROLE, SCRIBE_ROLE].filter((name) => name?.trim()).length;

export async function handleInfo(interaction) {
  const { guild, user } = interaction;
  // An opted-out member is not ranked anywhere else, so they are not marked here either — this
  // reply is public, and pointing at somebody's rank is exactly the labelling they opted out of.
  const yourRank = db.isOptedOut(guild.id, user.id)
    ? -1
    : rankForSeconds(db.getTotalSeconds(guild.id, user.id));

  const rankLines = RANKS.map((rank, index) => {
    const marker = DEFAULT_RANK_EMOJIS[index % DEFAULT_RANK_EMOJIS.length];
    // Absent for anyone below the first rank, who has no rung to point at yet.
    const you = index === yourRank ? '   ◄ you' : '';
    return `${marker} **Level ${index + 1} — ${rank}**${you}`;
  });

  const badges = enabledBadgeCount();
  const embed = new EmbedBuilder()
    .setColor(CARD_ACCENT_COLOR)
    .setTitle('🎮 Game Tracker')
    .setDescription('I watch what you play and turn it into ranks, achievements, server records '
      + 'and a weekly recap. Talking counts too, not just playing.')
    .addFields({ name: '⭐ Ranks', value: rankLines.join('\n'), inline: false })
    .addFields(...(badges ? [{
      name: `🎖️ ${badges} Weekly badge${badges === 1 ? '' : 's'}`,
      value: badges === 1 ? 'Changing hands every week.' : 'One badge each, changing hands every week.',
      inline: false,
    }] : []))
    .addFields({
      name: '💬 What you can run',
      value: MEMBER_COMMANDS.map(([name, blurb]) => `**${name}** — ${blurb}`).join('\n'),
      inline: false,
    })
    .setFooter({ text: `${ACHIEVEMENTS.length} achievements to find. No, I'm not telling you what they are.` });

  await interaction.reply({ embeds: [embed] });
}
