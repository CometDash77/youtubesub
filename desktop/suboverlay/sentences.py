"""Sentence groups from cues. Adapted from yt-dual-subs (MIT)."""
from dataclasses import dataclass

PAUSE_BREAK_MS = 600.0
MAX_GROUP_WORDS = 32
MAX_GROUP_CHARS = 280

_END_PUNCT = {".", "!", "?", chr(0x2026), chr(0x3002), chr(0xFF01), chr(0xFF1F)}
_CLOSERS = {"\u201c", "\u201d", "\u300c", "\u300d"}
def _is_cjk(ch):
    o = ord(ch)
    return (0x3040 <= o <= 0x30FF or 0x3400 <= o <= 0x4DBF or
            0x4E00 <= o <= 0x9FFF or 0xF900 <= o <= 0xFAFF or
            0xFF00 <= o <= 0xFFEF or 0x20000 <= o <= 0x2EBEF)


def word_count(text):
    """Non-CJK tokens + CJK chars (a CJK token is not also counted as a word)."""
    toks = text.split()
    words = sum(1 for t in toks if not any(_is_cjk(ch) for ch in t))
    return words + sum(1 for ch in text if _is_cjk(ch))


def ends_sentence(text):
    """True if text ends with sentence-final punctuation (+ optional closer)."""
    t = text.rstrip()
    if not t:
        return False
    if t[-1] in _CLOSERS:
        t = t[:-1].rstrip()
        if not t:
            return False
    return t[-1] in _END_PUNCT


@dataclass
class Group:
    start_idx: int
    end_idx: int
    text: str
    start_ms: float
    end_ms: float

def compute_sentence_groups(cues):
    """Group sorted cues into translation units; returns [Group]."""
    groups = []
    n = len(cues)
    if n == 0:
        return groups

    def flush(s, end_idx):
        parts = [cues[k].text for k in range(s, end_idx + 1)]
        groups.append(Group(s, end_idx, " ".join(parts), cues[s].start_ms, cues[end_idx].end_ms))

    s = 0
    words = 0
    chars = 0
    max_pause = -1.0
    max_pause_at = -1
    i = 0
    while i < n:
        c = cues[i]
        is_last = (i == n - 1)
        anchor = c.start_ms if c.last_off_ms is None else max(c.start_ms, c.last_off_ms)
        pause = float("inf") if is_last else cues[i + 1].start_ms - anchor
        words += word_count(c.text)
        chars += len(c.text)
        if is_last or pause > PAUSE_BREAK_MS or ends_sentence(c.text):
            flush(s, i)
            s = i + 1
            words = 0
            chars = 0
            max_pause = -1.0
            max_pause_at = -1
            i += 1
            continue
        if pause > max_pause:
            max_pause = pause
            max_pause_at = i
        nxt = cues[i + 1]
        if words + word_count(nxt.text) > MAX_GROUP_WORDS or chars + len(nxt.text) > MAX_GROUP_CHARS:
            cut = max_pause_at if max_pause_at >= s else i
            flush(s, cut)
            s = cut + 1
            words = 0
            chars = 0
            max_pause = -1.0
            max_pause_at = -1
            i = cut + 1
            continue
        i += 1
    return groups
