"""地图 #152 / 实施票 #158 -- 调参页字段护栏表（纯逻辑接缝，无 Qt）。

Spec #161「调参页：字段、校验、保存与生效语义」的接缝 1：范围权威表 +
「只合并改动过的键」的写回逻辑 + 秒/毫秒单位换算。全部直接调用断言，
不构造窗口、不碰 APPDATA。
"""
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from suboverlay import settings as S

# Spec #161 「逐字段范围护栏」表的 15 条路径，顺序即页面顺序。
SPEC_PATHS = [
    ("display", "mode"), ("display", "order"), ("display", "history_lines"),
    ("display", "font_bold"), ("display", "stroke"), ("display", "bg_color"),
    ("display", "bg_opacity"),
    ("provider", "timeout_s"), ("provider", "max_concurrent"), ("server", "port"),
    ("prefetch", "lead_s"), ("prefetch", "max_groups"),
    ("prefetch", "seek_debounce_ms"), ("batch", "max_groups"), ("batch", "max_chars"),
]

# 规格明令不收录：已有入口 / 凭证 / 有隐式 UI。
NOT_TUNABLE = [
    ("provider", "base_url"), ("provider", "api_key"), ("provider", "model"),
    ("provider", "protocol"), ("provider", "mock"),
    ("prompt", "active"), ("prompt", "context_groups"),
    ("display", "font_size"), ("window", "x"), ("window", "y"),
    ("window", "w"), ("window", "h"),
]


def _field(path):
    return S.field_by_path(path)


def test_fields_cover_exactly_the_spec_paths():
    assert [f["path"] for f in S.TUNING_FIELDS] == SPEC_PATHS
    assert S.TUNING_GROUPS == ("display", "network", "experimental")


def test_no_credentials_or_already_exposed_keys_are_tunable():
    for path in NOT_TUNABLE:
        try:
            S.field_by_path(path)
        except KeyError:
            continue
        raise AssertionError("%r must not be tunable: it already has a UI entry "
                             "(or is a credential)" % (path,))


def test_defaults_match_default_settings():
    """每字段的默认值与 default_settings() 一致（seek 字段 UI 秒 vs 存储毫秒）。"""
    cfg = S.default_settings()
    for f in S.TUNING_FIELDS:
        assert S.display_value(f, cfg) == f["default"], f["path"]


def test_clamp_is_boundary_inclusive():
    for f in S.TUNING_FIELDS:
        if f["control"] not in ("int", "float", "slider"):
            continue
        lo, hi = f["min"], f["max"]
        assert S.stored_value(f, lo - 1) == S.stored_value(f, lo), f["path"]
        assert S.stored_value(f, hi + 1) == S.stored_value(f, hi), f["path"]
        mid = (lo + hi) / 2.0
        got = S.stored_value(f, mid)
        assert S.stored_value(f, lo) < got < S.stored_value(f, hi), f["path"]
        if f["control"] in ("int", "slider") or S.is_scaled(f):
            assert isinstance(got, int), f["path"]
        else:
            assert isinstance(got, float), f["path"]


def test_choice_field_rejects_unknown_value():
    mode = _field(("display", "mode"))
    assert S.stored_value(mode, "nonsense") == "bilingual"
    assert S.display_value(mode, {"display": {"mode": "nonsense"}}) == "bilingual"
    assert [S.display_value(mode, {"display": {"mode": c}}) for c in mode["choices"]] == \
        list(mode["choices"])


def test_color_field_clamps_each_channel_and_rejects_wrong_length():
    color = _field(("display", "bg_color"))
    assert S.stored_value(color, [0, 300, -5]) == [0, 255, 0]
    assert S.stored_value(color, [0, 0]) == [0, 0, 0]
    assert S.stored_value(color, "nope") == [0, 0, 0]
    assert S.display_value(color, {"display": {"bg_color": [10, 20]}}) == [0, 0, 0]
    assert S.display_value(color, {"display": {"bg_color": [10, 20, 300]}}) == [10, 20, 255]


def test_seek_seconds_milliseconds_round_trip():
    seek = _field(("prefetch", "seek_debounce_ms"))
    assert S.is_scaled(seek) is True
    assert S.stored_value(seek, 0.4) == 400
    assert S.stored_value(seek, 0.5) == 500
    assert S.stored_value(seek, 5.0) == 5000
    assert S.stored_value(seek, 9999) == 5000
    assert S.display_value(seek, {"prefetch": {"seek_debounce_ms": 400}}) == 0.4
    assert S.display_value(seek, {"prefetch": {"seek_debounce_ms": 9999}}) == 5.0
    assert S.display_value(seek, {"prefetch": {}}) == 0.4
    for ui in (0.0, 0.4, 1.0, 2.5, 5.0):
        assert S.display_value(seek, {"prefetch": {"seek_debounce_ms": S.stored_value(seek, ui)}}) == ui


def test_display_value_falls_back_to_default_for_unusable_values():
    timeout = _field(("provider", "timeout_s"))
    assert S.display_value(timeout, {"provider": {"timeout_s": "abc"}}) == 60.0
    assert S.display_value(timeout, {"provider": {"timeout_s": True}}) == 60.0
    assert S.display_value(timeout, {"provider": {"timeout_s": None}}) == 60.0
    assert S.display_value(timeout, {}) == 60.0
    assert S.display_value(timeout, {"provider": "broken"}) == 60.0
    assert S.display_value(timeout, {"provider": {"timeout_s": 9999}}) == 600.0
    assert S.display_value(timeout, {"provider": {"timeout_s": 30}}) == 30.0


def test_collect_edits_only_returns_changed_keys():
    cfg = S.default_settings()
    initial = S.tuning_ui_state(cfg)
    assert S.collect_edits(initial, initial) == []
    ui = dict(initial)
    ui[("display", "history_lines")] = 5
    assert S.collect_edits(ui, initial) == [(("display", "history_lines"), 5)]


def test_apply_edits_clamps_and_preserves_untouched_keys():
    cfg = S.default_settings()
    cfg["display"]["font_size"] = 99            # 用户手写在文件里的越界值
    cfg["prefetch"]["draft_note"] = "keep me"   # 用户手写的未知键
    applied = S.apply_edits(cfg, [(("prefetch", "lead_s"), 30.0)])
    assert applied == [("prefetch", "lead_s")]
    assert cfg["prefetch"]["lead_s"] == 30.0
    assert cfg["display"]["font_size"] == 99
    assert cfg["prefetch"]["draft_note"] == "keep me"
    assert S.apply_edits(cfg, [(("batch", "max_chars"), 10 ** 9)]) == [("batch", "max_chars")]
    assert cfg["batch"]["max_chars"] == 64000
    try:
        S.apply_edits(cfg, [(("provider", "api_key"), "sk-nope")])
    except KeyError:
        pass
    else:
        raise AssertionError("apply_edits must refuse keys outside the tuning table")
    assert cfg["provider"]["api_key"] == ""


def test_restart_and_uncalibrated_flags_match_the_spec():
    restart = {f["path"] for f in S.TUNING_FIELDS if f["restart"]}
    assert restart == {("provider", "max_concurrent"), ("server", "port")}
    uncalibrated = {f["path"] for f in S.TUNING_FIELDS if f["uncalibrated"]}
    assert uncalibrated == {("prefetch", "lead_s"), ("prefetch", "max_groups"),
                            ("prefetch", "seek_debounce_ms"), ("batch", "max_groups"),
                            ("batch", "max_chars")}
    notify = {f["path"] for f in S.TUNING_FIELDS if f["notify_overlay"]}
    assert notify == {("display", "mode"), ("display", "order")}
    groups = {f["group"] for f in S.TUNING_FIELDS}
    assert groups == set(S.TUNING_GROUPS)


def test_every_field_carries_a_label_and_hint_slot():
    for f in S.TUNING_FIELDS:
        assert isinstance(f["label"], str) and f["label"].strip(), f["path"]
        assert isinstance(f["hint"], str), f["path"]
    assert _field(("provider", "max_concurrent"))["hint"] == "重启后生效"
    assert _field(("server", "port"))["hint"] == "重启后生效"
    assert _field(("display", "stroke"))["hint"] == "0 = 不描边"
    for f in S.TUNING_FIELDS:
        if f["uncalibrated"]:
            assert f["group"] == "experimental", f["path"]
