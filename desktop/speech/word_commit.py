class WordCommitter:
    """Commit stable words once; leave a short forced-cut tail for the next window."""
    def __init__(self):
        self.until = float('-inf')

    def accept(self, words, offset, duration, final=True):
        limit = offset + duration - (0 if final else .35)
        for word in words:
            start, end = offset + word.start, offset + word.end
            if (start + end) / 2 < self.until - .02:
                continue
            if end > limit:
                continue
            self.until = max(self.until, end)
            yield word
