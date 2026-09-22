"""Sentence groups from cues: behavior-aligned with the kiss-translator rule branch.

Clean-room rewrite of the segmentation criteria (ADR-006, spec issue #22).
Only cue-level inputs (start/end/text) are used; the alignment target is
observable grouping behavior and constants - the reference implementation is
GPL-3.0, so no code is copied from it.

The translation unit is unchanged: a group is a CONTIGUOUS cue range, the
model must return exactly one line per cue in the group, and translations are
cached per cue. Word offsets (Cue.last_off_ms) never participate in
segmentation; the wire field exists for protocol compatibility only.

Branching (keyed on the track language):
- non-space languages (zh/ja/ko/th/lo/km/my by language prefix): quality gate
  first - when more than half of the lines are longer than 5 characters the
  source is whole-line laid out and each cue stays its own group; otherwise
  30-char accumulation + 1000ms real silence + sentence-final punctuation
  (full-width or half-width, with trailing quotes/brackets allowed).
- space languages: six criteria - real silence > 1000ms (next start minus the
  previous cue's declared end), comma-gated 15-word rule, 10000ms buffer
  span, sentence-final punctuation, sign-started lines break before them, and
  NO overflow fallback (whichever criterion fires is where the cut happens).
  Then one long-sentence second pass: groups whose text exceeds 100 chars are
  re-run over their covered cues with weak-pause semantics (the 15-word rule
  needs no comma; the 46-word English conjunction list is active).

Non-speech cues ([Music] and kin) never join a group in either branch: the
current buffer is flushed when such a cue is reached and the cue itself is
skipped, so neighbours never share a group (forced break, independent of
timing), the non-speech cue keeps a gap between group ranges, and it never
reaches a translation request - the overlay shows its original text only.

Inputs are expected from parse_json3/coerce_cue: text non-empty, collapsed
and trimmed; the engine overlap-repairs cue ends before grouping. All
criteria are constants - not configurable, no settings keys.
"""
import re
from dataclasses import dataclass

# --- space-language branch criteria (reference constants) ---
PAUSE_MS = 1000.0            # real-silence threshold: next.start - prev.end
MAX_WORDS = 15               # comma-gated word rule - deliberately NOT a cap
MAX_DURATION_MS = 10000.0    # buffer span: candidate start - first cue start
LONG_SENTENCE_CHARS = 100    # second-pass threshold (fixed; no settings key)

# --- non-space-language branch criteria (reference constants) ---
NO_SPACE_LANGS = ("zh", "ja", "ko", "th", "lo", "km", "my")
NS_MAX_CHARS = 30            # accumulate-to-here ends the sentence
NS_LONG_LINE_CHARS = 5       # quality gate: line longer than this is "long"
NS_LONG_LINE_RATIO = 0.5     # ...more than this share => whole-line layout

_END_OF_SENTENCE = re.compile(r"[.?!…\])]$")
_PAUSE_OF_SENTENCE = re.compile(r"[,]$")
_STARTS_WITH_SIGN = re.compile(r"^[\[(♪]")
# Sentence end for no-space languages: CJK/half-width sentence-final punct,
# then zero or more trailing quotes/brackets, at the end of the just-added cue.
_NS_END_OF_SENTENCE = re.compile(r"""[。！？.!?…][”’"'」』】）》\]]*$""")
# Whole-line non-speech marker: bracket runs only, optional ">> " speaker
# prefix. Full match, so dialogue that merely starts with a bracket survives.
_NON_SPEECH = re.compile(r"^(?:>>\s*)?(?:\[[^\]\r\n]+\]\s*)+$")

# 46 English logical conjunctions (reference list; English-only by design -
# an inherited limitation, see ADR-006). Active only in the second pass.
_PAUSE_WORDS = frozenset((
    "actually", "also", "although", "and", "anyway", "as", "basically",
    "because", "but", "eventually", "frankly", "honestly", "hopefully",
    "however", "if", "instead", "it's", "just", "let's", "like", "literally",
    "maybe", "meanwhile", "nevertheless", "nonetheless", "now", "okay", "or",
    "otherwise", "perhaps", "personally", "probably", "right", "since", "so",
    "suddenly", "that's", "then", "there's", "therefore", "though", "thus",
    "unless", "until", "well", "while",
))


@dataclass
class Group:
    start_idx: int
    end_idx: int
    text: str
    start_ms: float
    end_ms: float


def _is_non_speech(text):
    return bool(_NON_SPEECH.match(text.strip()))


def _is_no_space_lang(lang):
    return any((lang or "").startswith(p) for p in NO_SPACE_LANGS)


def _run_space_pass(cues, use_pause, indices=None):
    """Space-language state machine; defaults to every cue in order.

    Returns [(start_idx, end_idx)] spans. Each cue is judged before it joins
    the buffer; whichever criterion fires is where the buffer flushes (no
    fallback to any other position). A non-speech cue flushes the buffer and
    is skipped: it joins no group and forces a break on both sides.
    """
    if indices is None:
        indices = range(len(cues))
    groups = []
    buf = []
    words = 0

    def flush():
        nonlocal words
        if buf:
            groups.append((buf[0], buf[-1]))
            del buf[:]
            words = 0

    for i in indices:
        if _is_non_speech(cues[i].text):
            flush()
            continue
        text = cues[i].text
        if buf:
            last = cues[buf[-1]].text
            if (
                _END_OF_SENTENCE.search(last)
                or cues[i].start_ms - cues[buf[-1]].end_ms > PAUSE_MS
                or cues[i].start_ms - cues[buf[0]].start_ms >= MAX_DURATION_MS
                or ((use_pause or _PAUSE_OF_SENTENCE.search(last))
                    and words >= MAX_WORDS)
                or _STARTS_WITH_SIGN.search(text)
                or (use_pause and len(buf) > 1
                    and text.lower().split(" ")[0] in _PAUSE_WORDS)
            ):
                flush()
        buf.append(i)
        words += len(text.split())
    flush()
    return groups


def _second_pass(cues, spans):
    """Re-split groups whose text exceeds LONG_SENTENCE_CHARS (one pass only).

    A group is re-run over the cues it covers (cue start within [group start,
    group end)) with weak-pause semantics; a group covering a single cue is
    kept as-is. Non-speech cues cannot fall inside a group's range (the pass
    flushes at each one), so the covered window stays contiguous.
    """
    out = []
    for s, e in spans:
        text = " ".join(cues[i].text for i in range(s, e + 1))
        if len(text) > LONG_SENTENCE_CHARS:
            covered = [i for i in range(len(cues))
                       if cues[s].start_ms <= cues[i].start_ms < cues[e].end_ms]
            if len(covered) > 1:
                out.extend(_run_space_pass(cues, use_pause=True, indices=covered))
                continue
        out.append((s, e))
    return out


def _run_no_space(cues):
    """Non-space-language merge over every cue.

    Quality gate first: more than half of the SPEECH lines longer than 5
    characters means the source is whole-line laid out - one cue per group,
    nothing merged. Otherwise accumulate cue texts with NO separator: flush
    when the accumulated length reaches 30, when the just-added cue ends with
    sentence-final punctuation (closers allowed), or when the silence since
    the merged line's end exceeds 1000ms. A non-speech cue flushes the
    current line and is skipped - it joins no group.
    """
    speech_texts = [c.text for c in cues if not _is_non_speech(c.text)]
    if (speech_texts and
            sum(1 for t in speech_texts if len(t) > NS_LONG_LINE_CHARS)
            / len(speech_texts) > NS_LONG_LINE_RATIO):
        return [(i, i) for i in range(len(cues))
                if not _is_non_speech(cues[i].text)]

    groups = []
    cur = None  # [start_idx, end_idx, accumulated_chars]
    for i in range(len(cues)):
        if _is_non_speech(cues[i].text):
            if cur is not None:
                groups.append((cur[0], cur[1]))
                cur = None
            continue
        text = cues[i].text
        if cur is not None and cues[i].start_ms - cues[cur[1]].end_ms > PAUSE_MS:
            groups.append((cur[0], cur[1]))
            cur = None
        if cur is None:
            cur = [i, i, len(text)]
        else:
            cur[1] = i
            cur[2] += len(text)
        if _NS_END_OF_SENTENCE.search(text) or cur[2] >= NS_MAX_CHARS:
            groups.append((cur[0], cur[1]))
            cur = None
    if cur is not None:
        groups.append((cur[0], cur[1]))
    return groups


def compute_sentence_groups(cues, lang=""):
    """Group cues into translation units; returns [Group].

    lang is the track language marker; missing/unknown selects the
    space-language branch. Non-speech cues never join a group (flush before,
    skip), so group ranges keep a gap around them and they get no
    translation. Track kind deliberately plays no part here: manual tracks
    promise boundary parity with the reference, ASR tracks share the same
    criteria without that promise - a documentation-level distinction, not a
    branch.
    """
    if not cues:
        return []
    if _is_no_space_lang(lang):
        spans = _run_no_space(cues)
        join = "".join
    else:
        spans = _run_space_pass(cues, use_pause=False)
        spans = _second_pass(cues, spans)
        join = " ".join
    return [
        Group(s, e, join(cues[i].text for i in range(s, e + 1)),
              cues[s].start_ms, cues[e].end_ms)
        for s, e in spans
    ]
