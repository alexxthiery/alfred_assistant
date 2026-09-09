"""Pure helpers for bin/gmail.

No I/O — every function in here takes bytes or dicts and returns strings or
lists. The CLI orchestrator (bin/gmail) does all imaplib + stdout work and
calls into here for the actual data shaping. Unit tests in
tests/unit/gmail.test.py lock the contracts.

Exposed names:
    GmailFlagError, GmailParseError  — named exceptions for clean exit codes
    build_search_criteria(flags)     — dict[str,Any] -> list[str] IMAP args
    decode_mime_header(raw)          — str|None -> str (RFC 2047 decoded)
    parse_header_block(raw_bytes)    — bytes -> dict[str,str]
    extract_text_body(raw_bytes)     — bytes -> str (MIME-walked, decoded)
    format_search_row(uid, headers)  — str, dict -> tab-separated str
"""

import email
import email.header
import email.utils
import re
from datetime import datetime


class GmailFlagError(Exception):
    """Raised by build_search_criteria on invalid/missing flags."""


class GmailParseError(Exception):
    """Raised on MIME or header parsing failures."""


_MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
               'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def _iso_to_imap_date(iso):
    """'2026-05-01' -> '01-May-2026'. Raises GmailFlagError on bad shape."""
    if not isinstance(iso, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', iso):
        raise GmailFlagError(f'date must be YYYY-MM-DD; got {iso!r}')
    try:
        dt = datetime.strptime(iso, '%Y-%m-%d')
    except ValueError as e:
        raise GmailFlagError(f'invalid date {iso!r}: {e}')
    return f'{dt.day:02d}-{_MONTH_ABBR[dt.month - 1]}-{dt.year}'


# IMAP SEARCH argv shape. Order doesn't matter for AND semantics, but the
# unit tests assert a specific order to catch silent drift. Keep this list
# canonical: flag-name → (IMAP keyword, formatter).
def build_search_criteria(flags):
    """Translate the CLI flags dict into an IMAP SEARCH argument list.

    flags is a plain dict; only recognised keys participate. `query` is
    mutually exclusive — when present, it overrides everything else and
    emits a single X-GM-RAW clause (Gmail's native search syntax).

    Raises GmailFlagError if no recognised filter is set, or a date is
    malformed.
    """
    if not isinstance(flags, dict):
        raise GmailFlagError('flags must be a dict')

    if flags.get('query'):
        return ['X-GM-RAW', f'"{flags["query"]}"']

    out = []
    # Order matches the unit tests' assertions; downstream IMAP doesn't care.
    if flags.get('from'):
        out += ['FROM', f'"{flags["from"]}"']
    if flags.get('subject'):
        out += ['SUBJECT', f'"{flags["subject"]}"']
    if flags.get('body'):
        out += ['BODY', f'"{flags["body"]}"']
    if flags.get('to'):
        out += ['TO', f'"{flags["to"]}"']
    if flags.get('since'):
        out += ['SINCE', _iso_to_imap_date(flags['since'])]
    if flags.get('before'):
        out += ['BEFORE', _iso_to_imap_date(flags['before'])]
    if flags.get('has_attachment'):
        out += ['X-GM-RAW', '"has:attachment"']
    if flags.get('label'):
        out += ['X-GM-LABELS', f'"{flags["label"]}"']

    if not out:
        raise GmailFlagError(
            'at least one filter required '
            '(--from / --to / --subject / --body / --since / --before / '
            '--has-attachment / --label / --query)'
        )
    return out


def decode_mime_header(raw):
    """RFC 2047 decode a header value.

    Accepts str (typical) or None. Returns a single Unicode str. Multi-chunk
    headers are joined without inter-chunk whitespace (email.header.decode_header
    splits on the encoded-word boundaries and we re-concat). Unknown encodings
    fall back to 'utf-8' with replace error handling.
    """
    if raw is None:
        return ''
    if not isinstance(raw, str):
        raw = str(raw)
    try:
        parts = email.header.decode_header(raw)
    except Exception as e:
        raise GmailParseError(f'header decode failed: {e}')
    pieces = []
    for chunk, enc in parts:
        if isinstance(chunk, bytes):
            try:
                pieces.append(chunk.decode(enc or 'utf-8', errors='replace'))
            except (LookupError, TypeError):
                pieces.append(chunk.decode('utf-8', errors='replace'))
        else:
            pieces.append(chunk)
    return ''.join(pieces)


def _normalise_date(raw):
    """RFC 2822 date string -> 'YYYY-MM-DD' or '' if unparseable.

    We collapse to date-only because the search-row format is tab-separated
    and a full datetime would push the from+subject off the screen.
    """
    if not raw:
        return ''
    try:
        dt = email.utils.parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return ''
    if dt is None:
        return ''
    return dt.strftime('%Y-%m-%d')


def parse_header_block(raw_bytes):
    """Extract {from, to, subject, date} from a raw header byte block.

    Accepts the literal bytes returned by an IMAP FETCH of
    BODY[HEADER.FIELDS (...)]. Missing fields become ''. MIME-encoded
    subjects/from-names are RFC 2047 decoded. Date is ISO-normalised to
    YYYY-MM-DD for tab-separated output.
    """
    if not isinstance(raw_bytes, (bytes, bytearray)):
        raise GmailParseError('parse_header_block needs bytes')
    msg = email.message_from_bytes(bytes(raw_bytes))
    return {
        'from': decode_mime_header(msg.get('From', '')),
        'to': decode_mime_header(msg.get('To', '')),
        'subject': decode_mime_header(msg.get('Subject', '')),
        'date': _normalise_date(msg.get('Date', '')),
        'message_id': decode_mime_header(msg.get('Message-ID', '')),
    }


_TAG_RE = re.compile(r'<[^>]+>')
_WS_RE = re.compile(r'\s+')


def _strip_html(s):
    """Best-effort HTML-to-text. Not a full parser; collapses tags + whitespace.

    Good enough for "find a deadline date in this email body" queries. If we
    later need real DOM-aware extraction (tables, lists), swap in html.parser.
    """
    txt = _TAG_RE.sub('', s)
    txt = _WS_RE.sub(' ', txt)
    return txt.strip()


def _decode_part(part):
    """Get a part's payload as a decoded str, charset-aware."""
    payload = part.get_payload(decode=True) or b''
    charset = part.get_content_charset() or 'utf-8'
    try:
        return payload.decode(charset, errors='replace')
    except (LookupError, TypeError):
        return payload.decode('utf-8', errors='replace')


def extract_text_body(raw_bytes):
    """Walk a MIME message; return its plain-text body.

    Preference: text/plain part if present, else text/html with tags stripped.
    Multipart/alternative is the common case (most mail clients send both).
    Returns '' on parse failure or no readable part.
    """
    if not isinstance(raw_bytes, (bytes, bytearray)):
        raise GmailParseError('extract_text_body needs bytes')
    try:
        msg = email.message_from_bytes(bytes(raw_bytes))
    except Exception as e:
        raise GmailParseError(f'mime parse failed: {e}')

    plain = None
    html = None
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            if ctype == 'text/plain' and plain is None:
                plain = _decode_part(part)
            elif ctype == 'text/html' and html is None:
                html = _decode_part(part)
    else:
        ctype = msg.get_content_type()
        if ctype == 'text/plain':
            plain = _decode_part(msg)
        elif ctype == 'text/html':
            html = _decode_part(msg)

    if plain is not None:
        return plain.strip()
    if html is not None:
        return _strip_html(html)
    return ''


def format_search_row(uid, headers):
    """Compose one tab-separated row of search output.

    Layout: <uid>\\t<date>\\t<from>\\t<subject>. Tabs inside any field are
    replaced with spaces so the format stays parseable. Missing headers
    fields become empty strings.
    """
    if not isinstance(uid, str):
        uid = str(uid)
    date = headers.get('date', '') or ''
    sender = (headers.get('from', '') or '').replace('\t', ' ').replace('\n', ' ')
    subject = (headers.get('subject', '') or '').replace('\t', ' ').replace('\n', ' ')
    return f'{uid}\t{date}\t{sender}\t{subject}'
