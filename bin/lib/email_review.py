"""Pure helpers for bin/email-review.

The CLI reads Gmail and the ledger. This module owns deterministic triage,
deduplication, provenance formatting, report shaping, and ledger record
serialization. It intentionally stores no raw email body in ledger records.
"""

import hashlib
import json
import re


ACTION_PATTERNS = [
    (re.compile(r'\b(action required|requires action|please action)\b', re.I), 4, 'action-language'),
    (re.compile(r'\b(deadline|due|due by|before|by \d{4}-\d{2}-\d{2})\b', re.I), 3, 'deadline-language'),
    (re.compile(r'\b(please|could you|can you|would you|need you to)\b', re.I), 2, 'request-language'),
    (re.compile(r'\b(submit|sign|approve|confirm|review|respond|reply|send|complete|upload)\b', re.I), 2, 'request-language'),
    (re.compile(r'\b(invoice|payment|receipt|renewal|permit|passport|visa|tenancy|contract|form)\b', re.I), 2, 'admin-language'),
    (re.compile(r'\b(attached|attachment|enclosed)\b', re.I), 1, 'attachment-language'),
]

CONTEXT_PATTERNS = [
    (re.compile(r'\b(confirmed|accepted|approved|scheduled|registered|registration)\b', re.I), 3, 'confirmation-language'),
    (re.compile(r'\b(workshop|conference|seminar|meeting|travel|flight|hotel|grant|paper|revision)\b', re.I), 2, 'context-language'),
]

NOISE_PATTERNS = [
    (re.compile(r'\b(unsubscribe|newsletter|digest|promotion|promotions|sale|webinar)\b', re.I), 4, 'bulk-mail-language'),
    (re.compile(r'\b(no-?reply|newsletter|marketing|mailer|notification)\b', re.I), 2, 'bulk-sender'),
]

DATE_RE = re.compile(
    r'\b('
    r'\d{4}-\d{2}-\d{2}|'
    r'(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?'
    r')\b',
    re.I,
)


def _clean(s):
    if s is None:
        return ''
    return re.sub(r'\s+', ' ', str(s)).strip()


def _subject_hash(subject):
    return hashlib.sha256(_clean(subject).lower().encode('utf-8')).hexdigest()[:16]


def message_key(message):
    """Return the stable dedup key for a Gmail message dict.

    Message-ID is primary because Gmail UIDs are mailbox-stable but not a
    portable identity across account migrations. The fallback avoids storing
    raw subject text.
    """
    mid = _clean(message.get('message_id'))
    if mid:
        return f'message-id:{mid}'
    uid = _clean(message.get('uid')) or '?'
    date = _clean(message.get('date')) or '?'
    sender = _clean(message.get('from')).lower() or '?'
    return f'fallback:{uid}:{date}:{hashlib.sha256(sender.encode("utf-8")).hexdigest()[:12]}:{_subject_hash(message.get("subject"))}'


def parse_ledger_lines(lines):
    """Parse JSONL ledger rows, skipping blanks and malformed lines."""
    out = []
    for line in lines:
        if not line or not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            out.append(row)
    return out


def is_reviewed(message, ledger, asof):
    """Whether the message should be suppressed for this review date."""
    key = message_key(message)
    for row in reversed(ledger or []):
        if row.get('key') != key:
            continue
        status = row.get('status', '')
        if status == 'deferred':
            revisit = row.get('revisit_after', '')
            return bool(revisit and revisit > asof)
        return status in {
            'reported', 'asked', 'ignored', 'todo-created', 'vaulted',
            'done', 'not-actionable',
        }
    return False


def _score_text(subject, body, sender):
    text = f'{subject}\n{body}'
    score = 0
    reasons = []
    for pattern, weight, reason in ACTION_PATTERNS:
        if pattern.search(text):
            score += weight
            if reason not in reasons:
                reasons.append(reason)
    context_score = 0
    for pattern, weight, reason in CONTEXT_PATTERNS:
        if pattern.search(text):
            context_score += weight
            if reason not in reasons:
                reasons.append(reason)
    noise_score = 0
    noise_reasons = []
    noise_text = f'{sender}\n{subject}\n{body[:500]}'
    for pattern, weight, reason in NOISE_PATTERNS:
        if pattern.search(noise_text):
            noise_score += weight
            if reason not in noise_reasons:
                noise_reasons.append(reason)
    return score, context_score, noise_score, reasons, noise_reasons


def _first_dateish(text):
    m = DATE_RE.search(text or '')
    return m.group(1) if m else ''


def provenance(message):
    """Compact source marker for reports and future vault writes."""
    uid = _clean(message.get('uid')) or '?'
    date = _clean(message.get('date')) or '?'
    sender = _clean(message.get('from')) or '?'
    subject = _clean(message.get('subject')) or '(no subject)'
    return f'gmail:uid={uid}; date={date}; from={sender}; subject="{subject}"'


def triage_message(message):
    """Classify one message into action_needed, context_candidate, or ignore."""
    subject = _clean(message.get('subject'))
    body = _clean(message.get('body'))
    sender = _clean(message.get('from'))
    action_score, context_score, noise_score, reasons, noise_reasons = _score_text(subject, body, sender)
    score = action_score + context_score - noise_score
    dateish = _first_dateish(f'{subject}\n{body}')

    if noise_score >= 4 and action_score < 5:
        category = 'ignore'
        suggested = 'record as ignored in the email-review ledger'
        question = ''
        reasons = noise_reasons
    elif action_score >= 5 or score >= 6:
        category = 'action_needed'
        suggested = 'consider creating or updating a background todo'
        if dateish:
            question = f'This looks actionable with date {dateish}. Should I create/update a background todo?'
        else:
            question = 'This looks actionable. Should I create/update a background todo, or is it already handled?'
    elif context_score >= 3 or score >= 3:
        category = 'context_candidate'
        suggested = 'consider logging a sourced vault fact/event if this is useful later'
        question = ''
    else:
        category = 'ignore'
        suggested = 'record as ignored in the email-review ledger'
        question = ''

    return {
        'uid': _clean(message.get('uid')),
        'key': message_key(message),
        'date': _clean(message.get('date')),
        'from': sender,
        'subject': subject,
        'category': category,
        'score': score,
        'reasons': reasons,
        'suggested_action': suggested,
        'question': question,
        'provenance': provenance(message),
    }


def select_review_items(messages, ledger, asof, max_questions=5, include_reviewed=False):
    """Return the triage items worth surfacing, sorted by priority."""
    items = []
    already = 0
    for idx, message in enumerate(messages):
        if not include_reviewed and is_reviewed(message, ledger, asof):
            already += 1
            continue
        item = triage_message(message)
        if item['category'] != 'ignore':
            item['_order'] = idx
            items.append(item)

    items.sort(key=lambda i: (-i['score'], i['_order']))
    questions_left = max(0, int(max_questions))
    for item in items:
        if not item.get('question'):
            pass
        elif questions_left > 0:
            questions_left -= 1
        else:
            item['question'] = ''
        item.pop('_order', None)

    return {
        'asof': asof,
        'reviewed_count': len(messages),
        'already_reviewed_count': already,
        'items': items,
    }


def format_markdown_report(review, days):
    """Render a compact agent-facing markdown report."""
    items = review.get('items', [])
    q_count = sum(1 for i in items if i.get('question'))
    lines = [
        f'# Email Review - last {days} day{"s" if int(days) != 1 else ""}',
        '',
        f'Reviewed: {review.get("reviewed_count", 0)} messages; skipped already-reviewed: {review.get("already_reviewed_count", 0)}; surfaced: {len(items)}; questions: {q_count}.',
        '',
    ]
    if not items:
        lines.append('No action-worthy or vault-worthy email candidates found.')
        return '\n'.join(lines)

    for idx, item in enumerate(items, 1):
        lines.append(f'## {idx}. {item["subject"] or "(no subject)"}')
        lines.append(f'- Category: {item["category"]}; score: {item["score"]}')
        lines.append(f'- Source: {item["provenance"]}')
        lines.append(f'- Why: {", ".join(item["reasons"]) if item["reasons"] else "heuristic match"}')
        lines.append(f'- Suggested action: {item["suggested_action"]}')
        if item.get('question'):
            lines.append(f'- Question: {item["question"]}')
        lines.append('')
    return '\n'.join(lines).rstrip() + '\n'


def ledger_records_for_review(review, reviewed_at, status='reported'):
    """Create JSON-serializable ledger rows for surfaced messages.

    Records contain identity, metadata, category, and decision status, but no
    body/snippet. The agent can later append a stronger status after acting.
    """
    records = []
    for item in review.get('items', []):
        records.append({
            'key': item['key'],
            'uid': item.get('uid', ''),
            'date': item.get('date', ''),
            'from': item.get('from', ''),
            'subject_hash': _subject_hash(item.get('subject', '')),
            'category': item.get('category', ''),
            'status': status,
            'reviewed_at': reviewed_at,
            'reason': ', '.join(item.get('reasons', [])),
        })
    return records


def to_jsonl(records):
    return ''.join(json.dumps(r, sort_keys=True, ensure_ascii=False) + '\n' for r in records)
