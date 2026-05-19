// capture-classifier.js — pure utterance classifier for `wiki capture`.
//
// Deterministic shape lexicon (regex banks) + precedence resolver +
// confidence/date inference. No NLP, no fs, no spawn. Output is a small object
// the CLI verb uses to build the observation line, then delegate to cmdPatch.
//
// Why a dedicated module: the lexicon (FUTURE_TENSE_RE, EPISTEMIC_RE) is also
// consumed by `speculative-shape-fact` in audit.js. Single source of truth.

'use strict';

const { assertBody } = require('./epistemic-verbs.js');

// ─── shape lexicons ───────────────────────────────────────────────────────

const QUESTION_RE = /(\?\s*$|^(why|how|where|when|does|is|are|can|should|would|could|will|wonder)\b|^i (wonder|don'?t (know|understand))\b|^i'?m not sure\b)/i;
const DECISION_RE = /\b(i'?ve\s+)?(decided|chose|chosen|going\s+with|sticking\s+with|committing\s+to)\b/i;
const CLAIM_SAYS_RE = /^([A-Z][\w-]*|[\w-]+)\s+(says?|said|told|claims?|reports?|argues?|insists?)\b/;
const CLAIM_ACCORDING_RE = /^according\s+to\s+([\w-]+)/i;
const FUTURE_TENSE_RE = /\b(will|going\s+to|plans\s+to|aims\s+to|expects?\s+to|hopes?\s+to|is\s+set\s+to)\b/i;
const EPISTEMIC_RE = /\b(might|may|could|i\s+(think|believe|guess|suspect|expect)|seems?\s+(to|like)|probably|likely|apparently)\b/i;
const OPINION_RE = /\b(i\s+(prefer|like|dislike|love|hate)|is\s+the\s+best|better\s+than|worse\s+than|i\s+(don'?t\s+)?(agree|disagree))\b/i;
const IDEA_RE = /\b(what\s+if|an\s+idea|we\s+could\s+try|how\s+about|could\s+we\s+try)\b/i;

// Confidence intensity (highest match wins; "reject" beats "strong" so
// "definitely unlikely" maps to 0.2 — the reject intensity, not the strong).
const REJECT_HEDGE = /\b(unlikely|doubt|don'?t\s+think)\b/i; // 0.2
const STRONG_HEDGE = /\b(definitely|certainly|surely|no\s+doubt)\b/i; // 0.9
const MEDIUM_HEDGE = /\b(probably|likely|quite\s+sure|pretty\s+sure)\b/i; // 0.7
const WEAK_HEDGE = /\b(might|maybe|perhaps)\b/i; // 0.5

function inferConfidence(text) {
  if (REJECT_HEDGE.test(text)) return 0.2;
  if (STRONG_HEDGE.test(text)) return 0.9;
  if (MEDIUM_HEDGE.test(text)) return 0.7;
  if (WEAK_HEDGE.test(text)) return 0.5;
  return 0.6; // neutral default for pred/hyp
}

const MONTH_NUM = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};
const QUARTER_END_MONTH = ['03', '06', '09', '12']; // Q1..Q4

function extractDate(text) {
  // by YYYY-MM-DD | by YYYY-MM | by YYYY (most specific first)
  let m = text.match(/\bby\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (m) return m[1];
  m = text.match(/\bby\s+(\d{4}-\d{2})\b/i);
  if (m) return m[1];
  m = text.match(/\bby\s+(\d{4})\b/i);
  if (m) return m[1];
  // by Month YYYY
  m = text.match(/\bby\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i);
  if (m) return `${m[2]}-${MONTH_NUM[m[1].toLowerCase()]}`;
  // by Qn YYYY
  m = text.match(/\bby\s+Q([1-4])\s+(\d{4})\b/i);
  if (m) return `${m[2]}-${QUARTER_END_MONTH[Number(m[1]) - 1]}`;
  // in YYYY
  m = text.match(/\bin\s+(\d{4})\b/);
  if (m) return m[1];
  return null;
}

function classifyUtterance(text) {
  assertBody(text); // empty + bracket rejection (reused from epistemic-verbs.js)
  const t = text.trim();

  // Precedence-ordered detection. Most specific shapes first; bare fact fallback last.
  if (QUESTION_RE.test(t)) return { category: 'question', body: t };
  if (DECISION_RE.test(t)) return { category: 'decision', body: t };

  let sm = t.match(CLAIM_SAYS_RE);
  if (!sm) sm = t.match(CLAIM_ACCORDING_RE);
  if (sm) return { category: 'claim', source: sm[1], body: t };

  if (FUTURE_TENSE_RE.test(t)) {
    const by = extractDate(t);
    if (!by) return { category: null, refuseReason: 'prediction-without-date', body: t };
    return { category: 'prediction', by_date: by, confidence: inferConfidence(t), body: t };
  }

  if (EPISTEMIC_RE.test(t)) return { category: 'hypothesis', confidence: inferConfidence(t), body: t };
  if (OPINION_RE.test(t)) return { category: 'opinion', confidence: inferConfidence(t), body: t };
  if (IDEA_RE.test(t)) return { category: 'idea', body: t };

  return { category: 'fact', body: t };
}

module.exports = {
  classifyUtterance,
  // Re-exported for audit.js to import the same lexicon (single source of
  // truth across detection in audit and routing in capture).
  FUTURE_TENSE_RE,
  EPISTEMIC_RE,
};
