import unittest
from worker import SpeakerTimeline, speaker_at


class TimelineTests(unittest.TestCase):
    def test_cluster_names_can_swap_without_swapping_speaker_identities(self):
        timeline = SpeakerTimeline()
        self.assertEqual(timeline.assign([(0, 2, 'A'), (2, 4, 'B')]), [(0, 2, 0), (2, 4, 1)])
        self.assertEqual(timeline.assign([(1, 2, 'B'), (2, 5, 'A')]), [(1, 2, 0), (2, 5, 1)])

    def test_new_speaker_after_context_expires_gets_new_identity(self):
        timeline = SpeakerTimeline()
        timeline.assign([(0, 2, 'A')])
        self.assertEqual(timeline.assign([(60, 62, 'A')])[0][2], 1)

    def test_overlapping_or_uncovered_words_have_no_guessed_identity(self):
        self.assertIsNone(speaker_at(0, 1, [(0, 1, 0), (0, 1, 1)]))
        self.assertIsNone(speaker_at(0, 1, []))
        self.assertEqual(speaker_at(0, 1, [(0, 1, 2), (.9, 1, 1)]), 2)


if __name__ == '__main__':
    unittest.main()
