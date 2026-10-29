#!/usr/bin/env python3
"""pick_pending / parse_events 的用例：通知端只投递、不判定。跑法：python3 -I test-auto-relogin-notify.py"""
import importlib.util
import json
import os
import pathlib
import unittest

# 文件名带连字符，不能直接 import；按路径加载，避免改生产文件名。
_spec = importlib.util.spec_from_file_location(
    'auto_relogin_notify', pathlib.Path(__file__).with_name('auto-relogin-notify.py'))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
parse_events, pick_pending, text_for = _mod.parse_events, _mod.pick_pending, _mod.text_for


def ev(rid, result, at=1000, notify=True, typ='result'):
    return {'id': rid, 'type': typ, 'result': result, 'at': at, 'notify': notify}


class ParseEvents(unittest.TestCase):
    def test_skips_half_and_bad_lines(self):
        text = '{"id":"1-aa","type":"result","result":"recovered","at":1,"notify":true}\n{bad\n\n[nope]\n'
        got = parse_events(text)
        self.assertEqual([e['id'] for e in got], ['1-aa'])

    def test_requires_id_and_int_at(self):
        text = '{"type":"result","result":"recovered","at":1}\n{"id":"x","at":"1"}\n'
        self.assertEqual(parse_events(text), [])

    def test_empty_input(self):
        self.assertEqual(parse_events(''), [])
        self.assertEqual(parse_events(None), [])


class PickPending(unittest.TestCase):
    def test_only_notify_true_result_events(self):
        events = [ev('a', 'recovered'), ev('b', 'needs_scan', notify=False), {'id': 'c', 'type': 'send_timeout', 'at': 3},
                  ev('d', 'unknown_result')]
        self.assertEqual(pick_pending(events)['id'], 'a')

    def test_dedupes_by_id_not_timestamp(self):
        events = [ev('a', 'needs_scan', at=5), ev('b', 'recycled', at=5)]
        self.assertEqual(pick_pending(events, 'a')['id'], 'b')

    def test_nothing_new_returns_none(self):
        events = [ev('a', 'recovered')]
        self.assertIsNone(pick_pending(events, 'a'))

    def test_returns_latest_pending(self):
        events = [ev('a', 'needs_scan', at=1), ev('b', 'recovered', at=2)]
        self.assertEqual(pick_pending(events)['id'], 'b')

    def test_empty(self):
        self.assertIsNone(pick_pending([], None))

    def test_noop_and_skipped_are_never_delivered(self):
        events = [ev('a', 'noop'), ev('b', 'skipped')]
        self.assertIsNone(pick_pending(events))

    def test_newest_pending_wins(self):
        events = [ev('a', 'recovered', 1000), ev('b', 'needs_scan', 2000)]
        self.assertEqual(pick_pending(events, None, None, 2000)['id'], 'b')

    def test_already_delivered_never_falls_back_to_older_event(self):
        # 回归：最新一条已投递后，旧实现会回退到更早一条并重复发送。
        events = [ev('a', 'recovered', 1000), ev('b', 'needs_scan', 2000)]
        self.assertIsNone(pick_pending(events, 'b', 2000, 2000))

    def test_older_than_watermark_is_skipped(self):
        events = [ev('a', 'recovered', 1000), ev('c', 'recycled', 3000)]
        self.assertEqual(pick_pending(events, 'b', 2000, 3000)['id'], 'c')

    def test_stale_events_are_dropped(self):
        events = [ev('a', 'needs_scan', 1000)]
        self.assertIsNone(pick_pending(events, None, None, 1000 + 31*60*1000))
        self.assertEqual(pick_pending(events, None, None, 1000 + 29*60*1000)['id'], 'a')


class TextFor(unittest.TestCase):
    def test_reason_beats_result_text(self):
        a = text_for({'result': 'needs_scan', 'reason': 'bridge_not_active'})
        b = text_for({'result': 'needs_scan', 'reason': 'login_failed'})
        self.assertNotEqual(a, b)
        self.assertIn('桥接', a)
        self.assertIn('扫码', b)

    def test_all_reasons_have_distinct_text(self):
        reasons = ['login_failed', 'login_unconfirmed', 'recycle_login_failed',
                   'bridge_not_active', 'bridge_restart_failed']
        texts = {text_for({'result': 'needs_scan', 'reason': r}) for r in reasons}
        self.assertEqual(len(texts), len(reasons))
        self.assertTrue(all(texts))

    def test_unknown_or_missing_reason_falls_back(self):
        self.assertEqual(text_for({'result': 'needs_scan'}), '小鱿鱿自动登录失败，需要你扫码')
        self.assertEqual(text_for({'result': 'recovered', 'reason': 'whatever'}), '小鱿鱿掉线后已自动登录并恢复')

    def test_unknown_result_returns_none(self):
        self.assertIsNone(text_for({'result': 'noop'}))

    def test_version_changed_has_its_own_text(self):
        text = text_for({'result': 'needs_scan', 'reason': 'version_changed'})
        self.assertIn('指纹', text)


class IncidentActive(unittest.TestCase):
    """合并通知链：监控有事故在途时，事件通知器必须闭嘴。"""

    def _write(self, tmp, value):
        p = pathlib.Path(tmp) / 'monitor.json'
        p.write_text(value if isinstance(value, str) else json.dumps(value))
        return p

    def test_offline_incident_suppresses(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            p = self._write(t, {'status': 'offline', 'checkedAt': 1000})
            self.assertTrue(_mod.incident_active(1000, p))

    def test_online_does_not_suppress(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            p = self._write(t, {'status': 'online', 'checkedAt': 1000})
            self.assertFalse(_mod.incident_active(1000, p))

    def test_stale_heartbeat_does_not_suppress(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            p = self._write(t, {'status': 'offline', 'checkedAt': 1000})
            self.assertFalse(_mod.incident_active(1000 + 11 * 60 * 1000, p))

    def test_missing_or_broken_file_does_not_suppress(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            self.assertFalse(_mod.incident_active(1000, pathlib.Path(t) / 'nope.json'))
            p = self._write(t, '{bad')
            self.assertFalse(_mod.incident_active(1000, p))


class MainSuppression(unittest.TestCase):
    """main() 的集成路径：监控有事故在途 → 不发消息、但水位线要推进。"""

    def _run(self, t, monitor_status, events):
        import tempfile
        root = pathlib.Path(t)
        (root / 'monitor.json').write_text(json.dumps({'status': monitor_status,
                                                       'checkedAt': int(__import__('time').time()*1000)}))
        sent = []
        saved = (_mod.MONITOR, _mod.MARK, _mod.remote_events, _mod.send)
        _mod.MONITOR = root / 'monitor.json'
        _mod.MARK = root / 'mark.json'
        _mod.remote_events = lambda: events
        _mod.send = lambda text: (sent.append(text) or True)
        try:
            code = _mod.main()
        finally:
            _mod.MONITOR, _mod.MARK, _mod.remote_events, _mod.send = saved
        mark = json.loads((root / 'mark.json').read_text()) if (root / 'mark.json').exists() else {}
        return code, sent, mark

    def test_incident_running_is_suppressed_but_watermark_moves(self):
        import tempfile, time
        now = int(time.time()*1000)
        with tempfile.TemporaryDirectory() as t:
            code, sent, mark = self._run(t, 'offline', [ev('x1', 'recovered', now, True)])
            self.assertEqual(code, 0)
            self.assertEqual(sent, [], '监控在通知，事件通知器不能再发一条')
            self.assertEqual(mark.get('lastId'), 'x1', '水位线必须推进，否则下一轮还会来')

    def test_no_incident_means_it_reports(self):
        import tempfile, time
        now = int(time.time()*1000)
        with tempfile.TemporaryDirectory() as t:
            code, sent, mark = self._run(t, 'online', [ev('x2', 'recovered', now, True)])
            self.assertEqual(code, 0)
            self.assertEqual(len(sent), 1, '短故障自愈监控看不见，得靠这条补')
            self.assertEqual(mark.get('lastId'), 'x2')


class NotifyTargets(unittest.TestCase):
    """通知目标不再写死：来自环境或 private/*.env，缺失要说得清缺哪个。"""

    def setUp(self):
        self._saved = dict(os.environ)
        for key in ('XYY_ADMIN_IM_ID', 'XYY_ADMIN_IM_IDS', 'XYY_ADMIN_IM_PLATFORM',
                    'XYY_TELEGRAM_CHAT_ID', 'XYY_PRIVATE_DIR', 'XYY_HOME'):
            os.environ.pop(key, None)
        _mod._env_cache = None

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved)
        _mod._env_cache = None

    def test_from_environment(self):
        os.environ['XYY_ADMIN_IM_ID'] = 'admin@im.wechat'
        os.environ['XYY_TELEGRAM_CHAT_ID'] = '4242'
        targets, missing = _mod.notify_targets()
        self.assertEqual(targets, ['weixin:admin@im.wechat', 'telegram:4242'])
        self.assertEqual(missing, [])

    def test_platform_is_configurable(self):
        os.environ['XYY_ADMIN_IM_ID'] = 'admin@im.wechat'
        os.environ['XYY_ADMIN_IM_PLATFORM'] = 'tg'
        self.assertEqual(_mod.notify_targets()[0], ['tg:admin@im.wechat'])

    def test_missing_config_reports_variable_names(self):
        targets, missing = _mod.notify_targets()
        self.assertEqual(targets, [])
        self.assertEqual(sorted(missing), ['XYY_ADMIN_IM_ID', 'XYY_TELEGRAM_CHAT_ID'])

    def test_partial_config_still_delivers(self):
        os.environ['XYY_TELEGRAM_CHAT_ID'] = '4242'
        targets, missing = _mod.notify_targets()
        self.assertEqual(targets, ['telegram:4242'])
        self.assertEqual(missing, ['XYY_ADMIN_IM_ID'])

    def test_reads_private_env_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            with open(os.path.join(t, 'notify.env'), 'w', encoding='utf-8') as handle:
                handle.write('# comment\nexport XYY_ADMIN_IM_ID=file@im.wechat\nXYY_TELEGRAM_CHAT_ID=\'1001\'\n')
            os.environ['XYY_PRIVATE_DIR'] = t
            targets, missing = _mod.notify_targets()
            self.assertEqual(targets, ['weixin:file@im.wechat', 'telegram:1001'])
            self.assertEqual(missing, [])

    def test_environment_beats_env_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            with open(os.path.join(t, 'notify.env'), 'w', encoding='utf-8') as handle:
                handle.write('XYY_ADMIN_IM_ID=file@im.wechat\n')
            os.environ['XYY_PRIVATE_DIR'] = t
            os.environ['XYY_ADMIN_IM_ID'] = 'env@im.wechat'
            self.assertEqual(_mod.notify_targets()[0], ['weixin:env@im.wechat'])

    def test_send_without_targets_reports_and_fails(self):
        sent = []
        original = _mod.subprocess.run
        _mod.subprocess.run = lambda *a, **k: sent.append(a)
        try:
            self.assertFalse(_mod.send('hello'))
        finally:
            _mod.subprocess.run = original
        self.assertEqual(sent, [], '没有目标时不该调 hermes')


if __name__ == '__main__':
    unittest.main()
