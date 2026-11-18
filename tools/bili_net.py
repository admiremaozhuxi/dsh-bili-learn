#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bili_net.py —— 取播放直链的多路竞速。

为什么要竞速
------------
实测（2026-11）同一台机器上：
  * 自建服务器 /playurl   最快，且把风控挪到服务器 IP
  * 直连 wbi/playurl      可靠，但本机 IP 有时被限流
  * 直连 playurl（旧）     偶尔能过，偶尔被 WAF 挡回 HTML
三条路的成功率随时间波动，所以按用户要的顺序排：

  1. 自建服务器（配置了就先走它）
  2. 自建不通时，直连的两条路**并行**跑，谁先成功用谁
  3. 都失败才算真的失败

第三方解析站不在此列：实测它们在纯 GET 下不吐直链（v2ob 9 万字节、
iiilab 21 万字节均无直链痕迹，只有验证码与帮助文本），必须人工在页面上
点，因此无法参与自动竞速。它们留作人工备选。
"""
import hashlib
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
API = "https://api.bilibili.com"
SETTINGS = os.path.expanduser(r"~\.dsh-bili-learn\settings.json")

TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
    26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
    20, 34, 44, 52,
]

_lock = threading.Lock()
_wbi = {"key": "", "at": 0.0}


def load_settings():
    try:
        with open(SETTINGS, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def _headers(referer=None, cookie=None):
    h = {
        "User-Agent": UA,
        "Origin": "https://www.bilibili.com",
        "Accept": "application/json, text/plain, */*",
    }
    if referer:
        h["Referer"] = referer
    if cookie:
        h["Cookie"] = cookie
    return h


def _get_json(url, referer=None, cookie=None, timeout=12):
    req = urllib.request.Request(url, headers=_headers(referer, cookie))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return {"_http": e.code}
    except Exception as e:  # noqa: BLE001
        return {"_err": str(e)[:120]}
    if raw.lstrip().startswith("<"):
        return {"_html": True}
    try:
        return json.loads(raw)
    except Exception:  # noqa: BLE001
        return {"_raw": raw[:120]}


def _mixin_key(cookie="", timeout=10):
    with _lock:
        if _wbi["key"] and time.time() - _wbi["at"] < 3600:
            return _wbi["key"]
    d = _get_json(f"{API}/x/web-interface/nav", cookie=cookie, timeout=timeout)
    if d.get("code") not in (0, -101):
        return ""
    try:
        img = d["data"]["wbi_img"]["img_url"].rsplit("/", 1)[-1].split(".")[0]
        sub = d["data"]["wbi_img"]["sub_url"].rsplit("/", 1)[-1].split(".")[0]
    except Exception:  # noqa: BLE001
        return ""
    orig = img + sub
    if len(orig) < 64:
        return ""
    key = "".join(orig[i] for i in TAB)[:32]
    with _lock:
        _wbi["key"] = key
        _wbi["at"] = time.time()
    return key


def _signed(base, params, key):
    p = dict(params)
    p["wts"] = int(time.time())
    q = urllib.parse.urlencode(sorted(p.items()))
    p["w_rid"] = hashlib.md5((q + key).encode()).hexdigest()
    return base + "?" + urllib.parse.urlencode(sorted(p.items()))


def _shape(d, source):
    """把不同来源的响应统一成 {audio:[...], video:[...]}。"""
    if not d or d.get("code") != 0:
        return None
    data = d.get("data") or {}
    dash = data.get("dash") or {}
    audio = dash.get("audio") or []
    video = dash.get("video") or []
    if not audio and not video:
        # 老接口可能只有 durl
        durl = data.get("durl") or []
        if not durl:
            return None
        return {
            "source": source,
            "audio": [],
            "video": [
                {
                    "id": 0,
                    "bandwidth": x.get("size") or 0,
                    "baseUrl": x.get("url"),
                    "backupUrl": x.get("backup_url") or [],
                }
                for x in durl
            ],
            "quality": data.get("quality"),
        }
    return {
        "source": source,
        "audio": [
            {
                "id": a.get("id"),
                "bandwidth": a.get("bandwidth"),
                "baseUrl": a.get("baseUrl") or a.get("base_url"),
                "backupUrl": a.get("backupUrl") or a.get("backup_url") or [],
            }
            for a in audio
        ],
        "video": [
            {
                "id": v.get("id"),
                "width": v.get("width"),
                "height": v.get("height"),
                "bandwidth": v.get("bandwidth"),
                "baseUrl": v.get("baseUrl") or v.get("base_url"),
                "backupUrl": v.get("backupUrl") or v.get("backup_url") or [],
            }
            for v in video
        ],
        "quality": data.get("quality"),
    }


# ------------------------------------------------------------------ 三条路

def try_self(endpoint, bvid, cid, timeout=4.0):
    """自建服务器：它自己的限速与缓存都在服务端。"""
    if not endpoint:
        return None
    url = f"{endpoint.rstrip('/')}/playurl?bvid={bvid}&cid={cid}"
    d = _get_json(url, timeout=timeout)
    if d.get("code") != 0:
        return None
    audio = d.get("audio") or []
    video = d.get("video") or []
    if not audio and not video:
        return None
    return {
        "source": "self",
        "audio": [{"id": a.get("id"), "bandwidth": a.get("bandwidth"),
                   "baseUrl": a.get("url"), "backupUrl": []} for a in audio],
        "video": [{"id": v.get("id"), "height": v.get("quality"),
                   "bandwidth": v.get("bandwidth"),
                   "baseUrl": v.get("url"), "backupUrl": []} for v in video],
        "quality": d.get("quality"),
    }


def try_wbi(bvid, cid, cookie="", timeout=10):
    key = _mixin_key(cookie, timeout)
    referer = f"https://www.bilibili.com/video/{bvid}"
    if key:
        url = _signed(f"{API}/x/player/wbi/playurl",
                      {"bvid": bvid, "cid": cid, "qn": 16, "fnval": 16}, key)
    else:
        url = f"{API}/x/player/playurl?bvid={bvid}&cid={cid}&qn=16&fnval=16"
    return _shape(_get_json(url, referer=referer, cookie=cookie, timeout=timeout), "direct-wbi")


def try_plain(bvid, cid, cookie="", timeout=10):
    referer = f"https://www.bilibili.com/video/{bvid}"
    url = f"{API}/x/player/playurl?bvid={bvid}&cid={cid}&qn=16&fnval=16"
    return _shape(_get_json(url, referer=referer, cookie=cookie, timeout=timeout), "direct")


# -------------------------------------------------------------------- 竞速

def resolve(bvid, cid, settings=None, timeout=4.0):
    """
    返回 (dash, trail)。dash 为 None 表示全失败，trail 记录每一路的结果，
    便于在产物里写清「这次是从哪条路拿到的」。
    """
    s = settings if settings is not None else load_settings()
    mode = (s.get("mode") or "auto").lower()
    endpoint = (s.get("endpoint") or "").strip()
    cookie = (s.get("cookie") or "").strip()
    trail = []

    if mode in ("auto", "self") and endpoint:
        t0 = time.time()
        got = try_self(endpoint, bvid, cid, timeout=timeout)
        if got:
            trail.append(f"self ok {time.time()-t0:.1f}s")
            return got, trail
        trail.append(f"self fail {time.time()-t0:.1f}s")
        if mode == "self":
            return None, trail

    if mode == "default":
        trail.append("mode=default 不发起请求")
        return None, trail

    # 自建不通（或没配）：两条直连并行，谁先成功用谁
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=2) as pool:
        futs = {
            pool.submit(try_wbi, bvid, cid, cookie): "wbi",
            pool.submit(try_plain, bvid, cid, cookie): "plain",
        }
        for fut in as_completed(futs, timeout=timeout + 8):
            name = futs[fut]
            try:
                got = fut.result()
            except Exception:  # noqa: BLE001
                trail.append(f"{name} error")
                continue
            if got:
                trail.append(f"{name} ok {time.time()-t0:.1f}s")
                return got, trail
            trail.append(f"{name} fail")
    return None, trail


def pick_stream(dash, kind="video", lowest=True):
    """从 dash 里挑一条流，低码率优先（够看清即可，省流量省 token）。"""
    if not dash:
        return None
    items = [x for x in (dash.get(kind) or []) if x.get("baseUrl")]
    if not items:
        return None
    items.sort(key=lambda x: x.get("bandwidth") or 0, reverse=not lowest)
    return items[0]


def candidate_urls(stream):
    """主地址 + B 站自己给的备用 CDN，一起排成候选。"""
    if not stream:
        return []
    out = [stream.get("baseUrl")]
    for u in stream.get("backupUrl") or []:
        out.append(u)
    return [u for u in out if u]


def fetch_bytes(urls, headers=None, timeout=120, limit=0):
    """依次试候选地址，第一个成功的就返回。"""
    h = {"User-Agent": UA, "Referer": "https://www.bilibili.com/"}
    if headers:
        h.update(headers)
    last = ""
    for u in urls:
        req = urllib.request.Request(u, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read(limit) if limit else r.read()
                return data, u
        except Exception as e:  # noqa: BLE001
            last = f"{type(e).__name__}: {str(e)[:80]}"
            continue
    raise RuntimeError(last or "所有候选地址都失败")
