#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
自建 B 站解析服务 —— 把本机变成一个「解析源」
================================================
已验证事实（2026-11-18 在真实服务器上实测）：
  * /x/player/playurl（含 wbi 签名）无 cookie 也能返回 dash 直链 → code=0, dash=true
  * 所以「用自己的服务器换直链」完全成立，不需要依赖任何第三方解析站
  * 但同一 IP 约 30 次请求会开始 412，故必须内置限速与退避

接口：
  GET /health
  GET /playurl?bvid=BVxxx&cid=123[&qn=32]
      -> { code, audio:[{id,bandwidth,url}], video:[{id,quality,bandwidth,url}], cached }
  GET /subtitle?bvid=BVxxx&cid=123
      -> 需要 cookie（本服务可选加载 cookie.txt），无 cookie 时返回 trace 说明原因

启动：
  python3 parse_svc.py --port 8848 --gap 1.5
  (可选) --token xxx  则请求必须带 ?token=xxx 或 Header X-Token
"""
import argparse
import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API = "https://api.bilibili.com"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
]
BACKOFF = [45, 180, 600, 1800]

CFG = {"gap": 1.5, "cookie": "", "token": "", "cache_ttl": 600}


class Engine:
    def __init__(self):
        self.mixinkey = None
        self.mixinkey_at = 0
        self.last = 0.0
        self.cache = {}
        self.risk = 0
        self.calls = 0

    def _gap(self):
        dt = time.time() - self.last
        if dt < CFG["gap"]:
            time.sleep(CFG["gap"] - dt)
        self.last = time.time()

    def _headers(self, ref="https://www.bilibili.com/"):
        h = {"User-Agent": UA, "Referer": ref, "Origin": "https://www.bilibili.com",
             "Accept": "application/json, text/plain, */*"}
        if CFG["cookie"]:
            h["Cookie"] = CFG["cookie"]
        return h

    def raw(self, url):
        req = urllib.request.Request(url, headers=self._headers())
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            try:
                return e.code, e.read().decode("utf-8", "replace")
            except Exception:
                return e.code, ""
        except Exception as e:
            return 0, json.dumps({"_err": str(e)[:120]})

    def get(self, path, params, signed=False, depth=0):
        if signed and not self.mixinkey:
            self._keys()
        if signed:
            p = dict(params)
            p["wts"] = int(time.time())
            q = urllib.parse.urlencode(sorted(p.items()))
            p["w_rid"] = hashlib.md5((q + self.mixinkey).encode()).hexdigest()
            url = API + path + "?" + urllib.parse.urlencode(sorted(p.items()))
        else:
            url = API + path + "?" + urllib.parse.urlencode(params)
        self._gap()
        self.calls += 1
        st, tx = self.raw(url)
        if st == 412 or '"code":-412' in tx.replace(" ", ""):
            self.risk += 1
            if depth > 2:
                return {"code": -412, "message": "风控退避用尽"}
            w = BACKOFF[min(self.risk - 1, len(BACKOFF) - 1)]
            print("[risk] 412, sleep %ds" % w, flush=True)
            time.sleep(w)
            return self.get(path, params, signed, depth + 1)
        try:
            return json.loads(tx)
        except Exception:
            if "<html" in tx[:200].lower():
                self.risk += 1
                if depth > 2:
                    return {"code": -412, "message": "HTML 拦截页"}
                time.sleep(BACKOFF[min(self.risk - 1, len(BACKOFF) - 1)])
                return self.get(path, params, signed, depth + 1)
            return {"code": -1, "_raw": tx[:120]}

    def _keys(self):
        d = self.get("/x/web-interface/nav", {})
        if d.get("code") not in (0, -101):
            return
        i = d["data"]["wbi_img"]["img_url"].rsplit("/", 1)[-1].split(".")[0]
        s = d["data"]["wbi_img"]["sub_url"].rsplit("/", 1)[-1].split(".")[0]
        o = i + s
        self.mixinkey = "".join(o[x] for x in MIXIN_TAB)[:32]
        self.mixinkey_at = time.time()

    def playurl(self, bvid, cid, qn=32):
        k = "pu:%s:%s:%s" % (bvid, cid, qn)
        c = self.cache.get(k)
        if c and time.time() - c[0] < CFG["cache_ttl"]:
            return dict(c[1], cached=True)
        d = self.get("/x/player/wbi/playurl",
                     {"bvid": bvid, "cid": cid, "qn": qn, "fnval": 16}, signed=True)
        if d.get("code") != 0:
            out = {"code": d.get("code"), "message": d.get("message")}
            return out
        data = d.get("data") or {}
        dash = data.get("dash") or {}
        audio = [{"id": a.get("id"), "bandwidth": a.get("bandwidth"),
                  "url": a.get("baseUrl") or a.get("base_url")}
                 for a in (dash.get("audio") or [])]
        video = [{"id": v.get("id"), "quality": v.get("height"),
                  "bandwidth": v.get("bandwidth"),
                  "url": v.get("baseUrl") or v.get("base_url")}
                 for v in (dash.get("video") or [])]
        out = {"code": 0, "bvid": bvid, "cid": cid, "cached": False,
               "quality": data.get("quality"), "audio": audio, "video": video}
        self.cache[k] = (time.time(), out)
        return out

    def subtitle(self, bvid, cid):
        d = self.get("/x/player/wbi/v2", {"bvid": bvid, "cid": cid}, signed=True)
        if d.get("code") != 0:
            return {"code": d.get("code"), "message": d.get("message")}
        st = ((d.get("data") or {}).get("subtitle") or {})
        subs = st.get("subtitles") or []
        if not subs:
            return {"code": 0, "subtitles": [],
                    "trace": "empty_allow_submit_%s" % st.get("allow_submit"),
                    "hint": "无 cookie 时 B 站不返回字幕轨（实测），需配置 cookie.txt"}
        got = []
        for s in subs:
            u = s.get("subtitle_url") or ""
            if u.startswith("//"):
                u = "https:" + u
            if not u:
                continue
            _, tx = self.raw(u)
            try:
                body = json.loads(tx).get("body") or []
            except Exception:
                body = []
            got.append({"lan": s.get("lan"), "lan_doc": s.get("lan_doc"),
                        "n": len(body),
                        "lines": [{"from": x.get("from"), "to": x.get("to"),
                                   "text": x.get("content")} for x in body]})
        return {"code": 0, "subtitles": got, "trace": "ok"}


E = Engine()


class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        print("[http] " + (fmt % a), flush=True)

    def _send(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        if CFG["token"]:
            if q.get("token") != CFG["token"] and self.headers.get("X-Token") != CFG["token"]:
                return self._send({"code": 403, "message": "token required"}, 403)
        try:
            if u.path == "/health":
                return self._send({"ok": True, "calls": E.calls, "risk": E.risk,
                                   "cache": len(E.cache),
                                   "mixinkey": bool(E.mixinkey),
                                   "cookie": bool(CFG["cookie"])})
            if u.path == "/playurl":
                bv, cid = q.get("bvid", ""), q.get("cid", "")
                if not bv or not cid:
                    return self._send({"code": 400, "message": "bvid & cid required"}, 400)
                return self._send(E.playurl(bv, cid, int(q.get("qn", 32))))
            if u.path == "/subtitle":
                bv, cid = q.get("bvid", ""), q.get("cid", "")
                if not bv or not cid:
                    return self._send({"code": 400, "message": "bvid & cid required"}, 400)
                return self._send(E.subtitle(bv, cid))
            return self._send({"code": 404, "message": "not found",
                               "routes": ["/health", "/playurl", "/subtitle"]}, 404)
        except Exception as e:
            return self._send({"code": 500, "message": str(e)[:200]}, 500)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8848)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--gap", type=float, default=1.5)
    ap.add_argument("--token", default="")
    ap.add_argument("--cookie-file", default="cookie.txt")
    a = ap.parse_args()
    CFG["gap"] = a.gap
    CFG["token"] = a.token
    try:
        with open(a.cookie_file, encoding="utf-8") as f:
            CFG["cookie"] = f.read().strip()
        if CFG["cookie"]:
            print("已加载 cookie (%d 字节)" % len(CFG["cookie"]), flush=True)
    except FileNotFoundError:
        print("未发现 %s —— /subtitle 会返回空（实测行为）" % a.cookie_file, flush=True)
    srv = ThreadingHTTPServer((a.host, a.port), H)
    print("自建解析服务监听 %s:%d  gap=%.1fs  token=%s"
          % (a.host, a.port, a.gap, "on" if a.token else "off"), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
