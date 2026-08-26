/**
 * Manual stat corrections, and the audit trail behind them.
 *
 * Every other write in this bot is earned: presence comes in, time goes up. These two are the
 * escape hatch for when what Discord reported was not what happened — a console that kept
 * broadcasting into rest mode, a mis-reported presence, a session the bot recovered wrongly. Before
 * this existed the only fix was editing the SQLite file by hand.
 *
 * Two rules hold for both operations:
 *
 * - **Nothing is silent.** Each applied correction writes a `stat_adjustments` row naming who did
 *   it, to whom, how much and why. That row is the only evidence a total was changed by hand rather
 *   than earned, so it is written in the same breath as the change and never removed.
 * - **Achievements are never re-locked.** Taking time back can drop a member below a threshold they
 *   have already cleared, and the unlock stays. This matches the rule the rest of the project
 *   follows for retuning — raising a requirement never revokes what someone already has — and the
 *   alternative is a correction quietly deleting a badge somebody was shown earning. Rank roles do
 *   move, because a rank names where you stand now rather than what you once reached.
 */

export const ADJUSTMENT_KINDS = { TIME: 'time', SESSION: 'session' };

/**
 * Adds or removes time on one game for one member.
 *
 * Returns what was actually applied, which is not always what was asked for: a subtraction is
 * capped at the time the game holds. `appliedSeconds === 0` means the correction was a no-op — the
 * game had nothing left to take — and nothing is written, audit row included, because a log of
 * attempts that changed nothing makes the real corrections harder to find.
 */
export function applyTimeAdjustment(db, { guildId, userId, actorId, gameName, deltaSeconds, reason }, now = Date.now()) {
  const result = db.adjustPlaytime(guildId, userId, gameName, deltaSeconds);
  if (result.appliedSeconds !== 0) {
    db.recordAdjustment({
      guildId, userId, actorId, kind: ADJUSTMENT_KINDS.TIME, gameName,
      deltaSeconds: result.appliedSeconds, reason,
    }, now);
  }
  return result;
}

/**
 * Voids one completed session, removing the history row and the time and session tally it
 * contributed. Returns null when the id does not exist or belongs to another guild — the caller
 * reports that rather than treating it as a failure.
 */
export function voidSession(db, { guildId, sessionId, actorId, reason }, now = Date.now()) {
  const result = db.deletePlaySession(guildId, sessionId);
  if (!result) return null;
  // Recorded even when the clamp made this worth zero seconds: unlike a no-op time adjustment, a
  // session row genuinely disappeared here, and that is a change somebody may need to explain.
  db.recordAdjustment({
    guildId, userId: result.session.user_id, actorId, kind: ADJUSTMENT_KINDS.SESSION,
    gameName: result.session.game_name, deltaSeconds: result.appliedSeconds,
    sessionId, reason,
  }, now);
  return result;
}
