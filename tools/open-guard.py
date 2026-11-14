#!/usr/bin/env python3
"""消息卡在微信里没落库时，自动打开一次会话把它挤进数据库。

背景：微信客户端收到群消息后，有时只更新会话列表（/api/chats 的
lastMsgLocalId），要等会话被打开才写进消息库（/api/messages）。机器人读的是
消息库，于是「看不见」这条消息。

做法：每 POLL 秒比较这两个数字；在确认登录态健康且无人持有 ui.lock 的前提下，
若会话列表比消息库大、且连续 NEED 次都这样，才申请 ui.lock 后 POST /api/chats/{id}/open
一次。不重启进程、不碰数据库，正常情况下什么都不做。
"""
import json
import os
import time
import urllib.request
from pathlib import Path
from urllib.parse import quote

HOME = os.environ.get("XYY_HOME", "/opt/xiaoyouyou")
BASE = os.environ.get("XYY_WECHAT_API", "http://127.0.0.1:6174")
ENV = os.path.join(HOME, "private/wechat.env")
STATE = os.environ.get("XYY_STATE_DIR") or os.path.join(HOME, "private/.local/state/splatoon-bridge")

POLL = float(os.environ.get("XYY_OPEN_POLL_S", 3))
NEED = int(os.environ.get("XYY_OPEN_CHECKS", 2))
COOLDOWN = int(os.environ.get("XYY_OPEN_COOLDOWN_S", 15))
MAX_TRIES = int(os.environ.get("XYY_OPEN_MAX_TRIES", 6))
UI_LOCK = os.environ.get("XYY_UI_LOCK_FILE") or os.path.join(STATE, "ui.lock")
AUTH_CACHE = os.path.join(STATE, "auth-cache.json")
GATE = os.path.join(STATE, "login-gate.json")
DEFAULT_LOCK_TTL_MS = 45000
OPEN_LOCK_TTL_MS = 15000
PLACEHOLDER_CHAT = "123456789@chatroom"


def _read_env_var(path, key):
    try:
        with open(path, encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() != key:
                    continue
                val = v.strip()
                if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                    val = val[1:-1]
                if val.strip():
                    return val.strip()
    except OSError:
        pass
    return ""


def resolve_chat():
    chat = (os.environ.get("SPLATOON_CHAT_ID") or _read_env_var(ENV, "SPLATOON_CHAT_ID")).strip()
    if not chat:
        candidates = [
            Path(HOME) / "bot-config.json",
            Path(HOME) / "src" / "bot-config.json",
            Path(__file__).resolve().parent.parent / "src" / "bot-config.json",
        ]
        for cfg in candidates:
            try:
                data = json.loads(cfg.read_text(encoding="utf-8"))
                val = str(data.get("chatId") or "").strip()
                if val:
                    chat = val
                    break
            except Exception:
                continue
    if not chat or chat == PLACEHOLDER_CHAT or not chat.endswith("@chatroom"):
        raise SystemExit(
            "open-guard: missing valid SPLATOON_CHAT_ID or bot-config.json chatId (got %r)" % chat
        )
    return chat


def resolve_token():
    tok = (os.environ.get("AGENT_WECHAT_TOKEN") or _read_env_var(ENV, "AGENT_WECHAT_TOKEN")).strip()
    if not tok:
        raise SystemExit("open-guard: missing AGENT_WECHAT_TOKEN in env or %s" % ENV)
    return tok


def pid_alive(pid):
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def lock_is_active(lock_path=UI_LOCK, now_ms=None):
    try:
        st = os.stat(lock_path)
    except OSError:
        return False
    now = int(time.time() * 1000) if now_ms is None else now_ms
    try:
        data = json.loads(Path(lock_path).read_text(encoding="utf-8"))
    except Exception:
        return False
    if not isinstance(data, dict):
        return False
    ttl = data.get("ttlMs")
    ttl_ms = int(ttl) if isinstance(ttl, (int, float)) and ttl > 0 else DEFAULT_LOCK_TTL_MS
    at = data.get("at")
    at_ms = int(at) if isinstance(at, (int, float)) and at > 0 else int(st.st_mtime * 1000)
    if now - at_ms > ttl_ms:
        return False
    pid = data.get("pid")
    if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0 and not pid_alive(pid):
        return False
    return True


def acquire_ui_lock(lock_path=UI_LOCK, owner="open-guard", ttl_ms=OPEN_LOCK_TTL_MS):
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    for _ in range(2):
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            try:
                payload = json.dumps(
                    {"owner": owner, "pid": os.getpid(), "at": int(time.time() * 1000), "ttlMs": ttl_ms},
                    ensure_ascii=False,
                )
                os.write(fd, payload.encode("utf-8"))
            finally:
                os.close(fd)
            return True
        except FileExistsError:
            if lock_is_active(lock_path):
                return False
            try:
                os.unlink(lock_path)
            except FileNotFoundError:
                pass
            except OSError:
                return False
    return False


def release_ui_lock(lock_path=UI_LOCK, owner="open-guard"):
    try:
        data = json.loads(Path(lock_path).read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("pid") == os.getpid() and data.get("owner") == owner:
            os.unlink(lock_path)
    except FileNotFoundError:
        pass
    except Exception:
        pass


def should_skip_cycle(now_ms=None):
    now = int(time.time() * 1000) if now_ms is None else now_ms
    try:
        cache = json.loads(Path(AUTH_CACHE).read_text(encoding="utf-8"))
        at = cache.get("at") or cache.get("updatedAt") or 0
        if isinstance(at, (int, float)) and now - at < 300000 and cache.get("status") != "logged_in":
            return "auth_cache:" + str(cache.get("status") or "unknown")
    except Exception:
        pass
    try:
        gate_stat = os.stat(GATE)
        gate = json.loads(Path(GATE).read_text(encoding="utf-8"))
        if gate.get("phase") == "blocked" and (now / 1000.0 - gate_stat.st_mtime) < 120:
            return "login_gate_blocked"
    except Exception:
        pass
    if lock_is_active(UI_LOCK, now):
        return "ui_lock_active"
    return None


def api(path, token, method="GET"):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        headers={"Authorization": "Bearer " + token},
    )
    body = urllib.request.urlopen(req, timeout=10).read()
    return json.loads(body) if body else None


def chat_last(chat_id, token):
    for c in api("/api/chats", token):
        if c.get("username") == chat_id or c.get("id") == chat_id or c.get("chatId") == chat_id:
            return int(c.get("lastMsgLocalId") or 0)
    return None


def db_last(chat_id, token):
    msgs = api("/api/messages/%s?limit=1" % quote(chat_id, safe=""), token)
    return max((int(m.get("localId") or 0) for m in msgs), default=0)


def main():
    chat_id = resolve_chat()
    token = resolve_token()
    stale = 0
    last_open = 0.0
    target, tries = None, 0
    print(
        "open-guard started chat=%s poll=%.0fs need=%d cooldown=%ds max_tries=%d"
        % (chat_id, POLL, NEED, COOLDOWN, MAX_TRIES),
        flush=True,
    )
    while True:
        try:
            skip = should_skip_cycle()
            if skip:
                time.sleep(POLL)
                continue
            c, d = chat_last(chat_id, token), db_last(chat_id, token)
            if c is not None and c > d:
                stale += 1
                if c != target:
                    target, tries = c, 0
                if stale >= NEED and tries < MAX_TRIES and time.time() - last_open >= COOLDOWN:
                    if not acquire_ui_lock():
                        print("open skipped: ui.lock busy", flush=True)
                    else:
                        try:
                            tries += 1
                            print("stuck chats=%d db=%d, opening chat (%d/%d)" % (c, d, tries, MAX_TRIES), flush=True)
                            if tries == MAX_TRIES:
                                print("giving up on %d until a newer message arrives" % c, flush=True)
                            api("/api/chats/%s/open" % quote(chat_id, safe=""), token, method="POST")
                            last_open = time.time()
                        finally:
                            release_ui_lock()
            else:
                if tries:
                    print("recovered chats=%s db=%d after %d open(s)" % (c, d, tries), flush=True)
                stale, target, tries = 0, None, 0
        except Exception as exc:
            print("poll error:", exc, flush=True)
        time.sleep(POLL)


if __name__ == "__main__":
    main()
