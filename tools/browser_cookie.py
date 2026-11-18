#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
browser_cookie.py —— 从本机浏览器直接取 B 站登录 cookie，省掉手工 F12 复制。

原理：Chromium 系浏览器把 cookie 存在 SQLite 里，值用 Windows DPAPI 派生的
主密钥做 AES-256-GCM 加密（密文前缀 v10）。本脚本用当前用户身份解密，
不需要任何外部服务。

用法：
  python browser_cookie.py                       # 自动找 Edge Default
  python browser_cookie.py --browser chrome
  python browser_cookie.py --profile "Profile 1"
  python browser_cookie.py --db C:\\path\\Cookies  # 直接用已复制的数据库
  python browser_cookie.py --write ~/.dsh-bili-learn/settings.json   # 顺手写进插件配置

重要：浏览器**正在运行**时 Cookies 数据库被独占，脚本会给明确提示。
      先完全退出浏览器再跑，或先把整个 profile 的 Network\\Cookies 复制出来再用 --db。
"""
import argparse
import base64
import ctypes
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from ctypes import wintypes

try:
    from Crypto.Cipher import AES
except ImportError:
    print("需要 pycryptodome：pip install pycryptodome", file=sys.stderr)
    raise SystemExit(2)

BROWSER_ROOTS = {
    "edge": os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\User Data"),
    "chrome": os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\User Data"),
    "brave": os.path.expandvars(r"%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data"),
}

# B 站登录相关的 cookie，SESSDATA 是字幕接口的关键
WANTED = ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid", "buvid3", "buvid4")


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def dpapi_unprotect(data: bytes) -> bytes:
    """用当前 Windows 用户身份解 DPAPI 密文。"""
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = DATA_BLOB()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    )
    if not ok:
        raise OSError("CryptUnprotectData 失败（可能不是同一个 Windows 用户）")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def master_key(user_data_dir: str) -> tuple[bytes, str]:
    """返回 (AES 主密钥, 加密方案)。"""
    ls_path = os.path.join(user_data_dir, "Local State")
    with open(ls_path, encoding="utf-8") as f:
        state = json.load(f)
    os_crypt = state.get("os_crypt") or {}
    scheme = "v10"
    raw_b64 = os_crypt.get("encrypted_key")
    if not raw_b64:
        raise RuntimeError("Local State 里没有 os_crypt.encrypted_key")
    raw = base64.b64decode(raw_b64)
    if raw[:5] != b"DPAPI":
        raise RuntimeError("encrypted_key 不是 DPAPI 格式，无法用当前用户解密")
    key = dpapi_unprotect(raw[5:])
    if os_crypt.get("app_bound_encrypted_key"):
        # Chrome/Edge 127+ 推出了 app-bound 加密；老 cookie 仍是 v10，新写入可能是 v20
        scheme = "v20-possible"
    return key, scheme


def decrypt_value(enc: bytes, key: bytes) -> bytes:
    if not enc:
        return b""
    prefix = enc[:3]
    if prefix == b"v10" or prefix == b"v11":
        nonce, ct, tag = enc[3:15], enc[15:-16], enc[-16:]
        return AES.new(key, AES.MODE_GCM, nonce=nonce).decrypt_and_verify(ct, tag)
    if prefix == b"v20":
        raise RuntimeError(
            "v20 app-bound 加密（Edge/Chrome 127+ 起）：需要 SYSTEM 权限解第一层密钥，"
            "用户态解不开。请改用扫码登录或手工复制 SESSDATA"
        )
    # 极老的明文 cookie
    return enc


def snapshot_db(src: str) -> str:
    """把被锁的数据库复制到临时位置；锁住时给出可操作的提示。"""
    dst = os.path.join(tempfile.gettempdir(), "bili_cookies_snapshot.db")
    try:
        shutil.copy2(src, dst)
        return dst
    except PermissionError:
        raise SystemExit(
            f"无法读取 {src}\n"
            "浏览器正在运行，Cookies 数据库被独占。\n"
            "请完全退出浏览器后重试；或者手动把这个文件复制到别处，再用 --db 指定副本：\n"
            f"  {src}"
        )


def find_db(user_data_dir: str, profile: str) -> str:
    for name in ("Network\\Cookies", "Cookies"):
        p = os.path.join(user_data_dir, profile, name)
        if os.path.exists(p):
            return p
    raise SystemExit(f"在 {profile} 下没找到 Cookies 数据库")


def read_cookies(db_path: str, key: bytes) -> dict:
    db = sqlite3.connect(db_path)
    try:
        rows = db.execute(
            "select host_key, name, encrypted_value, value from cookies "
            "where host_key like '%bilibili%'"
        ).fetchall()
    finally:
        db.close()
    out = {}
    for host, name, enc, plain in rows:
        try:
            val = plain or decrypt_value(enc, key).decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001
            msg = str(exc) or type(exc).__name__
            val = f"<解密失败: {msg}>"
        out[name] = val
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", default="edge", choices=sorted(BROWSER_ROOTS))
    ap.add_argument("--profile", default="Default")
    ap.add_argument("--db", default="")
    ap.add_argument("--user-data-dir", default="")
    ap.add_argument("--write", default="", help="把 SESSDATA 写进这个 settings.json")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args()

    udd = args.user_data_dir or BROWSER_ROOTS[args.browser]
    if not os.path.isdir(udd):
        raise SystemExit(f"找不到浏览器数据目录：{udd}")

    key, scheme = master_key(udd)
    print(f"[i] 主密钥已取得（{len(key)} 字节，方案 {scheme}）", file=sys.stderr)

    if args.db:
        db_path = args.db
        print(f"[i] 使用指定数据库：{db_path}", file=sys.stderr)
    else:
        db_path = snapshot_db(find_db(udd, args.profile))

    cookies = read_cookies(db_path, key)
    print(f"[i] 命中 bilibili cookie {len(cookies)} 条", file=sys.stderr)

    if not cookies.get("SESSDATA"):
        print(
            "[!] 没有 SESSDATA —— 这个 profile 没有登录 B 站。\n"
            f"    已有的条目：{', '.join(sorted(cookies)) or '（无）'}\n"
            "    换成登录过的 profile（--profile \"Profile 1\"），或先在该浏览器里登录 B 站。",
            file=sys.stderr,
        )
        if args.json:
            print(json.dumps({"ok": False, "cookies": cookies}, ensure_ascii=False, indent=2))
        return 1

    picked = {k: v for k, v in cookies.items() if k in WANTED}
    if args.json:
        print(json.dumps({"ok": True, "cookies": picked}, ensure_ascii=False, indent=2))
    else:
        print("SESSDATA=" + cookies["SESSDATA"])

    if args.write:
        path = os.path.expanduser(args.write)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        data = {}
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    data = json.load(f)
            except Exception:  # noqa: BLE001
                data = {}
        data["cookie"] = "SESSDATA=" + cookies["SESSDATA"]
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"[✓] 已写入 {path}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
