// Port of desktop/suboverlay/sentences.py - clean-room sentence grouping from
// the accepted cue-level rules (ADR-006 + the #149 continuation exemption).
// Language selects either the no-space quality gate and 30-character pass, or
// the space-language silence, duration, comma-word and sign-start rules. Long
// space-language groups get one second pass with weak boundaries enabled.
// A space-language continuation cue (lowercase, non-weak-boundary start after
// a >=2-cue non-terminal buffer) suppresses the silence, duration and
// 15-word splits at that boundary; punctuation, sign, non-speech and the
// weak-boundary list are never suppressed. Non-speech bracket cues are
// omitted in both branches. Group ranges remain contiguous cue spans so
// translation and per-cue alignment keep their contract. Keeps the same
// public names as the Python module so the remaining Phase 1 tickets map
// one-to-one onto it.
//
// Semantic fidelity notes (registered in ticket #200):
// - re.fullmatch(NO_SPEECH, ...) -> anchored JS RegExp .test() on the trimmed
//   text: the input is stripped first and the pattern is total-match by
//   ^...$ with no multiline flag, so the two agree on this domain.
// - Python str.split() (whitespace runs, no empty items) -> trim() then
//   split(/\s+/), with the empty string returning 0 words.
// - "a" <= text[0] <= "z" single-char compare -> the same UTF-16 compare
//   (both sides compare by code point on this ASCII range).
// - str.startswith(tuple) -> some(p => code.startsWith(p)).
// - str.rstrip() -> trimEnd() (same trailing-whitespace intent on this
//   domain).
import type { Cue } from "./protocol.ts";

export interface SentenceGroup {
  start_idx: number;
  end_idx: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

const NO_SPACE_LANGUAGES = ["zh", "ja", "ko", "th", "lo", "km", "my"] as const;

const NO_SPEECH = /^(?:>>\s*)?(?:\[[^\]\r\n]+\]\s*)+$/i;
const SIGN_START = /^(?:\[|\(|♪)/;
const SPACE_SENTENCE_END = /[.?!…\])]$/;
const NO_SPACE_SENTENCE_END = /[。！？.!?…]["”’'」』】）》\]]*$/;

// English conjunction boundary vocabulary used only by the long-group pass.
const WEAK_BOUNDARIES: ReadonlySet<string> = new Set([
  "actually", "also", "although", "and", "anyway", "as", "basically",
  "because", "but", "eventually", "frankly", "honestly", "hopefully",
  "however", "if", "instead", "it's", "just", "let's", "like", "literally",
  "maybe", "meanwhile", "nevertheless", "nonetheless", "now", "okay", "or",
  "otherwise", "perhaps", "personally", "probably", "right", "since", "so",
  "suddenly", "that's", "then", "there's", "therefore", "though", "thus",
  "unless", "until", "well", "while",
]);

function is_no_space_language(language: string | null | undefined): boolean {
  const code = (language ?? "").toLowerCase();
  return NO_SPACE_LANGUAGES.some((p) => code.startsWith(p));
}

function is_non_speech(text: string | null | undefined): boolean {
  return NO_SPEECH.test((text ?? "").trim());
}

function word_count(text: string | null | undefined): number {
  const t = (text ?? "").trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

function starts_with_weak_boundary(text: string | null | undefined): boolean {
  const first_word = (text ?? "").toLowerCase().split(" ")[0] ?? "";
  return WEAK_BOUNDARIES.has(first_word);
}

function ends_sentence(text: string | null | undefined, no_space: boolean): boolean {
  const t = (text ?? "").trimEnd();
  return no_space ? NO_SPACE_SENTENCE_END.test(t) : SPACE_SENTENCE_END.test(t);
}

function group_text(cues: readonly Cue[], indices: readonly number[],
                    no_space: boolean): string {
  const separator = no_space ? "" : " ";
  return indices
    .map((index) => (cues[index]?.text ?? "").trim())
    .join(separator)
    .trim();
}

function make_group(cues: readonly Cue[], indices: readonly number[],
                    no_space: boolean): SentenceGroup {
  const first = indices[0]!;
  const last = indices[indices.length - 1]!;
  return {
    start_idx: first,
    end_idx: last,
    start_ms: cues[first]!.start_ms,
    end_ms: cues[last]!.end_ms,
    text: group_text(cues, indices, no_space),
  };
}

function quality_gate(cues: readonly Cue[]): boolean {
  const speech = cues.filter((cue) => !is_non_speech(cue.text));
  if (speech.length === 0) return false;
  const long_lines = speech.filter((cue) => (cue.text ?? "").trim().length > 5).length;
  return long_lines / speech.length > 0.5;
}

// Split an ordered run of speech cue indices at observable rule boundaries.
function split_groups(cues: readonly Cue[], candidates: readonly number[],
                      no_space: boolean, second_pass = false): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      groups.push(current);
      current = [];
    }
  };

  for (const index of candidates) {
    const cue = cues[index]!;
    const text = (cue.text ?? "").trim();
    if (!text) {
      flush();
      continue;
    }
    if (is_non_speech(text)) {
      flush();
      continue;
    }
    if (current.length > 0) {
      const previous = cues[current[current.length - 1]!]!;
      const first = cues[current[0]!]!;
      const silence = cue.start_ms - previous.end_ms;
      const duration = cue.start_ms - first.start_ms;
      const current_text = group_text(cues, current, no_space);
      const current_words = word_count(current_text);
      const starts_new_thought = second_pass && current.length > 1
        && starts_with_weak_boundary(text);
      const continuation = !no_space
        && current.length >= 2
        && !ends_sentence(cues[current[current.length - 1]!]!.text, no_space)
        && text[0]! >= "a" && text[0]! <= "z"
        && !starts_with_weak_boundary(text);
      const should_split =
        (silence > 1000 && !continuation)
        || ends_sentence(cues[current[current.length - 1]!]!.text, no_space)
        || (!no_space && duration >= 10000 && !continuation)
        || (no_space && current_text.length >= 30)
        || (!no_space && current_words >= 15
            && cues[current[current.length - 1]!]!.text.trimEnd().endsWith(",")
            && !second_pass && !continuation)
        || (second_pass && current_words >= 15 && !continuation)
        || starts_new_thought;
      if (should_split) flush();
    }
    if (!no_space && SIGN_START.test(text)) flush();
    current.push(index);
  }

  flush();
  return groups;
}

// Return stable cue ranges and text without changing the translation unit.
export function compute_sentence_groups(cues: readonly Cue[],
                                        lang: string | null = ""): SentenceGroup[] {
  if (cues.length === 0) return [];
  const no_space = is_no_space_language(lang);

  if (no_space && quality_gate(cues)) {
    const groups: SentenceGroup[] = [];
    cues.forEach((cue, i) => {
      if (!is_non_speech(cue.text)) {
        groups.push({
          start_idx: i, end_idx: i,
          start_ms: cue.start_ms, end_ms: cue.end_ms,
          text: (cue.text ?? "").trim(),
        });
      }
    });
    return groups;
  }

  const runs: number[][] = [];
  let run: number[] = [];
  cues.forEach((cue, index) => {
    const text = (cue.text ?? "").trim();
    if (!text || is_non_speech(text)) {
      if (run.length > 0) {
        runs.push(run);
        run = [];
      }
      return;
    }
    run.push(index);
  });
  if (run.length > 0) runs.push(run);

  const first_pass: number[][] = [];
  for (const r of runs) first_pass.push(...split_groups(cues, r, no_space));

  if (no_space) {
    return first_pass.map((indices) => make_group(cues, indices, true));
  }

  const result: SentenceGroup[] = [];
  for (const indices of first_pass) {
    const group = make_group(cues, indices, false);
    if (group.text.length <= 100 || indices.length < 2) {
      result.push(group);
      continue;
    }
    const subdivisions = split_groups(cues, indices, false, true);
    for (const part of subdivisions) result.push(make_group(cues, part, false));
  }
  return result;
}
