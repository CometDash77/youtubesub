// 1:1 port of desktop/tests/test_sentences.py (ticket #200, map #181).
// Table-driven tests: cue sequences -> exact group spans and texts. Every
// pytest test function / parametrize row maps to exactly one test() below;
// assertions are converted assertion-for-assertion (equivalence criteria #1,
// #191). Registered behavior conversions (criteria #2):
//   - pytest.parametrize                -> for loop generating test()
//   - dataclass Cue(...) with __post_init__ default
//                                       -> protocol.make_cue(...)
// Each row pins observable grouping behavior only (input cues + track
// language => group boundaries and group texts), per spec issue #22's
// Testing Decisions: no internal function names, no constants' storage
// locations. The rows cover the mandated regression list - real-silence
// basis, 1000ms boundary, comma-gated word rule, 10s duration, sign-forced
// breaks, non-speech exclusion, quality gate on/off/boundary, 30-char cap,
// second pass on/off and threshold boundary, mixed-language branch dispatch -
// and the old "merge rolling windows via in-line word offsets" case is
// rewritten under the new basis (its expectation changed with the criterion,
// not from a regression).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../lib/sentences.ts";
import { make_cue, type Cue } from "../lib/protocol.ts";

const mk = (start: number, end: number, text: string,
            last_off?: number): Cue =>
  make_cue(start, end, text, last_off === undefined ? start : last_off);

type Span = [number, number];
const spans = (groups: S.SentenceGroup[]): Span[] =>
  groups.map((g) => [g.start_idx, g.end_idx]);
const texts = (groups: S.SentenceGroup[]): string[] => groups.map((g) => g.text);

const F15 = "one two three four five six seven eight nine ten eleven twelve " +
            "thirteen fourteen fifteen,";
const F14 = "one two three four five six seven eight nine ten eleven twelve " +
            "thirteen fourteen,";
const W34 = "a b c d e f g h i j k l m n o p q r s t u v w x y z " +
            "a1 a2 a3 a4 a5 a6 a7 a8";
const T10 = "aa bb cc dd ee ff gg hh ii jj";
const T10U = "Aa bb cc dd ee ff gg hh ii jj";
const HUGE = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do " +
             "eiusmod tempor incididunt ut labore et dolore magna aliqua";
const LONG_ZH = "这是一条非常非常长的字幕行用来把累计字符推过一百的阈值顺便展示" +
                "无空格分支并不参与二次切分处理流程到底会不会被错误地重新切开呢" +
                "我们拭目以待进行确认再加四个字";

type Row = [string, Cue[], string | null, Span[], string[]];

const CASES: Row[] = [
  // --- real-silence basis (the old word-offset anchor is gone) ---
  ["real silence uses declared ends, not word offsets",
   [mk(0, 2500, "the cat sat very", 700),
    mk(2600, 5000, "quietly on the mat", 900)],
   "", [[0, 1]], ["the cat sat very quietly on the mat"]],
  ["asr rolling windows split where real silence exceeds 1000ms " +
   "(rewritten from the word-offset case)",
   [mk(0, 3000, "the cat", 800),
    mk(1000, 4000, "the cat sat", 1800),
    mk(2000, 5000, "the cat sat down", 2600),
    mk(6200, 8000, "Next thought here", 6200)],
   "", [[0, 2], [3, 3]],
   ["the cat the cat sat the cat sat down", "Next thought here"]],
  ["silence of exactly 1000ms does not split",
   [mk(0, 1000, "hello there"), mk(2000, 3000, "my friend")],
   "", [[0, 1]], ["hello there my friend"]],
  ["silence of 1001ms splits",
   [mk(0, 1000, "hello there"), mk(2001, 3000, "my friend")],
   "", [[0, 0], [1, 1]], ["hello there", "my friend"]],
  // --- sentence-final punctuation (space branch) ---
  ["sentence-final period flushes before the next cue",
   [mk(0, 1000, "first part"), mk(1100, 2100, "ends now."),
    mk(2300, 3300, "after")],
   "", [[0, 1], [2, 2]], ["first part ends now.", "after"]],
  ["trailing quote after a period does not end a sentence " +
   "(reference space-branch rule)",
   [mk(0, 1000, 'He said "go."'), mk(1100, 2100, "she agreed")],
   "", [[0, 1]], ['He said "go." she agreed']],
  ["closing parenthesis ends a sentence",
   [mk(0, 1000, "done (really)"), mk(1100, 2100, "next one")],
   "", [[0, 0], [1, 1]], ["done (really)", "next one"]],
  // --- comma-gated 15-word rule (deliberately not a cap) ---
  ["15 words ending in a comma splits before the next cue",
   [mk(0, 2000, F15), mk(2100, 3000, "next line here")],
   "", [[0, 0], [1, 1]], [F15, "next line here"]],
  ["14 words ending in a comma does not split",
   [mk(0, 2000, F14), mk(2100, 3000, "next line here")],
   "", [[0, 1]], [F14 + " next line here"]],
  ["word count alone never splits: 34 words without a comma stay together " +
   "(group stays under the second-pass threshold)",
   [mk(0, 2000, W34), mk(2100, 3000, "tail line")],
   "", [[0, 1]], [W34 + " tail line"]],
  // --- 10s duration ---
  ["10000ms buffer span splits even when the silence is short",
   [mk(0, 9500, "a long speech continues here"),
    mk(10000, 11000, "and on it goes")],
   "", [[0, 0], [1, 1]],
   ["a long speech continues here", "and on it goes"]],
  ["buffer span below 10000ms does not split",
   [mk(0, 8999, "a long speech continues here"),
    mk(9999, 11000, "and on it goes")],
   "", [[0, 1]],
   ["a long speech continues here and on it goes"]],
  // --- sign-started lines break before them ---
  ["bracket-started cue forces a break before it and is NOT non-speech",
   [mk(0, 1000, "he walked in"),
    mk(1100, 2100, "[music playing] loud"),
    mk(2200, 3200, "she continued")],
   "", [[0, 0], [1, 2]],
   ["he walked in", "[music playing] loud she continued"]],
  ["paren-started cue forces a break before it",
   [mk(0, 1000, "he walked in"),
    mk(1100, 2100, "(sighs) loudly"),
    mk(2200, 3200, "she continued")],
   "", [[0, 0], [1, 2]],
   ["he walked in", "(sighs) loudly she continued"]],
  ["note-started cue forces a break before it",
   [mk(0, 1000, "he walked in"),
    mk(1100, 2100, "♪ la la"),
    mk(2200, 3200, "she continued")],
   "", [[0, 0], [1, 2]],
   ["he walked in", "♪ la la she continued"]],
  // --- non-speech exclusion (forced break independent of timing) ---
  ["non-speech cue joins no group and forces breaks across a short gap",
   [mk(0, 1000, "spoken one"),
    mk(1100, 1300, "[Music]"),
    mk(1400, 2400, "spoken two")],
   "", [[0, 0], [2, 2]], ["spoken one", "spoken two"]],
  ["speaker-marked non-speech also joins no group",
   [mk(0, 1000, "spoken one"),
    mk(1100, 1300, ">> [John]"),
    mk(1400, 2400, "spoken two")],
   "", [[0, 0], [2, 2]], ["spoken one", "spoken two"]],
  ["non-speech in the non-space branch also forces breaks",
   [mk(0, 1000, "你好世界"),
    mk(1100, 1300, "[Music]"),
    mk(1400, 2400, "天气真好")],
   "zh", [[0, 0], [2, 2]], ["你好世界", "天气真好"]],
  // --- quality gate (non-space branch) ---
  ["gate on: every line longer than 5 chars => one cue per group",
   [mk(0, 1000, "这是一行比较长的字幕"),
    mk(1100, 2100, "另一行同样很长的字"),
    mk(2200, 3200, "第三行也相当的长啊")],
   "zh", [[0, 0], [1, 1], [2, 2]],
   ["这是一行比较长的字幕", "另一行同样很长的字", "第三行也相当的长啊"]],
  ["gate off: short lines merge with no separator",
   [mk(0, 1000, "你好世界"),
    mk(1100, 2100, "天气真好"),
    mk(2200, 3200, "大家早安")],
   "zh", [[0, 2]], ["你好世界天气真好大家早安"]],
  ["gate boundary: exactly 50% long lines keeps merging",
   [mk(0, 1000, "长长长长长长"),
    mk(1100, 2100, "短的短的"),
    mk(2200, 3200, "又长又长又长"),
    mk(3300, 4300, "短的短的")],
   "zh", [[0, 3]],
   ["长长长长长长短的短的又长又长又长短的短的"]],
  // --- 30-char accumulation (non-space branch) ---
  ["30-char accumulation ends the sentence at 30",
   ["春夏秋冬", "风雨雷电", "山川湖海", "花草树木", "日月星辰",
    "金木水火", "东南西北", "钟鼓楼台", "笔墨纸砚", "琴棋书画"].map(
     (t, i) => mk(i * 1100, i * 1100 + 1000, t)),
   "zh", [[0, 7], [8, 9]],
   ["春夏秋冬风雨雷电山川湖海花草树木日月星辰金木水火东南西北钟鼓楼台",
    "笔墨纸砚琴棋书画"]],
  ["sentence-final punct with trailing quote ends immediately even " +
   "under 30 chars",
   [mk(0, 1000, '他说"好吧。"'), mk(1100, 2100, "继续往下")],
   "zh", [[0, 0], [1, 1]], ['他说"好吧。"', "继续往下"]],
  ["non-space silence: exactly 1000ms merges",
   [mk(0, 1000, "一二三四"), mk(2000, 3000, "五六七八")],
   "zh", [[0, 1]], ["一二三四五六七八"]],
  ["non-space silence: 2000ms splits",
   [mk(0, 1000, "一二三四"), mk(3000, 4000, "五六七八")],
   "zh", [[0, 0], [1, 1]], ["一二三四", "五六七八"]],
  // --- mixed-language dispatch (the inherited misclassification, pinned) ---
  ["mixed track on a no-space lang: words treated as a character stream",
   [mk(0, 1000, "OK!"),
    mk(1100, 2100, "好嘞"),
    mk(2200, 3200, "Hello my friend"),
    mk(3300, 4300, "走吧")],
   "zh-Hans", [[0, 0], [1, 3]], ["OK!", "好嘞Hello my friend走吧"]],
  ["the same cues on a space lang break alike but join with spaces",
   [mk(0, 1000, "OK!"),
    mk(1100, 2100, "好嘞"),
    mk(2200, 3200, "Hello my friend"),
    mk(3300, 4300, "走吧")],
   "en", [[0, 0], [1, 3]], ["OK!", "好嘞 Hello my friend 走吧"]],
  // --- second pass (space branch only) ---
  ["second pass 15-word split fires when the next cue starts a new " +
   "sentence (uppercase)",
   [T10, T10, T10U, T10].map((t, i) => mk(i * 1100, i * 1100 + 1000, t)),
   "", [[0, 1], [2, 3]], [T10 + " " + T10, T10U + " " + T10]],
  ["second pass: the conjunction list fires once the buffer has " +
   "more than one cue",
   [mk(0, 1000, "wordwordwordwordword wordwordwordwordword"),
    mk(1100, 2100, "wordwordwordwordword wordwordwordwordword"),
    mk(2200, 3200, "and none of this matters here")],
   "", [[0, 1], [2, 2]],
   ["wordwordwordwordword wordwordwordwordword " +
    "wordwordwordwordword wordwordwordwordword",
    "and none of this matters here"]],
  ["second pass threshold is exclusive: an exactly-100-char group " +
   "is not re-split",
   [T10, T10, T10, "kk ll mm n"].map((t, i) => mk(i * 1100, i * 1100 + 1000, t)),
   "", [[0, 3]], [T10 + " " + T10 + " " + T10 + " kk ll mm n"]],
  ["second pass keeps a group covering a single cue intact",
   [mk(0, 3000, HUGE)],
   "", [[0, 0]], [HUGE]],
  ["no-space branch never runs the second pass " +
   "(canary: ')' inside a >100 char group stays put)",
   ["春夏秋冬", "风雨雷电", "山川湖海", "如此而已)", "花草树木",
    "日月星辰", "金木水火", LONG_ZH].map(
     (t, i) => mk(i * 1100, i * 1100 + 1000, t)),
   "zh", [[0, 7]],
   ["春夏秋冬风雨雷电山川湖海如此而已)花草树木日月星辰金木水火" + LONG_ZH]],
  // --- continuation exemption (#149 / #151: sentence tail survives) ---
  ["lowercase continuation absorbs a >1000ms silence gap",
   [mk(0, 3000, "the cat"), mk(1000, 4000, "the cat sat"),
    mk(2000, 5000, "the cat sat down"), mk(6200, 8000, "next thought here")],
   "", [[0, 3]],
   ["the cat the cat sat the cat sat down next thought here"]],
  ["8:48 sample shape: sentence tail 'among many' survives a silence gap " +
   "(#149 fixture)",
   [mk(0, 3000, "That is reason number two. Google's compute"),
    mk(3100, 7000, "went to Google's customers and Gemini"),
    mk(7100, 9000, "became one internal customer"),
    mk(10100, 13000, "among many. The third reason is the")],
   "", [[0, 3]],
   ["That is reason number two. Google's compute went to Google's " +
    "customers and Gemini became one internal customer among many. " +
    "The third reason is the"]],
  ["10s duration split is absorbed by a lowercase continuation",
   [mk(0, 4000, "a long speech keeps going"),
    mk(4100, 9000, "for a while longer"),
    mk(14100, 15000, "lowercase tail words")],
   "", [[0, 2]],
   ["a long speech keeps going for a while longer lowercase tail words"]],
  ["second pass 15-word split is exempted for an all-lowercase continuation",
   [T10, T10, T10, T10].map((t, i) => mk(i * 1100, i * 1100 + 1000, t)),
   "", [[0, 3]], [T10 + " " + T10 + " " + T10 + " " + T10]],
  ["15-word mechanical split still fires on a single-cue buffer",
   [mk(0, 3000, HUGE), mk(3100, 4100, "lowercase tail words")],
   "", [[0, 0], [1, 1]], [HUGE, "lowercase tail words"]],
];

for (const [name, cues, lang, want_spans, want_texts] of CASES) {
  test("grouping table: " + name, () => {
    const gs = S.compute_sentence_groups(cues, lang);
    assert.deepEqual(spans(gs), want_spans);
    assert.deepEqual(texts(gs), want_texts);
  });
}

test("empty input yields no groups", () => {
  assert.deepEqual(S.compute_sentence_groups([]), []);
});

// --- branch dispatch: same cues, the join separator names the branch ---

const GLUE_CUES = [mk(0, 1000, "你好世界"), mk(1100, 2100, "天气真好"),
                   mk(2200, 3200, "大家早安")];
const GLUED = "你好世界天气真好大家早安";
const SPACED = "你好世界 天气真好 大家早安";

for (const lang of ["zh", "ja", "ko", "th", "lo", "km", "my",
                    "zh-Hans", "ja-JP", "ko-KR"]) {
  test("no-space prefix dispatch: " + lang, () => {
    const gs = S.compute_sentence_groups(GLUE_CUES, lang);
    assert.deepEqual(spans(gs), [[0, 2]]);
    assert.deepEqual(texts(gs), [GLUED]);
  });
}

for (const lang of ["", null, "en", "fr", "pt-BR"]) {
  test("space branch dispatch: lang=" + String(lang), () => {
    const gs = S.compute_sentence_groups(GLUE_CUES, lang);
    assert.deepEqual(spans(gs), [[0, 2]]);
    assert.deepEqual(texts(gs), [SPACED]);
  });
}
