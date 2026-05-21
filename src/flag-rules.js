// Flag rules — the shared contract between the validator (checks generated
// sessions respect active flags) and the symptom mapper (turns athlete
// free-text into flags). Defining it once keeps both in sync.
//
// Each rule: what the flag means, what session content it forbids, and the
// guidance text to feed the LLM so it generates a compliant session in the
// first place.

export const FLAG_RULES = Object.freeze({
  left_quad_cramp: {
    label: 'Left quad cramp',
    forbid_keywords: ['dolphin kick', 'plyometric', 'plyo', 'explosive push-off', 'ballistic', 'box jump'],
    guidance:
      'Left quad cramp is active. No dolphin kick activation and no explosive/plyometric push-off work. ' +
      'Wall drills are push-and-glide only. Keep ≥2 min rest between any max efforts (rest interval is the ' +
      'protective variable). Tell the athlete to stop and rest if any tightness appears.',
  },
  right_quad_pre_cramp: {
    label: 'Right quad pre-cramp',
    forbid_keywords: ['dolphin kick', 'plyometric', 'plyo', 'explosive push-off', 'ballistic', 'box jump'],
    guidance:
      'Right quad pre-cramp is active (bilateral hip-flexor endurance deficit). No dolphin kick or explosive ' +
      'push-off. Controlled quad/hip-flexor loading only — no ballistic work. Keep L-sit / isometric holds short.',
  },
  shoulder_discomfort: {
    label: 'Shoulder discomfort',
    forbid_keywords: ['lat pullover', 'butterfly', 'ballistic pull'],
    guidance:
      'Shoulder discomfort is active. Avoid lat pullover (permanently retired) and high-load overhead/ballistic ' +
      'pulling. Favour scapular stability and controlled range.',
  },
});

/** Return the rule objects for a list of active flag keys (unknown keys ignored). */
export function restrictionsForFlags(flags = []) {
  return flags.map(f => FLAG_RULES[f]).filter(Boolean);
}

/** Concatenated guidance text to inject into the LLM prompt for active flags. */
export function guidanceForFlags(flags = []) {
  const rules = restrictionsForFlags(flags);
  if (!rules.length) return '';
  return rules.map(r => `- ${r.guidance}`).join('\n');
}
