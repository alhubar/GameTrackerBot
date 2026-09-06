import { MessageFlags } from 'discord.js';
import { db } from '../runtime.js';
import { CHANGES_CHANNEL, GITHUB_REPOSITORY, GITHUB_TOKEN } from '../config.js';
import { findTextChannel, splitDiscordMessage, stripLeadingTitleLine } from '../ui.js';

async function fetchLatestRelease(repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must use the format owner/repository.');
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Discord-Game-Tracker',
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, { headers });
  if (response.status === 404) throw new Error('No published GitHub Release was found yet.');
  if (!response.ok) throw new Error(`GitHub could not load the latest release (HTTP ${response.status}).`);
  return response.json();
}

export async function handleChanges(interaction) {
  const force = interaction.options.getBoolean('force') ?? false;
  // The one guard cheap enough to answer inside Discord's three seconds without deferring: it reads
  // config and touches nothing. Everything below it is network, so the defer goes immediately after.
  if (!CHANGES_CHANNEL || !GITHUB_REPOSITORY) {
    await interaction.reply({ content: 'Set CHANGES_CHANNEL and GITHUB_REPOSITORY in `.env` before using `/changes`.', flags: MessageFlags.Ephemeral });
    return;
  }
  // Deferred before the first network call, the same as `/adjust`, `/backup`, `/privacy` and
  // `/setup`. Without it a slow GitHub round trip — the unauthenticated case, so a deployment with
  // no GITHUB_TOKEN is the exposed one — blows the three-second acknowledgement deadline *after*
  // the release has already gone out, and the admin is shown "the application did not respond" over
  // a post that worked. The obvious response to that is to run it again.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.guild.channels.fetch();
  const channel = findTextChannel(interaction.guild, CHANGES_CHANNEL);
  if (!channel) {
    await interaction.editReply(`I could not find a text channel named #${CHANGES_CHANNEL}.`);
    return;
  }
  let release;
  try {
    release = await fetchLatestRelease(GITHUB_REPOSITORY);
  } catch (error) {
    await interaction.editReply(error.message);
    return;
  }
  if (!force && db.getLastAnnouncedRelease(interaction.guild.id) === String(release.id)) {
    await interaction.editReply('The latest GitHub Release has already been announced. Use `/changes force:True` to post it again.');
    return;
  }
  const body = stripLeadingTitleLine(release.body?.trim() || 'No release notes were provided.', release.tag_name);
  const announcement = `📣 **New Game Tracker version ${release.tag_name} released!**\n${body}`;

  // Long notes go out as several messages, and the send that fails is usually not the first. The
  // count is what the reply is built from, because "it worked" and "half of it worked" need
  // different words — this is the one command whose whole effect is visible to the whole server.
  const chunks = splitDiscordMessage(announcement);
  let posted = 0;
  try {
    for (const chunk of chunks) {
      await channel.send({ content: chunk, allowedMentions: { parse: [] } });
      posted += 1;
    }
  } catch (error) {
    console.error('Could not post the release notes in full:', error);
  }

  if (!posted) {
    await interaction.editReply(`Nothing reached ${channel} — the send failed. This release is still `
      + 'unannounced, so running `/changes` again will retry it from the top.');
    return;
  }
  // Recorded as soon as *anything* landed, not only on a clean run. A retry duplicates whatever
  // already posted either way, so the choice is only whether that duplicate happens by accident:
  // leaving it unrecorded arms the next ordinary `/changes` to repost the lot. Marked instead, and
  // said out loud below, so a repost has to be asked for with `force`.
  db.setLastAnnouncedRelease(interaction.guild.id, release.id);
  if (posted < chunks.length) {
    await interaction.editReply(`⚠️ Only ${posted} of ${chunks.length} parts reached ${channel} — the rest failed to send. `
      + 'The release is marked as announced so nothing reposts by accident; tidy up the partial post '
      + 'and use `/changes force:True` if you want the whole thing again.');
    return;
  }
  await interaction.editReply(`Posted the latest GitHub Release in ${channel}.`);
}
