// Garmin Connect CSV parser for swim activities.
//
// Ports STEP 3 of SKILL_session_logger.md. The Garmin export is a flat CSV
// with two row tiers:
//   - interval summary rows (Intervals column is a whole number)
//   - per-length sub-rows (Intervals column is "N.M", e.g. "1.3")
// Rest periods appear as their own rows with Swim Stroke == "Rest".
//
// The parser returns structured intervals (each containing its lengths),
// detected glitches, and pre-computed session-level aggregates. It does not
// decide what counts as warm-up or main-set — that's analysis logic and
// belongs in the engine, not here.

// Stroke detection is OFF on the athlete's Garmin. With drill log enabled,
// stroke column values are: "Unknown" (treated as freestyle), "Drill",
// or "Rest". If stroke detection is ever re-enabled, named-stroke labels
// (Butterfly, etc.) become intentional rather than glitches.
const FREESTYLE_LABELS = new Set([
  'Freestyle', 'freestyle', 'Free', 'free',
  'Unknown', 'unknown', // stroke detection off → all "unknown" = freestyle in practice
]);
const NON_FREESTYLE_LABELS = new Set([
  'Butterfly', 'butterfly', 'Backstroke', 'backstroke', 'Breaststroke', 'breaststroke',
]);
const DRILL_LABELS = new Set(['Drill', 'drill']);
const REST_LABEL = 'Rest';

// Garmin's length sub-rows carry stroke = "--", meaning "inherit the parent
// interval's stroke". Anything that looks like a placeholder is treated as
// missing so the caller can substitute the parent's stroke.
function isMissingStroke(stroke) {
  if (stroke == null) return true;
  const s = String(stroke).trim();
  return s === '' || s === '--' || s === '-';
}

function isDrillStroke(stroke) {
  if (isMissingStroke(stroke)) return false;
  return DRILL_LABELS.has(String(stroke).trim());
}

function isFreestyleStroke(stroke) {
  // null/empty/placeholder → treat as freestyle per Garmin guidance.
  if (isMissingStroke(stroke)) return true;
  return FREESTYLE_LABELS.has(String(stroke).trim());
}

const IMPLAUSIBLY_FAST_25M_S = 13.0; // physically implausible for 25m freestyle

// ──────────────────────────────────────────────────────────────────────────
// CSV tokenizer — RFC 4180-ish (handles quoted fields and "" escapes).
// ──────────────────────────────────────────────────────────────────────────

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  // Normalize line endings.
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
  }
  // Flush trailing field/row.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop any trailing fully-empty row (file ends with newline).
  while (rows.length && rows[rows.length - 1].every(c => c === '')) rows.pop();
  return rows;
}

// ──────────────────────────────────────────────────────────────────────────
// Time parsing — accepts "ss.s", "m:ss.s", or "h:mm:ss.s" → decimal seconds.
// ──────────────────────────────────────────────────────────────────────────

export function parseTimeToSeconds(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '' || s === '--' || s === '-') return null;
  const parts = s.split(':');
  if (parts.some(p => p === '' || isNaN(Number(p)))) return null;
  let total = 0;
  for (const p of parts) total = total * 60 + Number(p);
  return total;
}

export function formatPacePer100m(totalDistanceM, totalTimeS) {
  if (!(totalDistanceM > 0) || !(totalTimeS > 0)) return null;
  const sec = (totalTimeS / totalDistanceM) * 100;
  const m = Math.floor(sec / 60);
  const r = sec - m * 60;
  // Garmin-style display: m:ss with rounded whole seconds.
  return `${m}:${String(Math.round(r)).padStart(2, '0')}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Numeric parsing helpers — Garmin uses "--" for missing values.
// ──────────────────────────────────────────────────────────────────────────

function parseNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '' || s === '--' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseInteger(raw) {
  const n = parseNumber(raw);
  return n == null ? null : Math.round(n);
}

// ──────────────────────────────────────────────────────────────────────────
// Header mapping — Garmin reorders columns occasionally. Look them up by name.
// ──────────────────────────────────────────────────────────────────────────

const COLUMN_ALIASES = {
  intervals:        ['Intervals'],
  swim_stroke:      ['Swim Stroke', 'Stroke'],
  lengths:          ['Lengths'],
  distance:         ['Distance'],
  time:             ['Time'],
  cumulative_time:  ['Cumulative Time'],
  avg_pace:         ['Avg Pace'],
  best_pace:        ['Best Pace'],
  swolf:            ['Avg. Swolf', 'Avg Swolf', 'SWOLF'],
  avg_hr:           ['Avg HR'],
  max_hr:           ['Max HR'],
  total_strokes:    ['Total Strokes'],
  avg_strokes:      ['Avg Strokes'],
  calories:         ['Calories'],
};

function buildHeaderIndex(headerRow) {
  const index = {};
  const lower = headerRow.map(h => String(h).trim());
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    let found = -1;
    for (const alias of aliases) {
      const i = lower.indexOf(alias);
      if (i >= 0) { found = i; break; }
    }
    if (found >= 0) index[canonical] = found;
  }
  return index;
}

function cell(row, headerIndex, key) {
  const i = headerIndex[key];
  if (i == null || i < 0 || i >= row.length) return null;
  return row[i];
}

// ──────────────────────────────────────────────────────────────────────────
// Row type classification.
// ──────────────────────────────────────────────────────────────────────────

function classifyRow(intervalsCell) {
  if (intervalsCell == null) return null;
  const s = String(intervalsCell).trim();
  if (s === '') return null;
  if (/^\d+$/.test(s)) return { kind: 'interval', interval: Number(s), length: null };
  const m = s.match(/^(\d+)\.(\d+)$/);
  if (m) return { kind: 'length', interval: Number(m[1]), length: Number(m[2]) };
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Main parser.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse a Garmin Connect activity CSV (swim).
 *
 * @param {string} csvText
 * @param {object} [opts]
 * @param {number} [opts.poolLengthM=25] expected pool length in metres
 * @returns {{
 *   intervals: Array<object>,
 *   lengths: Array<object>,
 *   summary: object,
 *   glitches: Array<object>
 * }}
 */
export function parseGarminCsv(csvText, opts = {}) {
  const poolLengthM = opts.poolLengthM ?? 25;
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    return { intervals: [], lengths: [], summary: emptySummary(), glitches: [] };
  }

  const header = rows[0];
  const headerIndex = buildHeaderIndex(header);

  if (headerIndex.intervals == null) {
    throw new Error('Garmin CSV: missing "Intervals" column — file does not look like an activity laps export');
  }

  const intervals = [];
  const allLengths = [];
  const glitches = [];
  let currentInterval = null;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0].trim() === '') continue; // blank line

    const intervalsCell = cell(row, headerIndex, 'intervals');
    const stroke = cell(row, headerIndex, 'swim_stroke');
    const isRest = stroke && String(stroke).trim() === REST_LABEL;
    const klass = classifyRow(intervalsCell);

    if (klass?.kind === 'interval') {
      currentInterval = {
        interval_number: klass.interval,
        is_rest: !!isRest,
        stroke: stroke ?? null,
        lengths_count: parseInteger(cell(row, headerIndex, 'lengths')),
        distance_m: parseNumber(cell(row, headerIndex, 'distance')),
        time_s: parseTimeToSeconds(cell(row, headerIndex, 'time')),
        cumulative_time_s: parseTimeToSeconds(cell(row, headerIndex, 'cumulative_time')),
        avg_pace: cell(row, headerIndex, 'avg_pace'),
        best_pace: cell(row, headerIndex, 'best_pace'),
        swolf: parseInteger(cell(row, headerIndex, 'swolf')),
        avg_hr: parseInteger(cell(row, headerIndex, 'avg_hr')),
        max_hr: parseInteger(cell(row, headerIndex, 'max_hr')),
        total_strokes: parseInteger(cell(row, headerIndex, 'total_strokes')),
        avg_strokes: parseNumber(cell(row, headerIndex, 'avg_strokes')),
        calories: parseInteger(cell(row, headerIndex, 'calories')),
        rest_after_s: null, // rest taken immediately after this interval
        lengths: [],
      };
      intervals.push(currentInterval);
    } else if (isRest && klass == null) {
      // Unclassified rest row (real Garmin format: empty Intervals column,
      // Swim Stroke = "Rest"). Attribute its duration to the preceding
      // swimming interval as rest_after_s. Multiple consecutive rest rows
      // accumulate.
      const restTime = parseTimeToSeconds(cell(row, headerIndex, 'time'));
      if (currentInterval && !currentInterval.is_rest && restTime != null) {
        currentInterval.rest_after_s = (currentInterval.rest_after_s ?? 0) + restTime;
      }
    } else if (klass?.kind === 'length') {
      if (!currentInterval || currentInterval.interval_number !== klass.interval) {
        // Orphan length row — accept it but synthesize an interval container.
        currentInterval = {
          interval_number: klass.interval,
          is_rest: false,
          stroke: null,
          lengths_count: null,
          distance_m: null,
          time_s: null,
          cumulative_time_s: null,
          avg_pace: null, best_pace: null,
          swolf: null, avg_hr: null, max_hr: null,
          total_strokes: null, avg_strokes: null, calories: null,
          lengths: [],
          synthesised: true,
        };
        intervals.push(currentInterval);
      }
      // Length rows with stroke "--" inherit the parent interval's stroke.
      const effectiveStroke = isMissingStroke(stroke)
        ? (currentInterval?.stroke ?? null)
        : stroke;
      const lDist = parseNumber(cell(row, headerIndex, 'distance'));
      const lTime = parseTimeToSeconds(cell(row, headerIndex, 'time'));
      const lStrokes = parseInteger(cell(row, headerIndex, 'total_strokes'));
      const length = {
        interval_number: klass.interval,
        length_in_interval: klass.length,
        stroke: stroke ?? null,
        effective_stroke: effectiveStroke,
        is_drill: isDrillStroke(effectiveStroke),
        is_freestyle: isFreestyleStroke(effectiveStroke),
        distance_m: lDist,
        time_s: lTime,
        strokes: lStrokes,
        // Distance per stroke (m) — the strongest 50m speed predictor.
        dps_m: (lDist != null && lStrokes != null && lStrokes > 0) ? round2(lDist / lStrokes) : null,
        // Stroke rate (strokes per minute).
        stroke_rate_spm: (lStrokes != null && lTime != null && lTime > 0) ? round1((lStrokes / lTime) * 60) : null,
        glitches: [],
      };
      // Per-length glitch detection.
      if (length.time_s != null && length.time_s > 0 && length.time_s < IMPLAUSIBLY_FAST_25M_S) {
        length.glitches.push('implausibly_fast');
        glitches.push({
          interval: length.interval_number,
          length: length.length_in_interval,
          kind: 'implausibly_fast',
          detail: `length time ${length.time_s}s is below the ${IMPLAUSIBLY_FAST_25M_S}s plausibility floor`,
        });
      }
      if (length.distance_m != null && length.distance_m !== poolLengthM) {
        length.glitches.push('distance_mismatch');
        glitches.push({
          interval: length.interval_number,
          length: length.length_in_interval,
          kind: 'distance_mismatch',
          detail: `length recorded ${length.distance_m}m, expected ${poolLengthM}m`,
        });
      }
      // Non-freestyle labels (Butterfly etc.) are no longer auto-flagged as
      // glitches — with stroke detection OFF they shouldn't appear, and
      // with it ON they're intentional. They simply don't count toward
      // best-freestyle-25m below.
      currentInterval.lengths.push(length);
      allLengths.push(length);
    }
    // Rows we don't classify (blank, footer, etc.) are silently skipped.
  }

  // Adjacent-length glitch propagation: a length immediately neighbouring a
  // glitched length is flagged as potentially unreliable. Snapshot the
  // hard-glitch indices first so the adjacency flag doesn't cascade beyond
  // immediate neighbours.
  const hardGlitchIndices = [];
  for (let i = 0; i < allLengths.length; i++) {
    if (allLengths[i].glitches.length > 0) hardGlitchIndices.push(i);
  }
  for (const i of hardGlitchIndices) {
    if (i > 0 && allLengths[i - 1].glitches.length === 0) {
      allLengths[i - 1].glitches.push('adjacent_to_glitch');
    }
    if (i < allLengths.length - 1 && allLengths[i + 1].glitches.length === 0) {
      allLengths[i + 1].glitches.push('adjacent_to_glitch');
    }
  }

  // Synthetic-format rest intervals (numbered "Rest" rows) are in the
  // intervals array as is_rest entries. Attribute each one's duration to the
  // preceding non-rest interval's rest_after_s so both CSV formats yield
  // consistent rest accounting.
  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i].is_rest && intervals[i].time_s != null) {
      // find nearest preceding non-rest interval
      for (let j = i - 1; j >= 0; j--) {
        if (!intervals[j].is_rest) {
          intervals[j].rest_after_s = (intervals[j].rest_after_s ?? 0) + intervals[i].time_s;
          break;
        }
      }
    }
  }

  const summary = computeSummary(intervals, allLengths, poolLengthM);
  return { intervals, lengths: allLengths, summary, glitches };
}

// ──────────────────────────────────────────────────────────────────────────
// Session-level aggregations.
// ──────────────────────────────────────────────────────────────────────────

function emptySummary() {
  return {
    total_distance_m: 0,
    total_time_s: 0,
    avg_pace_per_100m: null,
    avg_swolf: null,
    avg_hr: null,
    max_hr: null,
    avg_strokes_per_length: null,
    avg_dps_m: null,
    avg_stroke_rate_spm: null,
    best_25m_split_s: null,
    best_25m_context: null,
    best_25m_unverified_s: null,
    best_25m_unverified_context: null,
  };
}

function avg(arr) {
  const clean = arr.filter(v => v != null && Number.isFinite(v));
  if (clean.length === 0) return null;
  return clean.reduce((a, b) => a + b, 0) / clean.length;
}

function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

function computeSummary(intervals, lengths, poolLengthM) {
  const swimmingIntervals = intervals.filter(i => !i.is_rest);

  const totalDistance = swimmingIntervals.reduce((s, i) => s + (i.distance_m || 0), 0);
  const totalTime = swimmingIntervals.reduce((s, i) => s + (i.time_s || 0), 0);

  // Exclude SWOLF = 0 from the average — Garmin emits 0 for drill intervals
  // where stroke count is zero (e.g. pure push-off glide), and a literal 0
  // would drag the session-level SWOLF average toward meaninglessness.
  const avgSwolfRaw = avg(swimmingIntervals.map(i => i.swolf).filter(v => v == null || v > 0));
  const avgHr = avg(swimmingIntervals.map(i => i.avg_hr));
  const maxHrVals = swimmingIntervals.map(i => i.max_hr).filter(v => v != null);
  const maxHr = maxHrVals.length ? Math.max(...maxHrVals) : null;
  const avgStrokes = avg(swimmingIntervals.map(i => i.avg_strokes));

  // DPS + stroke rate across freestyle, non-drill lengths that have a stroke
  // count. These are the efficiency markers the research flagged as the
  // strongest 50m predictors.
  const effortLengths = lengths.filter(l => l.is_freestyle && !l.is_drill && l.strokes != null && l.strokes > 0);
  const avgDps = avg(effortLengths.map(l => l.dps_m));
  const avgStrokeRate = avg(effortLengths.map(l => l.stroke_rate_spm));

  // Best 25m split = fastest single-length freestyle (Unknown counts) with
  // no hard glitches. Drill lengths are excluded — they're not sprint
  // efforts. Track an "unverified" candidate too: the fastest length whose
  // only glitch is adjacent_to_glitch, flagged as suspicious-but-maybe-real.
  let best = null;
  let bestUnverified = null;
  for (const len of lengths) {
    if (len.time_s == null || len.time_s <= 0) continue;
    if (len.distance_m != null && len.distance_m !== poolLengthM) continue;
    if (len.is_drill) continue;
    if (!len.is_freestyle) continue;

    const hardGlitch = len.glitches.some(g => g !== 'adjacent_to_glitch');
    if (hardGlitch) continue;

    if (len.glitches.includes('adjacent_to_glitch')) {
      if (!bestUnverified || len.time_s < bestUnverified.time_s) bestUnverified = len;
    } else {
      if (!best || len.time_s < best.time_s) best = len;
    }
  }

  return {
    total_distance_m: totalDistance || null,
    total_time_s: totalTime || null,
    avg_pace_per_100m: formatPacePer100m(totalDistance, totalTime),
    avg_swolf: avgSwolfRaw == null ? null : Math.round(avgSwolfRaw),
    avg_hr: avgHr == null ? null : Math.round(avgHr),
    max_hr: maxHr,
    avg_strokes_per_length: avgStrokes == null ? null : Number(avgStrokes.toFixed(1)),
    avg_dps_m: round2(avgDps),
    avg_stroke_rate_spm: round1(avgStrokeRate),
    best_25m_split_s: best ? best.time_s : null,
    best_25m_context: best ? `INT ${best.interval_number}.${best.length_in_interval}` : null,
    best_25m_unverified_s: bestUnverified ? bestUnverified.time_s : null,
    best_25m_unverified_context: bestUnverified
      ? `INT ${bestUnverified.interval_number}.${bestUnverified.length_in_interval} — adjacent to a glitched length`
      : null,
  };
}
