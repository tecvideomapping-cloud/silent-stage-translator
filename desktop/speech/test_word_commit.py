import unittest
from types import SimpleNamespace
from word_commit import WordCommitter


def word(text, start, end):
    return SimpleNamespace(word=text, start=start, end=end)


class WordCommitTests(unittest.TestCase):
    def test_forced_cut_tail_is_recovered_without_repeating_context(self):
        c = WordCommitter()
        first = list(c.accept([word('uma', 5, 5.3), word('palavra', 5.5, 5.95)], 0, 6, False))
        second = list(c.accept([word('uma', 0, .1), word('palavra', .3, .75), word('inteira', .8, 1.2)], 5.2, 2, True))
        self.assertEqual([w.word for w in first + second], ['uma', 'palavra', 'inteira'])

    def test_deliberate_repeated_words_are_kept(self):
        c = WordCommitter()
        self.assertEqual(len(list(c.accept([word('não', 0, .2), word('não', .22, .4)], 0, 1))), 2)

    def test_pause_flush_preserves_the_last_word(self):
        c = WordCommitter()
        self.assertEqual(len(list(c.accept([word('final', .8, 1)], 0, 1, True))), 1)


if __name__ == '__main__':
    unittest.main()
