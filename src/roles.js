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
 * The weekly social badges, in the same spirit as the colour above and chosen the same way.
 *
 * A badge outranks the rank roles, so whoever holds one wears its colour for the whole period —
 * which means neither of these may read as a rank. The rank palette is white, green, blue, yellow,
 * orange, red and purple, and the winner badge is already a pale cyan, so an orchid and a
 * parchment tan are two of the few places left that cannot be mistaken for something earned.
 *
 * Only applied when the role is CREATED, exactly like the winner badge: a colour changed by hand
 * in Discord afterwards is left alone.
 */
export const BARD_ROLE_COLOR = 0xE2A0D8;
export const SCRIBE_ROLE_COLOR = 0xC9A87C;
/**
 * A plain, dark grey. Grey is the one family no rank uses, and a badge for having been absent
 * should be the quietest thing on the member list rather than a colour anybody would want.
 *
 * Deliberately darker than the greys Discord hands out by default — an untouched role renders
 * around #8D8D8D — so a Cave Dweller is visibly *dimmer* than an ordinary member rather than
 * indistinguishable from one.
 */
export const CAVE_DWELLER_ROLE_COLOR = 0x5A5A5A;

/**
 * Takes a badge off everyone, for a period nobody earned it. The role itself is left in place so it
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

/** Reusable alias: the same operation, for a badge that is not the playtime one. */
export const clearBadgeRole = clearWinnerRole;

/**
 * The highest coloured role above this badge that would actually steal its colour, or null.
 *
 * Anything coloured sitting above the badge wins the member's name colour, which is the one thing
 * a badge exists to do — so that is the condition worth naming. Three exclusions keep it from
 * crying wolf, and a warning nobody trusts is worse than no warning:
 *
 * - **The other badges.** They deliberately share one slot at the top, so each always has siblings
 *   above it — and it never matters, because nobody holds two.
 * - **Roles above the bot's own.** Nothing can be done about those from here.
 * - **Bot-managed roles**, for the same reason.
 */
function colouredRoleAbove(guild, role, siblingRoleNames = []) {
  const siblings = new Set(siblingRoleNames.filter(Boolean));
  const ceiling = guild.members.me?.roles.highest.position ?? Infinity;
  const rivals = [...guild.roles.cache.values()].filter((candidate) => candidate.id !== role.id
    && !candidate.managed
    && !siblings.has(candidate.name)
    && candidate.color !== 0
    && candidate.position > role.position
    && candidate.position < ceiling);
  return rivals.length ? Math.max(...rivals.map((candidate) => candidate.position)) : null;
}

/**
 * Creates a badge role if it is missing, puts it where its colour will actually show, and gives it
 * its icon. Returns the role, or null if it could not be created.
 *
 * Position and colour are applied **only on creation**, so a server that recolours or reorders a
 * badge by hand keeps its choice — the same rule the rank roles already follow.
 */
async function ensureBadgeRole(guild, {
  roleName, roleIcon = null, color = WINNER_ROLE_COLOR,
  hoist = true, reason = `${roleName} — badge`, siblingRoleNames = [],
} = {}) {
  if (!roleName) return null;
  let role = guild.roles.cache.find((candidate) => candidate.name === roleName);
  const isNew = !role;
  role ??= await guild.roles.create({
    name: roleName,
    // discord.js 14.22 deprecated the flat `color` in favour of `colors`.
    colors: { primaryColor: color },
    hoist,
    reason,
  }).catch((error) => {
    console.error(`Could not create the ${roleName} role:`, error);
    return null;
  });
  if (!role) return null;

  // Discord creates roles at the bottom, where every rank role sits above and overrides the badge.
  // A member's name takes the colour of their highest coloured role, so the badge has to outrank
  // them — put it just beneath the bot's own role, the highest slot it is allowed to use.
  //
  // Every badge goes to the *same* slot rather than stacking downwards one below the next. They do
  // not need separate positions, because the award pass guarantees nobody holds two — and walking
  // each successive badge one place lower marches them straight into the rank roles, where the
  // third or fourth ends up beneath a rank and is silently overridden on anyone who holds it.
  if (isNew) {
    const ceiling = guild.members.me?.roles.highest.position;
    if (ceiling && ceiling > 1) {
      await role.setPosition(ceiling - 1, { reason: 'Badge colour must outrank the rank roles' })
        .catch((error) => console.error(`Could not raise the ${roleName} role:`, error));
    }
  }
  // Badges land under the bot's role, so the bot needs room above the ranks for all of them. When
  // it does not, they spill below and stop showing — the single most common real-world failure in
  // this bot, and completely silent. Say so plainly rather than leaving it to be noticed.
  const rival = colouredRoleAbove(guild, role, siblingRoleNames);
  if (rival !== null) {
    console.warn(`The ${roleName} badge is at position ${role.position}, below a coloured role at `
      + `${rival} — its colour will be overridden. Move the bot's own role higher.`);
  }

  // A role icon shows beside the name, but Discord only allows it from Boost Level 2. Attempt it
  // and shrug off the rejection, so the icon simply starts working if the server is ever boosted.
  if (roleIcon && role.unicodeEmoji !== roleIcon) {
    await role.setUnicodeEmoji(roleIcon, `${roleName} badge icon`)
      .catch(() => console.log('Role icons need Boost Level 2 — badge applied without one.'));
  }
  return role;
}

/**
 * The many-holder form: make the role's membership exactly `userIds`.
 *
 * Cave Dweller is not an award and cannot use `awardBadgeRole` — it can land on several members at
 * once, or on nobody. Reconciled rather than reassigned, so a member who held it last period and
 * still qualifies is left alone instead of having it removed and re-added.
 */
export async function syncBadgeRoleMembers(guild, userIds, options = {}) {
  const { roleName, awardReason = `${roleName} — awarded` } = options;
  const role = await ensureBadgeRole(guild, options);
  if (!role) return null;

  const wanted = new Set(userIds);
  await guild.members.fetch().catch(() => null);
  for (const holder of role.members.values()) {
    if (wanted.has(holder.id)) continue;
    await holder.roles.remove(role, `No longer ${roleName}`).catch((error) =>
      console.error(`Could not take the ${roleName} role from ${memberRef(holder.id)}:`, error));
  }
  for (const userId of wanted) {
    const member = guild.members.cache.get(userId);
    if (!member || member.roles.cache.has(role.id)) continue;
    await member.roles.add(role, awardReason).catch((error) =>
      console.error(`Could not give the ${roleName} role to ${memberRef(userId)}:`, error));
  }
  return role;
}

/**
 * Takes one named role off one member, if they have it. A no-op — and crucially no API call — when
 * they do not, which is what makes it cheap enough to call on every single message.
 */
export async function removeRoleByName(member, roleName) {
  if (!member || !roleName) return false;
  const role = member.roles.cache.find((candidate) => candidate.name === roleName);
  if (!role) return false;
  await member.roles.remove(role, `No longer ${roleName}`).catch((error) =>
    console.error(`Could not take the ${roleName} role from ${memberRef(member.id)}:`, error));
  return true;
}

/**
 * Hands the monthly winner's badge over: create the role if needed, strip it from whoever held it,
 * then give it to the new winner. Returns the role, or null if it could not be created.
 *
 * Lives here rather than in index.js so the preview script can exercise the real thing.
 */
export async function awardWinnerRole(guild, winnerId, { roleName, roleIcon = null, siblingRoleNames = [] } = {}) {
  return awardBadgeRole(guild, winnerId, {
    roleName,
    roleIcon,
    siblingRoleNames,
    color: WINNER_ROLE_COLOR,
    reason: `${roleName} — winner badge`,
    awardReason: `${roleName} — gamer of the month`,
  });
}

/**
 * The general form: hand one badge role over to one member.
 *
 * Every badge is created into the same slot, directly beneath the bot's own role. They do not need
 * distinct positions — the award pass guarantees nobody holds two — and their order among
 * themselves is invisible for exactly that reason. What matters is only that all of them stay
 * above every rank role, which is what sharing one slot achieves.
 */
export async function awardBadgeRole(guild, userId, options = {}) {
  const { roleName, awardReason = `${roleName} — awarded` } = options;
  const role = await ensureBadgeRole(guild, options);
  if (!role) return null;

  // role.members only sees cached members, so a previous holder who happens to be offline would
  // silently keep the badge without this.
  await guild.members.fetch().catch(() => null);
  for (const holder of role.members.values()) {
    if (holder.id === userId) continue;
    await holder.roles.remove(role, `No longer ${roleName}`).catch((error) =>
      console.error(`Could not take the ${roleName} role from ${memberRef(holder.id)}:`, error));
  }
  // A badge with no holder this period still strips cleanly above, which is what makes an
  // unclaimed badge a real outcome rather than one that quietly stays on last period's winner.
  if (!userId) return role;
  const recipient = await guild.members.fetch(userId).catch(() => null);
  if (recipient && !recipient.roles.cache.has(role.id)) {
    await recipient.roles.add(role, awardReason).catch((error) =>
      console.error(`Could not award the ${roleName} role:`, error));
  }
  return role;
}
