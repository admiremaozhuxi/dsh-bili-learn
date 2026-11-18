#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sync_polylens_cookie.py —— 把 polylens 的登录凭据同步给 dsh-bili-learn 插件。

为什么需要它
------------
两套组件各自保存登录态：
  * polylens-bilibili-mcp 存在 ~/.cache/polylens-bilibili/cookie
  * dsh-bili-learn 插件读 ~/.dsh-bili-learn/settings.json 的 cookie 字段
扫码一次只解决前者。这个脚本把 SESSDATA 取出来写进后者，一份登录两处用。

用法
----
  python sync_polylens_cookie.py            # 同步
  python sync_polylens_cookie.py --dry-run  # 只看解析结果，不写文件
"""
import argparse
import json
import os
import re
import sys

CANDIDATES = [
    os.path.expanduser("~/.cache/polylens-bilibili/cookie"),
    os.path.expanduser("~/AppData/Local/polylens-bilibili/cookie"),
    os.path.expandvars(r"%LOCALAPPDATA%\polylens-bilibili\cookie"),
    os.path.expanduser("~/.polylens-bilibili/cookie"),
]

SETTINGS = os.path.expanduser("~/.dsh-bili-learn/settings.json")


def find_cookie_file(explicit: str = "") -> str:
    if explicit:
        if not os.path.exists(explicit):
            raise SystemExit(f"指定的文件不存在：{explicit}")
        return explicit
    for p in CANDIDATES:
        if p and os.path.exists(p):
            return p
    raise SystemExit(
        "找不到 polylens 的 cookie 文件。先让 DSH 调 start_qr_login + complete_qr_login 完成扫码。\n"
        "找过这些位置：\n  " + "\n  ".join(p for p in CANDIDATES if p)
    )


def parse(raw: str) -> dict:
    """从多种可能格式里抽出 cookie 键值。"""
    raw = raw.strip()
    if not raw:
        return {}

    # 1) JSON
    if raw.startswith("{") or raw.startswith("["):
        try:
            data = json.loads(raw)
        except Exception:  # noqa: BLE001
            data = None
        if isinstance(data, dict):
            # 直接就是键值表
            flat = {k: v for k, v in data.items() if isinstance(v, str)}
            if "SESSDATA" in flat:
                return flat
            # 或者包在 cookie / cookies / data 字段里
            for key in ("cookie", "cookies", "data", "value"):
                inner = data.get(key)
                if isinstance(inner, str) and "SESSDATA" in inner:
                    return parse(inner)
                if isinstance(inner, dict) and "SESSDATA" in inner:
                    return {k: v for k, v in inner.items() if isinstance(v, str)}
            # 列表形式 [{"name":..., "value":...}]
        if isinstance(data, list):
            out = {}
            for item in data:
                if isinstance(item, dict) and item.get("name") and item.get("value") is not None:
                    out[item["name"]] = str(item["value"])
            if out:
                return out

    # 2) Netscape cookies.txt
    if "\t" in raw and any(line.count("\t") >= 6 for line in raw.splitlines()):
        out = {}
        for line in raw.splitlines():
            if line.startswith("#") or not line.strip():
                continue
            parts = line.split("\t")
            if len(parts) >= 7:
                out[parts[5].strip()] = parts[6].strip()
        if out:
            return out

    # 3) 纯 cookie 串： a=1; b=2 或 SESSDATA=xxx
    out = {}
    for k, v in re.findall(r"([A-Za-z0-9_]+)=([^;,\s]+)", raw):
        out[k] = v
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default="", help="直接指定 polylens cookie 文件")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    path = find_cookie_file(args.file)
    with open(path, encoding="utf-8", errors="replace") as f:
        raw = f.read()
    print(f"[i] 读取 {path}（{len(raw)} 字节）")

    cookies = parse(raw)
    print(f"[i] 解析出 {len(cookies)} 个 cookie：{', '.join(sorted(cookies)) or '（空）'}")

    sess = cookies.get("SESSDATA")
    if not sess:
        print(
            "[!] 没找到 SESSDATA。可能这个文件存的是其他形态，或者登录还没完成。\n"
            "    把文件路径传进来看看：python sync_polylens_cookie.py --file <路径>",
            file=sys.stderr,
        )
        return 1

    # 只保留 B 站认的键，拼成一条 Cookie 头
    keep = ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid", "buvid3", "buvid4"]
    header = "; ".join(f"{k}={cookies[k]}" for k in keep if k in cookies)
    print(f"[i] SESSDATA 长度 {len(sess)}，将写入 Cookie 头（{len(header)} 字符）")

    if args.dry_run:
        print("[dry-run] 不写文件")
        return 0

    data = {}
    if os.path.exists(SETTINGS):
        try:
            with open(SETTINGS, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:  # noqa: BLE001
            data = {}
    data["cookie"] = header
    os.makedirs(os.path.dirname(SETTINGS), exist_ok=True)
    with open(SETTINGS, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"[✓] 已写入 {SETTINGS}")
    print("    插件下次调用会自动带上登录态，字幕与完整评论可用。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
