/**
 * Frame path, pure Node: download the lowest-bitrate video track, extract frames
 * with ffmpeg, and have a vision model describe each one.
 *
 * Frame selection uses ffmpeg's scene detector rather than a perceptual hash.
 * A hash would need image decoding, which Node has no built-in for; scene
 * detection gives the same benefit (near-identical frames are never emitted)
 * using the tool we already have. When a video barely changes, the detector
 * returns too few frames, so we fall back to even sampling at computed offsets.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { candidateUrls, fetchBytes, pickStream, resolvePlayurl } from './net.js'

const run = promisify(execFile)

const DEFAULT_PROMPT =
  '用一到两句中文描述这张视频画面：场景、人物或物体在做什么、屏幕上出现的文字或界面元素。' +
  '只描述看得见的，不要推测剧情或意图。'

function visionConfig(settings) {
  const fromSettings = (settings && settings.visionKey) || ''
  const fromEnv = process.env.SILICONFLOW_API_KEY || ''
  let key = fromSettings || fromEnv
  let base = ((settings && settings.visionBase) || 'https://api.siliconflow.cn/v1').replace(/\/$/, '')
  let model = (settings && settings.visionModel) || 'Qwen/Qwen3-VL-30B-A3B-Instruct'

  // 没配就白捡 modlens 的配置，省掉用户再填一遍 key
  if (!key) {
    try {
      const p = path.join(homedir(), '.modlens', 'config.json')
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, 'utf8'))
        const prov = (j.providers || {}).openai || {}
        if (prov.apiKey) {
          key = prov.apiKey
          base = (prov.baseUrl || base).replace(/\/$/, '')
          model = prov.model || model
        }
      }
    } catch {
      /* 读不到就不用 */
    }
  }
  return { key, base, model }
}

async function describeFrame(buf, cfg, prompt, maxTokens = 220) {
  const payload = {
    model: cfg.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } },
          { type: 'text', text: prompt },
        ],
      },
    ],
    max_tokens: maxTokens,
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 180000)
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`vision HTTP ${res.status}: ${text.slice(0, 160)}`)
    const d = JSON.parse(text)
    return String(d?.choices?.[0]?.message?.content || '').trim()
  } finally {
    clearTimeout(timer)
  }
}

/** 从 ffmpeg 的 showinfo 输出里按顺序取出每个选中帧的时间戳。 */
function parseSceneTimes(stderr) {
  const out = []
  const re = /pts_time:\s*([0-9.]+)/g
  let m
  while ((m = re.exec(stderr || '')) !== null) {
    const t = Number(m[1])
    if (Number.isFinite(t)) out.push(t)
  }
  return out
}

async function extractFrames(ffmpeg, videoPath, dir, maxFrames, width, duration) {
  await mkdir(dir, { recursive: true })
  const pattern = path.join(dir, 'f_%04d.jpg')

  // 第一轮：场景切换点。画面不变时不会重复抽帧，天然完成去重。
  const sceneArgs = [
    '-hide_banner',
    '-i',
    videoPath,
    '-vf',
    `select='gt(scene,0.22)',showinfo,scale=${width}:-2`,
    '-vsync',
    'vfr',
    '-frames:v',
    String(maxFrames),
    '-q:v',
    '4',
    pattern,
  ]
  let stderr = ''
  try {
    const r = await run(ffmpeg, sceneArgs, { timeout: 300000, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
    stderr = String(r.stderr || '')
  } catch (err) {
    stderr = String((err && err.stderr) || '')
  }
  let files = (await readdir(dir)).filter((f) => f.startsWith('f_') && f.endsWith('.jpg')).sort()
  let times = parseSceneTimes(stderr).slice(0, files.length)

  // 场景太少（静态画面、PPT 翻页慢）→ 均匀补
  if (files.length < Math.max(1, Math.ceil(maxFrames / 2))) {
    for (const f of files) await rm(path.join(dir, f), { force: true })
    const interval = Math.max(2, Math.ceil((duration || maxFrames * 5) / maxFrames))
    const evenArgs = [
      '-hide_banner',
      '-i',
      videoPath,
      '-vf',
      `fps=1/${interval},scale=${width}:-2`,
      '-frames:v',
      String(maxFrames),
      '-q:v',
      '4',
      pattern,
    ]
    try {
      await run(ffmpeg, evenArgs, { timeout: 300000, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
    } catch {
      /* 抽不出来就保持空 */
    }
    files = (await readdir(dir)).filter((f) => f.startsWith('f_') && f.endsWith('.jpg')).sort()
    times = files.map((_, i) => i * interval)
  }

  return files.map((f, i) => ({ file: path.join(dir, f), at: Math.round(times[i] ?? i * 5) }))
}

/**
 * 主流程。返回 { ok, frames, markdown, log }。
 * settings 与插件共享：mode / endpoint / cookie / visionKey / visionModel。
 */
export async function readFrames(bvid, cid, duration, settings, opts = {}) {
  const maxFrames = Math.min(Math.max(Number(opts.maxFrames) || 8, 1), 16)
  const width = Math.min(Math.max(Number(opts.width) || 640, 320), 1280)
  const prompt = String(opts.prompt || DEFAULT_PROMPT)
  const maxTokens = Math.min(Math.max(Number(opts.maxTokens) || 220, 80), 600)
  const log = []

  const { dash, trail } = await resolvePlayurl(bvid, cid, settings)
  log.push(`直链：${trail.join(' / ') || '无'}`)
  if (!dash) return { ok: false, frames: 0, markdown: '', log: log.join('\n'), note: '取不到视频直链' }

  const stream = pickStream(dash, 'video', true)
  const urls = candidateUrls(stream)
  log.push(`候选地址 ${urls.length} 个`)
  const { data, url } = await fetchBytes(urls, { timeout: 180000 })
  log.push(`下载 ${(data.length / 1048576).toFixed(2)} MB（${new URL(url).host}）`)

  const work = path.join(homedir(), '.dsh-bili-learn', 'tmp', `${bvid}-${Date.now()}`)
  await mkdir(work, { recursive: true })
  const videoPath = path.join(work, 'src.m4s')
  await writeFile(videoPath, data)

  const cfg = visionConfig(settings)
  if (!cfg.key) {
    await rm(work, { recursive: true, force: true })
    return {
      ok: false,
      frames: 0,
      markdown: '',
      log: log.join('\n'),
      note: '没有视觉模型 key。可在面板配置，或设置环境变量 SILICONFLOW_API_KEY。',
    }
  }

  const shots = await extractFrames(opts.ffmpegPath, videoPath, work, maxFrames, width, duration)
  log.push(`抽到 ${shots.length} 帧`)
  if (!shots.length) {
    await rm(work, { recursive: true, force: true })
    return { ok: false, frames: 0, markdown: '', log: log.join('\n'), note: '没能抽出画面' }
  }

  const blocks = [`## 画面`, '', `共 ${shots.length} 帧（${cfg.model}）`, '']
  for (const shot of shots) {
    const buf = await readFile(shot.file)
    let text
    try {
      text = await describeFrame(buf, cfg, prompt, maxTokens)
    } catch (err) {
      text = `<视觉模型失败：${String(err).slice(0, 120)}>`
    }
    const mm = String(Math.floor(shot.at / 60)).padStart(2, '0')
    const ss = String(shot.at % 60).padStart(2, '0')
    blocks.push(`### [${mm}:${ss}]`, '', text, '')
  }

  await rm(work, { recursive: true, force: true })
  return { ok: true, frames: shots.length, markdown: blocks.join('\n'), log: log.join('\n') }
}
