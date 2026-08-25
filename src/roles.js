import { memberRef } from './log.js';

/**
 * The winner badge's colour, deliberately NOT the gold the achievement embeds use.
 *
 * The badge sits above every rank role so its colour wins in the member list, which means it is
 * what a winner's name looks like for the whole period. Gold reads as almost the same yellow as
 * the fourth rank, so a winner could be mistaken for having that rank. A pale blue sits nearer the
 * early ranks instead: visible, but not shouting louder than the ranks people actually earned.
 *
 * Kept here rather than imported from embeds.js so recolouring the badge never silently recolours
 * the achievement cards, which is exactly what sharing ACHIEVEMENT_GOLD used to do.
 *
 * Only applied when the role is CREATED. A colour changed by hand in Discord afterwards is left
 * alone, matching how /setup treats rank role colours.
 */
export const WINNER_ROLE_COLOR = 0x95FDFF;

/**
 * Takes the badge off everyone, for a period nobody earned. The role itself is left in place so it
 * keeps its position and colour for next time.
 */
export async function clearWinnerRole(guild, roleName) {
  if (!roleName) return null;
  const role = guild.roles.cache.find((candidate) => candidate.name === roleName);
  if (!role) return null;
  await guild.members.fetch().catch(() => null);
  for (const holder of role.members.values()) {
    await holder.roles.remove(role, `No longer ${roleName}`).catch((error) =>
      console.error(`Could not take the badge from ${memberRef(holder.id)}:`, error));
  }
  return role;
}

/**
 * Hands the monthly winner's badge over: create the role if needed, strip it from whoever held it,
 * then give it to the new winner. Returns the role, or null if it could not be created.
 *
 * Lives here rather than in index.js so the preview script can exercise the real thing.
 */
export async function awardWinnerRole(guild, winnerId, { roleName, roleIcon = null } = {}) {
  if (!roleName) return null;
  let role = guild.roles.cache.find((candidate) => candidate.name === roleName);
  const isNew = !role;
  role ??= await guild.roles.create({
    name: roleName,
    // discord.js 14.22 deprecated the flat `color` in favour of `colors`.
    colors: { primaryColor: WINNER_ROLE_COLOR },
    hoist: true,
    reason: `${roleName} — winner badge`,
  }).catch((error) => {
    console.error('Could not create the winner role:', error);
    return null;
  });
  if (!role) return null;

  // Discord creates roles at the bottom, where every rank role sits above and overrides the badge.
  // A member's name takes the colour of their highest coloured role, so the badge has to outrank
  // them — put it directly beneath the bot's own role, the highest slot it is allowed to use.
  if (isNew) {
    const ceiling = guild.members.me?.roles.highest.position;
    if (ceiling && ceiling > 1) {
      await role.setPosition(ceiling - 1, { reason: 'Badge colour must outrank the rank roles' })
        .catch((error) => console.error('Could not raise the winner role:', error));
    }
  }

  // A role icon shows beside the name, but Discord only allows it from Boost Level 2. Attempt it
  // and shrug off the rejection, so the icon simply starts working if the server is ever boosted.
  if (roleIcon && role.unicodeEmoji !== roleIcon) {
    await role.setUnicodeEmoji(roleIcon, `${roleName} badge icon`)
      .catch(() => console.log('Role icons need Boost Level 2 — badge applied without one.'));
  }

  // role.members only sees cached members, so a previous holder who happens to be offline would
  // silently keep the badge without this.
  await guild.members.fetch().catch(() => null);
  for (const holder of role.members.values()) {
    if (holder.id === winnerId) continue;
    await holder.roles.remove(role, `No longer ${roleName}`).catch((error) =>
      console.error(`Could not take the monthly role from ${memberRef(holder.id)}:`, error));
  }
  const winner = await guild.members.fetch(winnerId).catch(() => null);
  if (winner && !winner.roles.cache.has(role.id)) {
    await winner.roles.add(role, `${roleName} — gamer of the month`).catch((error) =>
      console.error('Could not award the monthly role:', error));
  }
  return role;
}
