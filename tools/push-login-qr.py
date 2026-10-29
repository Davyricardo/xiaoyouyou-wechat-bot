"""手动推一张新的登录二维码到本人微信（应急用，平时由 monitor 自己做）。"""
import base64
import importlib.util
import secrets
import time
from pathlib import Path

MON = '/home/user/xiaoyouyou-aliyun-monitor/pi-aliyun-monitor.py'
spec = importlib.util.spec_from_file_location('mon', MON)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

code = 'XYY-%d-%s' % (int(time.time()), secrets.token_hex(4))
print('incident', code, flush=True)

st = m.rpc('status')
print('status', st, flush=True)
if not st.get('canLogin'):
    print('当前不具备登录条件（容器未运行或账号不符），不生成二维码')
    raise SystemExit(1)

m.rpc('begin', code=code, approvedAt=int(time.time() * 1000))
for i in range(30):
    time.sleep(2)
    r = (m.rpc('result', code=code).get('result') or {})
    print('  poll', i, r.get('phase'), flush=True)
    if r.get('phase') == 'waiting_scan' and r.get('qrReady'):
        break
    if r.get('phase') == 'failed':
        raise SystemExit('登录任务失败：' + str(r.get('reason')))
else:
    raise SystemExit('等不到二维码')

value = m.rpc('qr', code=code)
png = base64.b64decode(value['png'], validate=True)
out = Path('/home/user/.local/state/xiaoyouyou-aliyun/qr') / (code + '.png')
out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
out.write_bytes(png)
out.chmod(0o600)
print('qr saved', out, len(png), 'bytes', flush=True)

ok = m.send(
    '小鱿鱿的桌面微信掉登录了（微信客户端自己重启后回到扫码界面），已生成登录二维码。\n'
    '请用原“小鱿鱿”账号扫下面这张，手机上点确认即可，恢复后会自动通知你，不用回复。\n'
    '二维码约 3 分钟内有效，过期我会再推一张。\n'
    '事件：' + code + '\nMEDIA:' + str(out))
print('delivered', ok, flush=True)
