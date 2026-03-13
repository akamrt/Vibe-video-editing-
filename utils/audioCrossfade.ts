/**
 * Compute crossfade volume multipliers for two overlapping audio segments.
 *
 * @param progress - 0..1 where 0 = start of overlap, 1 = end of overlap
 * @param curve - 'linear' (default) or 'equalPower'
 * @returns { outgoing, incoming } volume multipliers 0..1
 */
export function crossfadeVolumes(
  progress: number,
  curve: 'linear' | 'equalPower' = 'linear'
): { outgoing: number; incoming: number } {
  const p = Math.max(0, Math.min(1, progress));

  if (curve === 'equalPower') {
    // Equal-power crossfade maintains perceived loudness at midpoint.
    // cos(0)=1, cos(π/2)=0 for outgoing; sin(0)=0, sin(π/2)=1 for incoming
    return {
      outgoing: Math.cos(p * Math.PI / 2),
      incoming: Math.sin(p * Math.PI / 2),
    };
  }

  // Linear crossfade (default)
  return {
    outgoing: 1 - p,
    incoming: p,
  };
}
