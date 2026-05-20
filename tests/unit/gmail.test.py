# Unit tests for bin/lib/gmail.py — pure helpers consumed by bin/gmail.
# Locks the IMAP-criteria builder, MIME header decoder, header-block parser,
# MIME body extractor, and search-row formatter so the CLI orchestrator can
# remain a thin shell over deterministic primitives.

import os
import sys
import unittest

# Make bin/lib/gmail.py importable without packaging gymnastics.
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.join(REPO_ROOT, 'bin', 'lib'))

import gmail as G  # noqa: E402


class BuildSearchCriteria(unittest.TestCase):
    def test_from_only(self):
        self.assertEqual(G.build_search_criteria({'from': 'alice'}), ['FROM', '"alice"'])

    def test_from_and_since(self):
        self.assertEqual(
            G.build_search_criteria({'from': 'x', 'since': '2026-05-01'}),
            ['FROM', '"x"', 'SINCE', '01-May-2026'],
        )

    def test_subject_body_to_combine_AND(self):
        self.assertEqual(
            G.build_search_criteria({'subject': 'deadline', 'body': 'lease', 'to': 'me@example.com'}),
            ['SUBJECT', '"deadline"', 'BODY', '"lease"', 'TO', '"me@example.com"'],
        )

    def test_before_emits_proper_date(self):
        self.assertEqual(
            G.build_search_criteria({'before': '2026-01-15'}),
            ['BEFORE', '15-Jan-2026'],
        )

    def test_has_attachment_uses_gm_raw(self):
        self.assertEqual(
            G.build_search_criteria({'has_attachment': True}),
            ['X-GM-RAW', '"has:attachment"'],
        )

    def test_label_uses_gm_labels(self):
        self.assertEqual(
            G.build_search_criteria({'label': 'Work'}),
            ['X-GM-LABELS', '"Work"'],
        )

    def test_query_overrides_other_flags(self):
        self.assertEqual(
            G.build_search_criteria({'query': 'from:x newer_than:7d', 'from': 'ignored'}),
            ['X-GM-RAW', '"from:x newer_than:7d"'],
        )

    def test_empty_flags_raises(self):
        with self.assertRaises(G.GmailFlagError):
            G.build_search_criteria({})

    def test_bad_date_shape_raises(self):
        with self.assertRaises(G.GmailFlagError):
            G.build_search_criteria({'since': 'yesterday'})


class DecodeMimeHeader(unittest.TestCase):
    def test_passthrough_ascii(self):
        self.assertEqual(G.decode_mime_header('Plain ASCII'), 'Plain ASCII')

    def test_base64_utf8(self):
        # =?UTF-8?B?VGVzdA==?= → "Test"
        self.assertEqual(G.decode_mime_header('=?UTF-8?B?VGVzdA==?='), 'Test')

    def test_qp_latin1(self):
        # =?ISO-8859-1?Q?Caf=E9?= → "Café"
        self.assertEqual(G.decode_mime_header('=?ISO-8859-1?Q?Caf=E9?='), 'Café')

    def test_multi_chunk(self):
        # Two encoded chunks combine to one decoded string.
        self.assertEqual(
            G.decode_mime_header('=?UTF-8?B?SGVsbG8=?= =?UTF-8?B?V29ybGQ=?='),
            'HelloWorld',
        )

    def test_none_returns_empty(self):
        self.assertEqual(G.decode_mime_header(None), '')


class ParseHeaderBlock(unittest.TestCase):
    def test_basic_block(self):
        raw = (
            b'From: Alice <alice@example.com>\r\n'
            b'To: user@example.com\r\n'
            b'Subject: Lease renewal deadline\r\n'
            b'Date: Mon, 12 May 2026 09:00:00 +0800\r\n'
        )
        h = G.parse_header_block(raw)
        self.assertEqual(h['from'], 'Alice <alice@example.com>')
        self.assertEqual(h['to'], 'user@example.com')
        self.assertEqual(h['subject'], 'Lease renewal deadline')
        self.assertEqual(h['date'], '2026-05-12')

    def test_mime_subject_decoded(self):
        raw = (
            b'From: x@example.com\r\n'
            b'Subject: =?UTF-8?B?Q2Fmw6kgY29tcGFueQ==?=\r\n'
            b'Date: Tue, 13 May 2026 10:00:00 +0000\r\n'
        )
        h = G.parse_header_block(raw)
        self.assertEqual(h['subject'], 'Café company')

    def test_missing_fields_become_empty_string(self):
        raw = b'From: only@example.com\r\n'
        h = G.parse_header_block(raw)
        self.assertEqual(h['from'], 'only@example.com')
        self.assertEqual(h['subject'], '')
        self.assertEqual(h['date'], '')
        self.assertEqual(h['to'], '')


class ExtractTextBody(unittest.TestCase):
    def test_text_plain_preferred(self):
        raw = (
            b'Content-Type: multipart/alternative; boundary="b1"\r\n'
            b'\r\n'
            b'--b1\r\n'
            b'Content-Type: text/plain; charset=utf-8\r\n'
            b'\r\n'
            b'Plain body wins.\r\n'
            b'--b1\r\n'
            b'Content-Type: text/html; charset=utf-8\r\n'
            b'\r\n'
            b'<p>HTML fallback.</p>\r\n'
            b'--b1--\r\n'
        )
        self.assertIn('Plain body wins.', G.extract_text_body(raw))

    def test_html_only_strips_tags(self):
        raw = (
            b'Content-Type: text/html; charset=utf-8\r\n'
            b'\r\n'
            b'<html><body><p>The deadline is <b>May 31</b>.</p></body></html>\r\n'
        )
        out = G.extract_text_body(raw)
        self.assertIn('The deadline is May 31.', out)
        self.assertNotIn('<', out)
        self.assertNotIn('>', out)

    def test_single_part_plain(self):
        raw = (
            b'Content-Type: text/plain; charset=utf-8\r\n'
            b'\r\n'
            b'Just plain content here.\r\n'
        )
        self.assertIn('Just plain content here.', G.extract_text_body(raw))


class FormatSearchRow(unittest.TestCase):
    def test_tab_separated_fields(self):
        row = G.format_search_row(
            uid='123',
            headers={'date': '2026-05-12', 'from': 'alice@example.com', 'subject': 'hello'},
        )
        self.assertEqual(row, '123\t2026-05-12\talice@example.com\thello')

    def test_tabs_in_subject_replaced(self):
        # IMAP allows tabs in subjects; the tab-separated output requires we strip them.
        row = G.format_search_row(
            uid='1',
            headers={'date': '2026-05-12', 'from': 'a@b', 'subject': 'has\ttab'},
        )
        self.assertEqual(row, '1\t2026-05-12\ta@b\thas tab')


if __name__ == '__main__':
    unittest.main()
