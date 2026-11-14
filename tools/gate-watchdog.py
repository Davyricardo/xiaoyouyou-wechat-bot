#!/usr/bin/env python3
"""登录闸门自愈：恢复流程失败后会把 login-gate 留在 blocked，桥接就静默不干活。
这里只在「确实健康」时清闸：登录态 logged_in（且账号符合期望）、桥接 active、
且没有正在进行的恢复任务。
"""
import json
import os
import subprocess
import time
import urllib.request

HOME = os.environ.get("XYY_HOME", "/opt/xiaoyouyou")
BASE = os.environ.get("XYY_WECHAT_API", "http://127.0.0.1:6174")
STATE = os.environ.get("XYY_STATE_DIR") or os.path.join(HOME, "private/.local/state/splatoon-bridge")
GATE = os.path.join(STATE, "login-gate.json")
REC = os.path.join(STATE, "remote-recovery")
EVENTS = os.path.join(STATE, "recovery-events.jsonl")
ENV = os.path.join(HOME, "private/wechat.env")
AUTH_CACHE = os.path.join(STATE, "auth-cache.json")
EXPECTED_FILE = os.path.join(HOME, "private/expected-user.txt")
BRIDGE_UNIT = os.environ.get("XYY_BRIDGE_UNIT", "xiaoyouyou-aliyun")
ACTIVE = {"starting", "waiting_scan", "awaiting_confirmation", "verifying"}


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


def token():
    tok = (os.environ.get("AGENT_WECHAT_TOKEN") or _read_env_var(ENV, "AGENT_WECHAT_TOKEN")).strip()
    return tok


def read_expected_user():
    val = (os.environ.get("XYY_EXPECTED_USER") or _read_env_var(ENV, "XYY_EXPECTED_USER")).strip()
    if val:
        return val
    try:
        with open(EXPECTED_FILE, encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def is_expected_user(uid, expected):
    if not expected:
        return True
    if not isinstance(uid, str) or not uid:
        return False
    return "_".join(uid.split("_")[:2]) == "_".join(expected.split("_")[:2])


def auth_info():
    now_ms = int(time.time() * 1000)
    try:
        st = os.stat(AUTH_CACHE)
        data = json.load(open(AUTH_CACHE, encoding="utf-8"))
        at = data.get("at") or data.get("updatedAt") or int(st.st_mtime * 1000)
        if isinstance(at, (int, float)) and now_ms - at < 120000 and data.get("status") == "logged_in":
            return data
    except Exception:
        pass
    req = urllib.request.Request(
        BASE + "/api/status/auth",
        headers={"Authorization": "Bearer " + token()},
    )
    return json.load(urllib.request.urlopen(req, timeout=8))


def recent_recovery(code, now):
    try:
        d = json.load(open(os.path.join(REC, code + ".json"), encoding="utf-8"))
    except Exception:
        return None
    age = now - (d.get("updatedAt") or d.get("startedAt") or 0) / 1000.0
    return d.get("phase"), age


def main():
    try:
        gate = json.load(open(GATE, encoding="utf-8"))
    except Exception:
        return
    if gate.get("phase") != "blocked":
        return
    try:
        blocked_for = time.time() - os.stat(GATE).st_mtime
    except OSError:
        return
    if blocked_for < 90:
        return
    code = gate.get("code") or ""
    phase_age = recent_recovery(code, time.time())
    if phase_age and phase_age[0] in ACTIVE and phase_age[1] < 300:
        print("gate blocked but recovery still active (%s, %.0fs)" % (phase_age[0], phase_age[1]), flush=True)
        return
    try:
        info = auth_info() or {}
    except Exception as exc:
        print("auth check failed:", exc, flush=True)
        return
    status = info.get("status")
    logged_in_user = info.get("loggedInUser") or ""
    expected = read_expected_user()
    if status == "logged_in" and expected and not is_expected_user(logged_in_user, expected):
        print(
            "gate blocked, wrong account logged in (%s != %s), keeping blocked"
            % (logged_in_user, expected),
            flush=True,
        )
        return
    bridge = subprocess.run(
        ["systemctl", "is-active", BRIDGE_UNIT],
        capture_output=True,
        text=True,
    ).stdout.strip()
    if status != "logged_in" or bridge != "active":
        print("gate blocked, not clearing: auth=%s bridge=%s" % (status, bridge), flush=True)
        return
    tmp = GATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"code": code, "phase": "resume"}, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, GATE)
    msg = "gate auto-cleared: %s blocked %.0fs, auth=logged_in bridge=active" % (code, blocked_for)
    print(msg, flush=True)
    try:
        with open(EVENTS, "a", encoding="utf-8") as fh:
            fh.write(
                json.dumps(
                    {
                        "id": "%d-gate%s" % (int(time.time() * 1000), os.getpid() % 1000),
                        "type": "gate_cleared",
                        "at": int(time.time() * 1000),
                        "detail": msg,
                        "host": "bot",
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    except Exception:
        pass


if __name__ == "__main__":
    main()
