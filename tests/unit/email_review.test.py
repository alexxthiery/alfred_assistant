# Unit tests for bin/lib/email_review.py — pure helpers consumed by bin/email-review.
# The tests use synthetic message dictionaries so the oracle is the documented
# triage contract, not live Gmail state.

import os
import sys
import unittest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.join(REPO_ROOT, 'bin', 'lib'))

import email_review as R  # noqa: E402


def msg(uid, subject, body='', sender='admin@example.edu', message_id=None, date='2026-09-09'):
    mid = f'<m{uid}@example.edu>' if message_id is None else message_id
    return {
        'uid': uid,
        'message_id': mid,
        'date': date,
        'from': sender,
        'to': 'user@example.com',
        'subject': subject,
        'body': body,
    }


class MessageKey(unittest.TestCase):
    def test_message_id_is_primary_key(self):
        a = msg('1', 'Subject v1', message_id='<same@example.com>')
        b = msg('2', 'Subject v2', message_id='<same@example.com>')
        self.assertEqual(R.message_key(a), 'message-id:<same@example.com>')
        self.assertEqual(R.message_key(a), R.message_key(b))

    def test_fallback_key_uses_hash_not_raw_subject(self):
        m = msg('7', 'Sensitive contract deadline', message_id='')
        key = R.message_key(m)
        self.assertTrue(key.startswith('fallback:'))
        self.assertNotIn('Sensitive contract deadline', key)


class LedgerParsing(unittest.TestCase):
    def test_parse_ledger_lines_skips_blank_and_bad_json(self):
        rows = R.parse_ledger_lines([
            '',
            '{"key":"message-id:<a>","status":"reported"}',
            '{bad json',
        ])
        self.assertEqual(rows, [{'key': 'message-id:<a>', 'status': 'reported'}])

    def test_reviewed_message_is_suppressed_by_key(self):
        m = msg('1', 'Please review form', message_id='<a>')
        ledger = [{'key': 'message-id:<a>', 'status': 'reported'}]
        self.assertTrue(R.is_reviewed(m, ledger, asof='2026-09-09'))

    def test_deferred_message_returns_after_revisit_date(self):
        m = msg('1', 'Please review form', message_id='<a>')
        ledger = [{'key': 'message-id:<a>', 'status': 'deferred', 'revisit_after': '2026-09-08'}]
        self.assertFalse(R.is_reviewed(m, ledger, asof='2026-09-09'))


class Triage(unittest.TestCase):
    def test_deadline_and_attachment_email_becomes_action_candidate(self):
        item = R.triage_message(msg(
            '10',
            'Action required: submit tenancy form',
            'Please sign and submit the attached tenancy form by 2026-09-18.',
        ))
        self.assertEqual(item['category'], 'action_needed')
        self.assertIn('deadline-language', item['reasons'])
        self.assertIn('request-language', item['reasons'])
        self.assertIn('todo', item['suggested_action'])
        self.assertIn('2026-09-18', item['question'])

    def test_newsletter_is_not_question_worthy_even_with_click_language(self):
        item = R.triage_message(msg(
            '11',
            'Weekly newsletter: please read our update',
            'Unsubscribe here. This digest includes promotions and webinar news.',
            sender='newsletter@vendor.example',
        ))
        self.assertEqual(item['category'], 'ignore')
        self.assertEqual(item['question'], '')

    def test_clear_context_without_action_is_log_candidate(self):
        item = R.triage_message(msg(
            '12',
            'Workshop registration confirmed',
            'Your registration for the IMS workshop has been confirmed.',
        ))
        self.assertEqual(item['category'], 'context_candidate')
        self.assertIn('vault fact/event', item['suggested_action'])

    def test_select_review_items_suppresses_reviewed_and_caps_questions(self):
        messages = [
            msg('1', 'Action required: submit A', 'Please submit by 2026-09-11.', message_id='<a>'),
            msg('2', 'Action required: submit B', 'Please submit by 2026-09-12.', message_id='<b>'),
            msg('3', 'Action required: submit C', 'Please submit by 2026-09-13.', message_id='<c>'),
        ]
        ledger = [{'key': 'message-id:<a>', 'status': 'reported'}]
        review = R.select_review_items(messages, ledger, asof='2026-09-09', max_questions=1)
        self.assertEqual(review['reviewed_count'], 3)
        self.assertEqual(review['already_reviewed_count'], 1)
        self.assertEqual([i['uid'] for i in review['items']], ['2', '3'])
        self.assertEqual(sum(1 for i in review['items'] if i['question']), 1)


class Reporting(unittest.TestCase):
    def test_markdown_report_cites_source_and_excludes_body(self):
        messages = [
            msg('10', 'Action required: submit tenancy form',
                'Please sign and submit the attached tenancy form by 2026-09-18. Private body detail.'),
        ]
        review = R.select_review_items(messages, [], asof='2026-09-09', max_questions=3)
        out = R.format_markdown_report(review, days=1)
        self.assertIn('gmail:uid=10; date=2026-09-09; from=admin@example.edu', out)
        self.assertIn('Action required: submit tenancy form', out)
        self.assertNotIn('Private body detail', out)

    def test_ledger_records_do_not_store_body(self):
        review = R.select_review_items([
            msg('10', 'Action required: submit tenancy form', 'Sensitive body text.'),
        ], [], asof='2026-09-09', max_questions=3)
        records = R.ledger_records_for_review(review, reviewed_at='2026-09-09T10:00:00+08:00')
        self.assertEqual(len(records), 1)
        self.assertNotIn('body', records[0])
        self.assertEqual(records[0]['status'], 'reported')

    def test_ledger_records_can_use_explicit_status(self):
        review = R.select_review_items([
            msg('10', 'Action required: submit tenancy form', 'Please submit it.'),
        ], [], asof='2026-09-09', max_questions=3)
        records = R.ledger_records_for_review(
            review,
            reviewed_at='2026-09-09T10:00:00+08:00',
            status='asked',
        )
        self.assertEqual(records[0]['status'], 'asked')


if __name__ == '__main__':
    unittest.main()
