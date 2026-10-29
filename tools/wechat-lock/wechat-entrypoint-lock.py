"""锁版本：在容器内给 /entrypoint.sh 插一段幂等的域名拦截。

微信客户端本身装在 /opt/wechat（root 所有，wechat 用户不可写），所以「原地自更新」本来就做不到；
这里拦的是它的更新检查与下载（二进制里引用 dldir1.qq.com / dldir1v6.qq.com），
避免它下包、弹窗、以及将来某个版本把自己写进 profile 造成 headless 起不来。

Docker 每次 start 都会重新生成 /etc/hosts，所以必须在 entrypoint 里补，不能只在宿主机补一次。
插入的语句全部带 `|| true`，任何异常都不能影响启动。
"""
from pathlib import Path

MARK = 'XYY-LOCK-VERSION'
TARGET = Path('/entrypoint.sh')
BACKUP = Path('/entrypoint.sh.bak-xyy')
BLOCK = (
    '# ' + MARK + ': 锁死微信版本，屏蔽更新下载域名（幂等；失败不阻断启动）\n'
    "grep -q 'dldir1.qq.com' /etc/hosts 2>/dev/null || "
    "printf '0.0.0.0 dldir1.qq.com\\n0.0.0.0 dldir1v6.qq.com\\n' >> /etc/hosts 2>/dev/null || true\n"
)


def main() -> int:
    text = TARGET.read_text()
    if MARK in text:
        print('already patched')
        return 0
    anchor = 'set -euo pipefail\n'
    if anchor not in text:
        print('anchor missing; refuse to patch')
        return 1
    if not BACKUP.exists():
        BACKUP.write_text(text)
    TARGET.write_text(text.replace(anchor, anchor + BLOCK, 1))
    print('patched')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
