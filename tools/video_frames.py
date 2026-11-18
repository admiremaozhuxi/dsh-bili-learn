#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
video_frames.py —— 画面路径：抽帧 + 视觉理解，让 AI 真正「看到」视频。

为什么需要它
------------
字幕只覆盖 UP 主说的话。PPT、代码演示、游戏操作、界面变化都不在字幕里，
而实测字幕覆盖率只有约 11%。画面路径补的正是这块。

实测（2026-11）：43 秒视频 → 最低码率视频轨 0.89 MB → 抽 4 帧 →
Qwen3-VL 准确读出「王者荣耀对战、15 vs 5、8vs6、05:41、伤害 63362」，
这些信息字幕里完全没有。

关键设计
--------
* 用最低码率视频轨，只要看得清就够，省流量也省 token。
* ffmpeg 来自 imageio-ffmpeg 自带二进制，**不需要系统安装 ffmpeg**。
* 均匀抽帧 + 感知哈希去重：静态画面（PPT、代码）不会重复烧 token。
* 帧数由预算决定，不是由时长决定。

用法
----
  python video_frames.py --bvid BV1fAZtYoEnW
  python video_frames.py --bvid BVxxx --max-frames 6 --interval 10
  python video_frames.py --bvid BVxxx --out frames.md --keep-temp
  python video_frames.py --bvid BVxxx --prompt "只读屏幕上的文字和代码"

依赖：imageio-ffmpeg、Pillow；视觉模型走 OpenAI 兼容接口。
"""
import argparse
import base64
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
API = "https://api.bilibili.com"

# 同目录的竞速模块；脚本可能从任意工作目录被调用，所以按自身位置找
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bili_net  # noqa: E402

DEFAULT_PROMPT = (
    "用一到两句中文描述这张视频画面：场景、人物或物体在做什么、"
    "屏幕上出现的文字或界面元素。只描述看得见的，不要推测剧情或意图。"
)


# --------------------------------------------------------------------- basics

def hdr(referer=None):
    h = {
        "User-Agent": UA,
        "Origin": "https://www.bilibili.com",
        "Accept": "application/json, text/plain, */*",
    }
    if referer:
        h["Referer"] = referer
    return h


def get_json(url, referer=None):
    req = urllib.request.Request(url, headers=hdr(referer))
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return {"_http": e.code}
    except Exception as e:  # noqa: BLE001
        return {"_err": str(e)[:150]}


def load_vlm():
    """视觉模型配置：优先 modlens 的 openai provider，其次环境变量。"""
    cands = [
        (os.path.expanduser(r"~\.modlens\config.json"), "modlens"),
        (os.path.expanduser(r"~/.dsh-bili-learn/settings.json"), "settings"),
    ]
    for path, kind in cands:
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                j = json.load(f)
        except Exception:  # noqa: BLE001
            continue
        if kind == "modlens":
            p = (j.get("providers") or {}).get("openai") or {}
            key = (p.get("apiKey") or "").strip()
            if key:
                return (
                    (p.get("baseUrl") or "https://api.siliconflow.cn/v1").rstrip("/"),
                    key,
                    p.get("model") or "Qwen/Qwen3-VL-30B-A3B-Instruct",
                )
        else:
            key = (j.get("visionKey") or "").strip()
            if key:
                return (
                    (j.get("visionBase") or "https://api.siliconflow.cn/v1").rstrip("/"),
                    key,
                    j.get("visionModel") or "Qwen/Qwen3-VL-30B-A3B-Instruct",
                )
    key = os.environ.get("SILICONFLOW_API_KEY", "").strip()
    if key:
        return ("https://api.siliconflow.cn/v1", key, "Qwen/Qwen3-VL-30B-A3B-Instruct")
    raise SystemExit(
        "找不到视觉模型 key。可写入 ~/.modlens/config.json 的 providers.openai.apiKey，\n"
        "或 ~/.dsh-bili-learn/settings.json 的 visionKey，或设置环境变量 SILICONFLOW_API_KEY。"
    )


# ------------------------------------------------------------------ pipeline

def resolve(bvid):
    """返回 (cid, duration_seconds)。pagelist 不需要登录。"""
    d = get_json(f"{API}/x/player/pagelist?bvid={bvid}")
    if d.get("code") != 0:
        return None, 0
    first = (d.get("data") or [None])[0]
    if not first:
        return None, 0
    return first.get("cid"), int(first.get("duration") or 0)


def lowest_video_url(bvid, cid):
    """自建服务器优先；不通时两条直连并行竞速。见 bili_net。"""
    dash, trail = bili_net.resolve(bvid, cid)
    if not dash:
        return None, None, " / ".join(trail)
    v = bili_net.pick_stream(dash, "video", lowest=True)
    if not v:
        return None, None, "no video track"
    log = " / ".join(trail)
    if log:
        print(f"[i] 直链来源 {dash.get('source')}（{log}）", file=sys.stderr)
    return v.get("baseUrl"), v, None


def dhash(img, size=8):
    """感知哈希：用于丢掉几乎相同的相邻帧。"""
    small = img.convert("L").resize((size + 1, size), 1)
    px = list(small.tobytes())  # L 模式下一字节即一像素，比 getdata 更稳
    bits = 0
    for row in range(size):
        for col in range(size):
            left = px[row * (size + 1) + col]
            right = px[row * (size + 1) + col + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return bits


def hamming(a, b):
    return bin(a ^ b).count("1")


def describe_frame(raw, base, key, model, prompt, max_tokens=200):
    b64 = base64.b64encode(raw).decode()
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                    {"type": "text", "text": prompt},
                ],
            }
        ],
        "max_tokens": max_tokens,
    }
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        d = json.loads(r.read().decode("utf-8", "replace"))
    return (d.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bvid", required=True)
    ap.add_argument("--max-frames", type=int, default=10, help="最多看几帧（token 预算）")
    ap.add_argument("--interval", type=int, default=0, help="抽帧间隔秒数，0=按预算自动算")
    ap.add_argument("--width", type=int, default=640, help="帧宽，越小越省 token")
    ap.add_argument("--prompt", default=DEFAULT_PROMPT)
    ap.add_argument("--max-tokens", type=int, default=200)
    ap.add_argument("--out", default="")
    ap.add_argument("--keep-temp", action="store_true")
    args = ap.parse_args()

    try:
        import imageio_ffmpeg
        from PIL import Image
    except ImportError as e:
        raise SystemExit(f"缺少依赖：{e}. 需要 imageio-ffmpeg 与 Pillow")

    ff = imageio_ffmpeg.get_ffmpeg_exe()
    if not os.path.exists(ff):
        raise SystemExit("imageio-ffmpeg 自带的 ffmpeg 不可用")

    bvid = args.bvid.strip()
    cid, duration = resolve(bvid)
    if not cid:
        raise SystemExit(f"{bvid} 取不到 cid")
    print(f"[i] {bvid} 时长 {duration}s", file=sys.stderr)

    url, track, err = lowest_video_url(bvid, cid)
    if not url:
        raise SystemExit(f"取不到视频直链：{err}")
    print(
        f"[i] 视频轨 {track.get('width')}x{track.get('height')} "
        f"bw={track.get('bandwidth')}", file=sys.stderr,
    )

    tmpdir = tempfile.mkdtemp(prefix="biliframes_")
    vpath = os.path.join(tmpdir, "src.m4s")
    try:
        req = urllib.request.Request(url, headers=hdr("https://www.bilibili.com/"))
        with urllib.request.urlopen(req, timeout=180) as r:
            data = r.read()
        with open(vpath, "wb") as f:
            f.write(data)
        print(f"[i] 已下载 {len(data)/1024/1024:.2f} MB", file=sys.stderr)

        # 预算决定间隔：短视频也至少每 2 秒一帧，长视频按预算均分
        interval = args.interval or max(2, (duration + args.max_frames - 1) // max(1, args.max_frames))
        want = min(args.max_frames, max(1, (duration // max(1, interval)) + 1))
        pat = os.path.join(tmpdir, "f_%04d.jpg")
        cmd = [
            ff, "-hide_banner", "-loglevel", "error",
            "-i", vpath,
            "-vf", f"fps=1/{interval},scale={args.width}:-2",
            "-frames:v", str(max(want * 2, want)),
            "-q:v", "4",
            pat,
        ]
        subprocess.run(cmd, check=True, timeout=300)
        files = sorted(f for f in os.listdir(tmpdir) if f.startswith("f_") and f.endswith(".jpg"))
        print(f"[i] 抽出 {len(files)} 帧，间隔 {interval}s，去重前", file=sys.stderr)

        base, key, model = load_vlm()
        print(f"[i] 视觉模型 {model}", file=sys.stderr)

        kept = []          # [(timestamp, path, bytes, size)]
        last_hash = None
        for idx, name in enumerate(files):
            ts = idx * interval
            path = os.path.join(tmpdir, name)
            raw = open(path, "rb").read()
            img = Image.open(io.BytesIO(raw))
            ph = dhash(img)
            if last_hash is not None and hamming(ph, last_hash) <= 2:
                continue  # 和上一帧几乎一样，跳过
            last_hash = ph
            kept.append((ts, path, raw, img.size))
            if len(kept) >= args.max_frames:
                break
        print(f"[i] 去重后保留 {len(kept)} 帧", file=sys.stderr)

        blocks = [f"## 画面\n", f"每 {interval}s 一帧，共 {len(kept)} 帧（{model}）\n"]
        for ts, path, raw, size in kept:
            try:
                txt = describe_frame(raw, base, key, model, args.prompt, args.max_tokens)
            except urllib.error.HTTPError as e:
                txt = f"<视觉模型 HTTP {e.code}>"
            except Exception as e:  # noqa: BLE001
                txt = f"<视觉模型失败: {str(e)[:100]}>"
            mm, ss = divmod(ts, 60)
            label = f"{mm:02d}:{ss:02d}"
            blocks.append(f"### [{label}] {size[0]}x{size[1]}\n\n{txt}\n")
            print(f"  [{label}] {txt[:90]}", file=sys.stderr)

        text = "\n".join(blocks)
        if args.out:
            path = os.path.expanduser(args.out)
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            print(f"[✓] 已写入 {path}", file=sys.stderr)
        else:
            print(text)
        return 0
    finally:
        if not args.keep_temp:
            shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
