#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asr_transcribe.py —— 不需要登录的字幕兜底：音频转写。

为什么需要它
------------
实测（2026-11）：B 站字幕接口在无登录态时返回 code=0 但字幕数组为空，
连 ai_status 字段都不给。而 playurl 拿音频直链**不需要登录**。
所以「先拿音频、再转文字」是唯一绕开登录的正文获取路径。

实测数据
--------
31 秒视频 -> 音频 170 KB -> 下载 0.2s -> SenseVoice 转写 39.9s -> 98 字。
转写耗时约为音频时长的 1.3 倍，所以它适合少量关键视频，不适合海量。

用法
----
  python asr_transcribe.py --bvid BV17TZEYPEug
  python asr_transcribe.py --topic "前端工程化" --max-videos 3 --max-duration 300
  python asr_transcribe.py --bvid BVxxx --out D:\\notes\\audio.md

API key 来源（按优先级）：
  1. --api-key 参数
  2. 环境变量 SILICONFLOW_API_KEY
  3. ~/.modlens/config.json 里 providers.openai.apiKey
  4. ~/.dsh-bili-learn/settings.json 里 asrKey
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
API = "https://api.bilibili.com"
DEFAULT_BASE = "https://api.siliconflow.cn/v1"
DEFAULT_MODEL = "FunAudioLLM/SenseVoiceSmall"


def headers(referer=None):
    h = {
        "User-Agent": UA,
        "Origin": "https://www.bilibili.com",
        "Accept": "application/json, text/plain, */*",
    }
    if referer:
        h["Referer"] = referer
    return h


def get_json(url, referer=None):
    req = urllib.request.Request(url, headers=headers(referer))
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return {"_http": e.code, "_body": e.read()[:200].decode("utf-8", "replace")}
    except Exception as e:  # noqa: BLE001
        return {"_err": str(e)[:200]}


def load_key(cli_key: str) -> tuple[str, str]:
    if cli_key:
        return DEFAULT_BASE, cli_key
    env = os.environ.get("SILICONFLOW_API_KEY", "").strip()
    if env:
        return DEFAULT_BASE, env
    for path, getter in (
        (os.path.expanduser(r"~\.modlens\config.json"),
         lambda j: ((j.get("providers") or {}).get("openai") or {})),
        (os.path.expanduser(r"~/.dsh-bili-learn/settings.json"),
         lambda j: {"apiKey": j.get("asrKey") or "", "baseUrl": j.get("asrBase") or DEFAULT_BASE}),
    ):
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                j = json.load(f)
            p = getter(j)
            key = (p.get("apiKey") or "").strip()
            if key:
                return (p.get("baseUrl") or DEFAULT_BASE).rstrip("/"), key
        except Exception:  # noqa: BLE001
            continue
    raise SystemExit(
        "找不到 API key。用 --api-key 传入，或设置环境变量 SILICONFLOW_API_KEY，\n"
        "或写进 ~/.dsh-bili-learn/settings.json 的 asrKey 字段。"
    )


def resolve_meta(bvid: str):
    """Return (cid, duration_seconds). pagelist needs no login."""
    d = get_json(f"{API}/x/player/pagelist?bvid={bvid}")
    if d.get("code") != 0:
        return None, 0
    first = (d.get("data") or [None])[0]
    if not first:
        return None, 0
    return first.get("cid"), first.get("duration") or 0


def audio_url(bvid: str, cid: int):
    d = get_json(
        f"{API}/x/player/playurl?bvid={bvid}&cid={cid}&qn=32&fnval=16",
        referer=f"https://www.bilibili.com/video/{bvid}",
    )
    if d.get("code") != 0:
        return None, f"playurl {d.get('code')} {d.get('message')}"
    dash = (d.get("data") or {}).get("dash") or {}
    audio = dash.get("audio") or []
    if not audio:
        return None, "no audio track"
    # 取码率最高的一条
    audio.sort(key=lambda a: a.get("bandwidth") or 0, reverse=True)
    return audio[0].get("baseUrl"), None


def transcribe(base: str, key: str, data: bytes, model: str, filename: str):
    boundary = "----bili" + uuid.uuid4().hex
    parts = []
    for k, v in {"model": model}.items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
        )
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
        f"Content-Type: audio/mp4\r\n\r\n".encode()
    )
    parts.append(data)
    parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(
        base + "/audio/transcriptions",
        data=body,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def search(keyword: str, max_videos: int, max_duration: int):
    d = get_json(f"{API}/x/web-interface/search/type?search_type=video&keyword={urllib.parse.quote(keyword)}&order=click")
    if d.get("code") != 0:
        # 无签名搜索可能被拦，退化为排行榜
        d = get_json(f"{API}/x/web-interface/ranking/v2?rid=36&type=all")
        if d.get("code") != 0:
            return []
        items = d["data"]["list"]
    else:
        items = d.get("data", {}).get("result") or []
    picked = []
    for v in items:
        dur = v.get("duration") or 0
        if isinstance(dur, str):
            parts = dur.split(":")
            dur = sum(int(x) * (60 ** i) for i, x in enumerate(reversed(parts)))
        if max_duration and dur > max_duration:
            continue
        bvid = v.get("bvid")
        if not bvid:
            continue
        picked.append({"bvid": bvid, "title": v.get("title", ""), "duration": dur})
        if len(picked) >= max_videos:
            break
    return picked


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bvid", default="")
    ap.add_argument("--topic", default="")
    ap.add_argument("--max-videos", type=int, default=1)
    ap.add_argument("--max-duration", type=int, default=600, help="只处理不超过这么多秒的视频")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--api-key", default="")
    ap.add_argument("--out", default="", help="把结果写进这个 markdown 文件")
    args = ap.parse_args()

    if not args.bvid and not args.topic:
        raise SystemExit("至少给一个 --bvid 或 --topic")

    base, key = load_key(args.api_key)

    targets = []
    if args.bvid:
        targets = [{"bvid": args.bvid, "title": args.bvid, "duration": 0}]
    else:
        targets = search(args.topic, args.max_videos, args.max_duration)
        if not targets:
            print("没有找到合适的视频")
            return 1

    blocks = []
    for t in targets:
        bvid = t["bvid"]
        print(f"[*] {bvid}  {t.get('title', '')[:50]}")
        cid, dur = resolve_meta(bvid)
        if not cid:
            print("    ! 取不到 cid，跳过")
            continue
        url, err = audio_url(bvid, cid)
        if not url:
            print(f"    ! {err}")
            continue
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://www.bilibili.com/"})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                data = r.read()
        except Exception as e:  # noqa: BLE001
            print(f"    ! 下载失败: {str(e)[:120]}")
            continue
        print(f"    音频 {len(data)/1024:.0f} KB / {time.time()-t0:.1f}s")
        t1 = time.time()
        try:
            res = transcribe(base, key, data, args.model, f"{bvid}.m4a")
        except urllib.error.HTTPError as e:
            print(f"    ! ASR HTTP {e.code}: {e.read()[:200].decode('utf-8', 'replace')}")
            continue
        except Exception as e:  # noqa: BLE001
            print(f"    ! ASR 失败: {str(e)[:150]}")
            continue
        text = (res.get("text") or "").strip()
        print(f"    转写 {len(text)} 字 / {time.time()-t1:.1f}s")
        blocks.append(
            f"## {t.get('title') or bvid}\n\n- BV: `{bvid}`\n- 时长: {t.get('duration') or dur}s\n"
            f"- 链接: https://www.bilibili.com/video/{bvid}\n- 来源: 音频转写（{args.model}）\n\n{text}\n"
        )

    if not blocks:
        print("没有产出")
        return 1

    out = "\n".join(blocks)
    if args.out:
        path = os.path.expanduser(args.out)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(out)
        print(f"\n[✓] 已写入 {path}")
    else:
        print("\n" + "-" * 50)
        print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
