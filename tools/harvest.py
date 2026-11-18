#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B站批量采集器 —— 元数据 / 字幕 / 评论
设计要点（均为实测结论，勿随意改）：
  1. 元数据走 popular / ranking 批量接口，一次 100 条且自带 cid/aid，绝不走 view
     （实测：view 在无 cookie 时直接 -412 / HTTP 412，而 ranking 正常）
  2. 字幕必须登录态。实测无 cookie 时 player/v2 与 player/wbi/v2 都返回
     code=0 但 subtitles=[] 且 allow_submit=False —— 不是接口选错，是真的不给。
  3. 串行 + 限速 + 412 指数退避 + 断点续跑。实测同一 IP 约 30 次请求开始 412。
  4. 字幕文件本身走 hdslb CDN，公开无需 cookie，但要单独 GET 一次。

用法：
  python3 harvest.py --mode meta --pages 5
  python3 harvest.py --mode full --pages 2 --comment 20
  python3 harvest.py --mode bv --bv-file bvs.txt --comment 20
"""
import argparse
import hashlib
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.bilibili.com"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

# wbi 的官方重排表，写死，不随账号变化
MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
]

# 风控退避：命中后依次等待（秒）
BACKOFF = [45, 180, 600, 1800]


class RiskStop(Exception):
    """命中风控且退避用尽"""


class Client:
    def __init__(self, cookie="", gap=1.2, outdir="./data", verbose=True):
        self.cookie = cookie.strip()
        self.gap = gap
        self.verbose = verbose
        self.calls = 0
        self.outdir = Path(outdir)
        self.outdir.mkdir(parents=True, exist_ok=True)
        self._mixinkey = None
        self._mixinkey_at = 0
        self._last = 0.0
        self.risk_hits = 0

    # ---------------- 基础 ----------------
    def log(self, *a):
        if self.verbose:
            print(*a, flush=True)

    def _sleep_gap(self):
        dt = time.time() - self._last
        if dt < self.gap:
            time.sleep(self.gap - dt)
        self._last = time.time()

    def _headers(self, referer="https://www.bilibili.com/"):
        h = {
            "User-Agent": UA,
            "Referer": referer,
            "Origin": "https://www.bilibili.com",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
        }
        if self.cookie:
            h["Cookie"] = self.cookie
        return h

    def raw_get(self, url, referer="https://www.bilibili.com/"):
        """返回 (status, text)。不抛异常。"""
        req = urllib.request.Request(url, headers=self._headers(referer))
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode("utf-8", "replace")
            except Exception:
                body = ""
            return e.code, body
        except Exception as e:
            return 0, json.dumps({"_err": str(e)[:120]})

    def get_json(self, path_or_url, params=None, signed=False, retries=3):
        """带 wbi 签名 / 限速 / 风控退避的 JSON GET。"""
        url = path_or_url if path_or_url.startswith("http") else API + path_or_url
        for attempt in range(retries):
            if signed:
                self.ensure_mixinkey()
                url = self.sign(url, params or {})
            elif params:
                url = url + "?" + urllib.parse.urlencode(params)
            self._sleep_gap()
            self.calls += 1
            status, text = self.raw_get(url)
            if status == 412 or '"code":-412' in text.replace(" ", ""):
                self.risk_hits += 1
                if self.risk_hits > len(BACKOFF):
                    raise RiskStop("风控退避用尽，本轮停止（已调用 %d 次）" % self.calls)
                wait = BACKOFF[min(self.risk_hits - 1, len(BACKOFF) - 1)]
                self.log("  [风控 412] 第 %d 次命中，等 %ds" % (self.risk_hits, wait))
                time.sleep(wait)
                continue
            if status == 0:
                if attempt < retries - 1:
                    time.sleep(2)
                    continue
                return {"code": -1, "_err": text[:120]}
            try:
                return json.loads(text)
            except Exception:
                # 回的是 HTML 拦截页
                if "<html" in text[:200].lower():
                    self.risk_hits += 1
                    wait = BACKOFF[min(max(self.risk_hits - 1, 0), len(BACKOFF) - 1)]
                    self.log("  [HTML 拦截页] 等 %ds" % wait)
                    time.sleep(wait)
                    continue
                return {"code": -1, "_raw": text[:150]}
        return {"code": -1, "_err": "retries exhausted"}

    # ---------------- wbi ----------------
    def ensure_mixinkey(self):
        if self._mixinkey and time.time() - self._mixinkey_at < 3600:
            return self._mixinkey
        d = self.get_json("/x/web-interface/nav")
        if d.get("code") not in (0, -101):
            raise RuntimeError("取 wbi keys 失败: %s" % d.get("message"))
        img = d["data"]["wbi_img"]["img_url"].rsplit("/", 1)[-1].split(".")[0]
        sub = d["data"]["wbi_img"]["sub_url"].rsplit("/", 1)[-1].split(".")[0]
        orig = img + sub
        self._mixinkey = "".join(orig[i] for i in MIXIN_TAB)[:32]
        self._mixinkey_at = time.time()
        return self._mixinkey

    def sign(self, base, params):
        p = dict(params)
        p["wts"] = int(time.time())
        q = urllib.parse.urlencode(sorted(p.items()))
        p["w_rid"] = hashlib.md5((q + self._mixinkey).encode()).hexdigest()
        return base + "?" + urllib.parse.urlencode(sorted(p.items()))

    # ---------------- 元数据 ----------------
    def feed(self, source="popular", rid=0, pages=3):
        """批量拉元数据。popular 可翻页；ranking 取分区。返回 list[dict]"""
        out, seen = [], set()
        if source == "popular":
            for pn in range(1, pages + 1):
                d = self.get_json("/x/web-interface/popular",
                                  {"ps": 20, "pn": pn})
                if d.get("code") != 0:
                    self.log("  popular pn=%d 失败: %s" % (pn, d.get("message")))
                    break
                lst = (d.get("data") or {}).get("list") or []
                if not lst:
                    break
                for v in lst:
                    if v.get("bvid") and v["bvid"] not in seen:
                        seen.add(v["bvid"])
                        out.append(v)
                self.log("  popular pn=%d -> +%d（累计 %d）" % (pn, len(lst), len(out)))
        else:
            rids = [0, 1, 3, 4, 5, 17, 36, 119, 129, 155, 160, 168, 181, 188, 211, 217]
            if rid:
                rids = [rid]
            for r in rids[:pages] if pages < len(rids) else rids:
                d = self.get_json("/x/web-interface/ranking/v2",
                                  {"rid": r, "type": "all"})
                if d.get("code") != 0:
                    self.log("  ranking rid=%d 失败: %s" % (r, d.get("message")))
                    continue
                lst = (d.get("data") or {}).get("list") or []
                for v in lst:
                    if v.get("bvid") and v["bvid"] not in seen:
                        seen.add(v["bvid"])
                        out.append(v)
                self.log("  ranking rid=%d -> +%d（累计 %d）" % (r, len(lst), len(out)))
        return out

    # ---------------- 字幕 ----------------
    def subtitles(self, bvid, cid):
        """返回 (list_of_subs, trace)。无 cookie 时 B 站直接返回空列表。"""
        d = self.get_json("/x/player/wbi/v2", {"bvid": bvid, "cid": cid}, signed=True)
        if d.get("code") != 0:
            return [], "api_code_%s" % d.get("code")
        st = ((d.get("data") or {}).get("subtitle") or {})
        subs = st.get("subtitles") or []
        if not subs:
            return [], "empty_allow_submit_%s" % st.get("allow_submit")
        got = []
        for s in subs:
            u = s.get("subtitle_url") or ""
            if u.startswith("//"):
                u = "https:" + u
            if not u:
                continue
            _, txt = self.raw_get(u, referer="https://www.bilibili.com/video/%s" % bvid)
            try:
                body = json.loads(txt).get("body") or []
            except Exception:
                body = []
            lines = [{"from": x.get("from"), "to": x.get("to"), "text": x.get("content")}
                     for x in body]
            got.append({"lan": s.get("lan"), "lan_doc": s.get("lan_doc"),
                        "n": len(lines), "lines": lines})
            self._sleep_gap()
        return got, "ok"

    # ---------------- 评论 ----------------
    def comments(self, aid, limit=20):
        d = self.get_json("/x/v2/reply",
                          {"type": 1, "oid": aid, "ps": min(limit, 49), "sort": 2})
        if d.get("code") != 0:
            return [], "api_code_%s" % d.get("code")
        reps = (d.get("data") or {}).get("replies") or []
        out = []
        for r in reps[:limit]:
            out.append({
                "rpid": r.get("rpid"),
                "like": r.get("like"),
                "uname": (r.get("member") or {}).get("uname"),
                "ctime": r.get("ctime"),
                "msg": (r.get("content") or {}).get("message", "")[:500],
            })
        return out, "ok"


def slim(v):
    return {
        "bvid": v.get("bvid"),
        "aid": v.get("aid"),
        "cid": v.get("cid"),
        "title": v.get("title"),
        "desc": (v.get("desc") or "")[:500],
        "tname": v.get("tname") or v.get("tname_v2"),
        "duration": v.get("duration"),
        "pubdate": v.get("pubdate"),
        "owner": (v.get("owner") or {}).get("name"),
        "stat": v.get("stat"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["meta", "full", "bv"], default="meta")
    ap.add_argument("--source", choices=["popular", "ranking"], default="popular")
    ap.add_argument("--pages", type=int, default=3)
    ap.add_argument("--rid", type=int, default=0)
    ap.add_argument("--comment", type=int, default=20)
    ap.add_argument("--gap", type=float, default=1.2)
    ap.add_argument("--limit", type=int, default=0, help="处理上限，0=不限")
    ap.add_argument("--cookie-file", default="cookie.txt")
    ap.add_argument("--outdir", default="./data")
    ap.add_argument("--bv-file", default="")
    args = ap.parse_args()

    cookie = ""
    if os.path.exists(args.cookie_file):
        cookie = Path(args.cookie_file).read_text(encoding="utf-8").strip()
        if cookie:
            print("已加载 cookie（%d 字节）" % len(cookie))
    if not cookie:
        print("!! 未发现 cookie.txt —— 字幕会全部为空（实测行为，不是 bug）")

    c = Client(cookie=cookie, gap=args.gap, outdir=args.outdir)
    outdir = Path(args.outdir)
    done_file = outdir / "done.txt"
    done = set(done_file.read_text(encoding="utf-8").split()) if done_file.exists() else set()
    print("已完成（断点）：%d 条" % len(done))

    # 阶段1：元数据
    if args.mode == "bv" and args.bv_file:
        bvs = [x.strip() for x in Path(args.bv_file).read_text(encoding="utf-8").split() if x.strip()]
        print("从 %s 读入 %d 个 BV" % (args.bv_file, len(bvs)))
        targets = []
        for b in bvs:
            if b in done:
                continue
            # 没有元数据时从 ranking 里补，或用 view（可能 412）；先留空
            targets.append({"bvid": b, "aid": None, "cid": None})
    elif args.mode == "meta":
        targets = [slim(v) for v in c.feed(args.source, args.rid, args.pages)]
        with open(outdir / "meta.jsonl", "a", encoding="utf-8") as f:
            for t in targets:
                f.write(json.dumps(t, ensure_ascii=False) + "\n")
        print("\n元数据落盘 meta.jsonl：%d 条（本次调用 %d 次）" % (len(targets), c.calls))
        return 0
    else:
        targets = [slim(v) for v in c.feed(args.source, args.rid, args.pages)]

    if args.limit:
        targets = [t for t in targets if t["bvid"] not in done][: args.limit]
    else:
        targets = [t for t in targets if t["bvid"] not in done]

    print("待处理：%d 条\n" % len(targets))
    ok = no_sub = 0
    try:
        for i, t in enumerate(targets, 1):
            rec = dict(t)
            if args.mode == "full" and t.get("cid"):
                subs, trace = c.subtitles(t["bvid"], t["cid"])
                rec["subtitle_trace"] = trace
                rec["subtitles"] = subs
                if subs:
                    ok += 1
                    print("[%d/%d] %s 字幕 %d 轨 / %d 行" %
                          (i, len(targets), t["bvid"], len(subs), sum(s["n"] for s in subs)))
                else:
                    no_sub += 1
                    print("[%d/%d] %s 无字幕 (%s)" % (i, len(targets), t["bvid"], trace))
                if args.comment and t.get("aid"):
                    cm, ctrace = c.comments(t["aid"], args.comment)
                    rec["comments"] = cm
                    rec["comment_trace"] = ctrace
                    print("        评论 %d 条 (%s)" % (len(cm), ctrace))
            with open(outdir / "items.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            with open(done_file, "a", encoding="utf-8") as f:
                f.write(t["bvid"] + "\n")
    except RiskStop as e:
        print("\n[停止] %s" % e)
    except KeyboardInterrupt:
        print("\n[中断] 已完成的条目已落盘，重跑会自动续")

    print("\n==== 汇总 ====")
    print("接口调用 %d 次 | 风控命中 %d 次" % (c.calls, c.risk_hits))
    print("有字幕 %d / 无字幕 %d" % (ok, no_sub))
    print("产出：%s/items.jsonl" % outdir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
