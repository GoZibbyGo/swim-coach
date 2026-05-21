import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractMarkerSeries, paceToSeconds } from '../src/series.js';

test('paceToSeconds parses m:ss', () => {
  assert.equal(paceToSeconds('1:36'), 96);
  assert.equal(paceToSeconds(null), null);
});

test('extractMarkerSeries returns chronological points per marker', () => {
  const cat = {
    sessions: [
      // stored most-recent-first
      { date: '2026-05-18', type: 'pool', metrics: { best_25m_split_s: 16.8, avg_swolf: 34, avg_pace_per_100m: '1:35', avg_dps_m: 3.4, avg_stroke_rate_spm: 25, max_hr: 175 } },
      { date: '2026-05-15', type: 'pool', metrics: { best_25m_split_s: 17.4, avg_swolf: 31, avg_pace_per_100m: '1:27', avg_dps_m: 3.5, avg_stroke_rate_spm: 26, max_hr: 166 } },
      { date: '2026-05-06', type: 'dryland', dryland: { exercises: [] } }, // excluded
    ],
  };
  const series = extractMarkerSeries(cat);
  const best25 = series.find(s => s.key === 'best_25m');
  assert.deepEqual(best25.points.map(p => p.date), ['2026-05-15', '2026-05-18']); // chronological
  assert.deepEqual(best25.points.map(p => p.value), [17.4, 16.8]);

  const pace = series.find(s => s.key === 'avg_pace');
  assert.deepEqual(pace.points.map(p => p.value), [87, 95]); // 1:27, 1:35 → seconds

  // dryland session contributes no pool points
  assert.ok(series.every(s => s.points.length === 2));
});

test('markers with no data are omitted', () => {
  const cat = { sessions: [{ date: '2026-05-18', type: 'pool', metrics: { avg_swolf: 31 } }] };
  const series = extractMarkerSeries(cat);
  assert.ok(series.some(s => s.key === 'avg_swolf'));
  assert.ok(!series.some(s => s.key === 'best_25m')); // no data → omitted
});
