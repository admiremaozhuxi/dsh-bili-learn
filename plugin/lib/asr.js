/**
 * Audio transcription, pure Node — the last piece that used to need Python.
 *
 * Subtitles only exist for about one video in nine, so when they are missing the
 * audio track is the only way to the spoken content. playurl gives that track
 * without a login, and Node's built-in FormData/Blob can post it straight to an
 * OpenAI-compatible transcription endpoint.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { candidateUrls, fetchBytes, pickStream, resolvePlayurl } from './net.js'

const DEFAULT_BASE = 'https://api.siliconflow.cn/v1'
const DEFAULT_MODEL = 'FunAudioLLM/SenseVoiceSmall'
const MAX_BYTES = 24 * 1024 * 1024 // 多数端点上限 25MB，留点余量

function asrConfig(settings) {
  let key = (settings && settings.asrKey) || process.env.SILICONFLOW_API_KEY || ''
  let base = ((settings && settings.asrBase) || DEFAULT_BASE).replace(/\/$/, '')
  let model = (settings && settings.asrModel) || DEFAULT_MODEL

  if (!key) {
    try {
      const p = path.join(homedir(), '.modlens', 'config.json')
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, 'utf8'))
        const prov = (j.providers || {}).openai || {}
        if (prov.apiKey) {
          key = prov.apiKey
          base = (prov.baseUrl || base).replace(/\/$/, '')
        }
      }
    } catch {
      /* 读不到就算了 */
    }
  }
  return { key, base, model }
}

async function transcribe(buf, cfg, mime = 'audio/mp4') {
  const form = new FormData()
  form.append('model', cfg.model)
  form.append('file', new Blob([buf], { type: mime }), 'audio.m4a')

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 600000)
  try {
    const res = await fetch(`${cfg.base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}` },
      body: form,
      signal: ctl.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`ASR HTTP ${res.status}: ${text.slice(0, 200)}`)
    const d = JSON.parse(text)
    return String(d.text || '').trim()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 用音频转写拿到口播内容。
 * 返回 { ok, text, seconds, log, note }。
 */
export async function transcribeAudio(bvid, cid, settings, opts = {}) {
  const log = []
  const { dash, trail } = await resolvePlayurl(bvid, cid, settings)
  log.push(`直链：${trail.join(' / ') || '无'}`)
  if (!dash) return { ok: false, text: '', log: log.join('\n'), note: '取不到视频直链' }

  const stream = pickStream(dash, 'audio', false) // 要最高码率，转写别丢细节
  if (!stream) return { ok: false, text: '', log: log.join('\n'), note: '这条视频没有音频轨' }

  const urls = candidateUrls(stream)
  log.push(`音频候选 ${urls.length} 个`)
  const { data } = await fetchBytes(urls, { timeout: 300000 })
  log.push(`下载 ${(data.length / 1048576).toFixed(2)} MB`)

  if (data.length > MAX_BYTES) {
    return {
      ok: false,
      text: '',
      log: log.join('\n'),
      note: `音频 ${(data.length / 1048576).toFixed(1)} MB 超过转写接口上限，换个短一点的视频试试`,
    }
  }

  const cfg = asrConfig(settings)
  if (!cfg.key) {
    return {
      ok: false,
      text: '',
      log: log.join('\n'),
      note: '没有转写用的 key。面板可配置，或设置环境变量 SILICONFLOW_API_KEY。',
    }
  }

  const t0 = Date.now()
  try {
    const text = await transcribe(data, cfg)
    const seconds = Math.round((Date.now() - t0) / 1000)
    log.push(`转写 ${text.length} 字 / ${seconds}s（${cfg.model}）`)
    if (!text) return { ok: false, text: '', log: log.join('\n'), note: '转写结果为空' }
    return { ok: true, text, seconds, log: log.join('\n') }
  } catch (err) {
    return { ok: false, text: '', log: log.join('\n'), note: String(err).slice(0, 200) }
  }
}
