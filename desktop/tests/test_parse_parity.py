"""Cross-language parity for cue decoding.

The browser userscript (userscript/youtubesub.user.js :: parseJson3) and the
desktop parser (suboverlay.protocol.parse_json3) must agree exactly, otherwise
the overlay renders cues at different times than the page. Both sides assert the
SAME fixture file; userscript/tests/userscript.test.mjs holds the JS half.
"""
import json
import os

import pytest

from suboverlay.protocol import parse_json3

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURE_PATH = os.path.join(ROOT, "userscript", "tests", "fixtures", "parse_cases.json")

with open(FIXTURE_PATH, "r", encoding="utf-8") as fh:
    CASES = json.load(fh)


def _norm_cues(cues):
    return [(round(float(c.start_ms), 3), round(float(c.end_ms), 3),
             c.text, round(float(c.last_off_ms), 3)) for c in cues]


def _norm_expected(items):
    return [(round(float(e["start_ms"]), 3), round(float(e["end_ms"]), 3),
             e["text"], round(float(e["last_off_ms"]), 3)) for e in items]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_parse_json3_matches_shared_fixture(case):
    assert _norm_cues(parse_json3(case["json3"])) == _norm_expected(case["expected"])


def test_shared_fixture_is_not_trivially_empty():
    assert len(CASES) >= 8
    assert any(c["expected"] for c in CASES)
    assert any(not c["expected"] for c in CASES)
