"""Clean-room sentence grouping from the accepted cue-level rules.

Language selects either the no-space quality gate and 30-character pass, or
the space-language silence, duration, comma-word and sign-start rules. Long
space-language groups get one second pass with weak boundaries enabled.
Non-speech bracket cues are omitted in both branches. Group ranges remain
contiguous cue spans so translation and per-cue alignment keep their contract.
"""

from dataclasses import dataclass
import re


@dataclass
class SentenceGroup:
    start_idx: int
    end_idx: int
    start_ms: float
    end_ms: float
    text: str


NO_SPACE_LANGUAGES = ("zh", "ja", "ko", "th", "lo", "km", "my")
NO_SPEECH = re.compile(r"^(?:>>\s*)?(?:\[[^\]\r\n]+\]\s*)+$", re.IGNORECASE)
SIGN_START = re.compile(r"^(?:\[|\(|♪)")
SPACE_SENTENCE_END = re.compile(r"[.?!…\])]$")
NO_SPACE_SENTENCE_END = re.compile(r"[。！？.!?…][”’\"'」』】）》\]]*$")

# English conjunction boundary vocabulary used only by the long-group pass.
WEAK_BOUNDARIES = frozenset((
    "actually", "also", "although", "and", "anyway", "as", "basically",
    "because", "but", "eventually", "frankly", "honestly", "hopefully",
    "however", "if", "instead", "it's", "just", "let's", "like", "literally",
    "maybe", "meanwhile", "nevertheless", "nonetheless", "now", "okay", "or",
    "otherwise", "perhaps", "personally", "probably", "right", "since", "so",
    "suddenly", "that's", "then", "there's", "therefore", "though", "thus",
    "unless", "until", "well", "while",
))


def _is_no_space_language(language):
    code = (language or "").lower()
    return code.startswith(NO_SPACE_LANGUAGES)


def _is_non_speech(text):
    return bool(NO_SPEECH.fullmatch((text or "").strip()))


def _word_count(text):
    return len((text or "").split())


def _starts_with_weak_boundary(text):
    first_word = (text or "").lower().split(" ")[0]
    return first_word in WEAK_BOUNDARIES


def _ends_sentence(text, no_space):
    rule = NO_SPACE_SENTENCE_END if no_space else SPACE_SENTENCE_END
    return bool(rule.search((text or "").rstrip()))


def _group_text(cues, indices, no_space):
    separator = "" if no_space else " "
    return separator.join(cues[index].text.strip() for index in indices).strip()


def _make_group(cues, indices, no_space):
    return SentenceGroup(
        indices[0], indices[-1], cues[indices[0]].start_ms,
        cues[indices[-1]].end_ms, _group_text(cues, indices, no_space)
    )


def _quality_gate(cues):
    speech = [cue for cue in cues if not _is_non_speech(cue.text)]
    if not speech:
        return False
    long_lines = sum(len((cue.text or "").strip()) > 5 for cue in speech)
    return long_lines / len(speech) > 0.5


def _split_groups(cues, candidates, no_space, second_pass=False):
    """Split an ordered run of speech cue indices at observable rule boundaries."""
    groups = []
    current = []

    def flush():
        if current:
            groups.append(list(current))
            current.clear()

    for index in candidates:
        cue = cues[index]
        text = (cue.text or "").strip()
        if not text:
            flush()
            continue
        if _is_non_speech(text):
            flush()
            continue
        if current:
            previous = cues[current[-1]]
            first = cues[current[0]]
            silence = cue.start_ms - previous.end_ms
            duration = cue.start_ms - first.start_ms
            current_text = _group_text(cues, current, no_space)
            current_words = _word_count(current_text)
            starts_new_thought = (second_pass and len(current) > 1
                                  and _starts_with_weak_boundary(text))
            should_split = (
                silence > 1000
                or _ends_sentence(cues[current[-1]].text, no_space)
                or (not no_space and duration >= 10000)
                or (no_space and len(current_text) >= 30)
                or (not no_space and current_words >= 15
                    and cues[current[-1]].text.rstrip().endswith(",")
                    and not second_pass)
                or (second_pass and current_words >= 15)
                or starts_new_thought
            )
            if should_split:
                flush()
        if not no_space and SIGN_START.match(text):
            flush()
        current.append(index)

    flush()
    return groups


def compute_sentence_groups(cues, lang=""):
    """Return stable cue ranges and text without changing the translation unit."""
    if not cues:
        return []
    no_space = _is_no_space_language(lang)

    if no_space and _quality_gate(cues):
        return [SentenceGroup(i, i, cue.start_ms, cue.end_ms, (cue.text or "").strip())
                for i, cue in enumerate(cues) if not _is_non_speech(cue.text)]

    runs = []
    run = []
    for index, cue in enumerate(cues):
        text = (cue.text or "").strip()
        if not text or _is_non_speech(text):
            if run:
                runs.append(run)
                run = []
            continue
        run.append(index)
    if run:
        runs.append(run)

    first_pass = []
    for run in runs:
        first_pass.extend(_split_groups(cues, run, no_space))

    if no_space:
        return [_make_group(cues, indices, True) for indices in first_pass]

    result = []
    for indices in first_pass:
        group = _make_group(cues, indices, False)
        if len(group.text) <= 100 or len(indices) < 2:
            result.append(group)
            continue
        subdivisions = _split_groups(cues, indices, False, second_pass=True)
        result.extend(_make_group(cues, part, False) for part in subdivisions)
    return result
