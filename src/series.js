// Time-series extraction for the Graphs tab. Walks the catalogue's pool
// sessions in chronological order and pulls dated points for each key marker
// the deterministic core tracks. Pure + testable.

function paceToSeconds(p) {
  if (!p) return null;
  const m = String(p).match(/(\d+):(\d+)/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * @param {object} catalogue
 * @returns {Array<{ key, label, unit, lowerIsBetter, points: Array<{date,value}> }>}
 */
export function extractMarkerSeries(catalogue) {
  // Chronological (catalogue stores most-recent-first).
  const sessions = [...(catalogue?.sessions ?? [])]
    .filter(s => s && s.type === 'pool' && s.metrics)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const mk = (key, label, unit, getter, lowerIsBetter = true) => ({
    key, label, unit, lowerIsBetter,
    points: sessions
      .map(s => ({ date: s.date, value: getter(s) }))
      .filter(p => p.value != null && Number.isFinite(p.value)),
  });

  const all = [
    mk('best_25m', 'Best 25m split', 's', s => s.metrics.best_25m_split_s, true),
    mk('avg_swolf', 'Avg SWOLF', '', s => s.metrics.avg_swolf, true),
    mk('avg_pace', 'Avg pace /100m', 's', s => paceToSeconds(s.metrics.avg_pace_per_100m), true),
    mk('dps', 'Distance per stroke', 'm', s => s.metrics.avg_dps_m, false),
    mk('spm', 'Stroke rate', 'spm', s => s.metrics.avg_stroke_rate_spm, false),
    mk('max_hr', 'Max HR', 'bpm', s => s.metrics.max_hr, true),
  ];
  return all.filter(series => series.points.length > 0);
}

export { paceToSeconds };
