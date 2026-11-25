/**
 * bili_search —— 按条件挑视频，出一张候选表（0.3.0 新增）。
 *
 * 和 bili_learn 的分工：
 *   bili_learn 是「读进去」——搜完直接抓字幕、派子 agent 研读，搜索只是它的第一步；
 *   bili_search 是「先看清楚」——只搜不读，按条件筛完把候选表交给你挑，
 *   想看哪条再用 bili_watch / bili_transcribe / bili_frames 去读。
 *
 * 这样拆的理由：搜索很便宜（一次几十条），读很贵（字幕/转写/抽帧）。
 * 先挑后读，能省掉大量不必要的读取。
 */
export function registerSearch(ctx, deps) {
  const { loadSettings, searchVideos, textBlock } = deps

  /** B 站的播放量可能是 "12.3万" 这种；统一成数字再比较 */
  function toCount(value) {
    const s = String(value === undefined || value === null ? '' : value).trim()
    if (!s) return 0
    if (s.includes('亿')) return Math.round(parseFloat(s) * 1e8)
    if (s.includes('万')) return Math.round(parseFloat(s) * 1e4)
    const n = Number(s.replace(/[^\d.]/g, ''))
    return Number.isFinite(n) ? n : 0
  }

  /** "12:34" / "1:02:03" → 秒 */
  function toSeconds(value) {
    const parts = String(value || '').split(':').map((x) => Number(x))
    if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0
    if (parts.length === 2) return parts[0] * 60 + parts[1]
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return 0
  }

  function clock(sec) {
    const m = Math.floor(sec / 60)
    const s = Math.round(sec % 60)
    return m + ':' + String(s).padStart(2, '0')
  }

  function dateOf(unix) {
    const n = Number(unix) || 0
    if (!n) return '未知'
    const d = new Date(n * 1000)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return d.getFullYear() + '-' + mm + '-' + dd
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'bili_search',
      description:
        'Search Bilibili and hand back a filtered candidate table — search only, it does not read anything. ' +
        'Use it when you want to see what is out there before spending tokens: pick by recency, play count, ' +
        'duration band, exclusion words and per-uploader cap, then read the ones you chose with bili_watch / ' +
        'bili_transcribe / bili_frames. Separate multiple phrasings with " | " (max 4).',
      parameters: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: 'What to search. Several phrasings are allowed, separated by " | " (max 4).',
          },
          days: {
            type: 'integer',
            description: 'Only keep videos published within the last N days. 0 = no limit (default 0).',
          },
          minPlay: {
            type: 'integer',
            description: 'Drop anything below this play count. Default 0.',
          },
          durationMin: {
            type: 'number',
            description: 'Minimum duration in minutes. 0 = no lower bound.',
          },
          durationMax: {
            type: 'number',
            description: 'Maximum duration in minutes. 0 = no upper bound.',
          },
          exclude: {
            type: 'string',
            description: 'Space separated words; a video is dropped if its title or uploader contains any of them.',
          },
          upCap: {
            type: 'integer',
            description: 'At most this many videos from the same uploader. Default 3.',
          },
          limit: {
            type: 'integer',
            description: 'How many rows to return. Default 20, max 50.',
          },
          pages: {
            type: 'integer',
            description: 'Pages to fetch per phrasing (20 results each). Default 2, max 5.',
          },
          order: {
            type: 'string',
            description: 'How Bilibili should sort: click (play count, default), pubdate (newest), dm, stow.',
          },
        },
        required: ['keyword'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            items: { type: 'array', items: { type: 'object' } },
            sampled: { type: 'integer' },
            kept: { type: 'integer' },
            dropped: { type: 'integer' },
            phrases: { type: 'array', items: { type: 'string' } },
            note: { type: 'string' },
          },
        },
        render(args, value) {
          if (!value) return textBlock('bili_search 无返回')
          if (!value.ok) return textBlock('没有结果：' + (value.note || '未知原因'))
          const rows = value.items || []
          if (!rows.length) return textBlock('筛完一条都没剩。' + (value.note ? '\n' + value.note : ''))
          const lines = [
            '取样 ' + value.sampled + ' 条 → 筛完剩 ' + value.kept + ' 条（淘汰 ' + value.dropped + '）',
            '条件：' + (value.note || '默认'),
            '',
          ]
          rows.forEach((r, i) => {
            lines.push(
              String(i + 1).padStart(2, ' ') + '. ' + r.title +
                '  ·  ' + (r.playText || '0') + ' 播放  ·  ' + r.durationText + '  ·  ' + r.pubdateText,
            )
            lines.push('     UP：' + r.author + '   https://www.bilibili.com/video/' + r.bvid)
          })
          return textBlock(lines.join('\n'))
        },
      },
      async execute(args) {
        const settings = await loadSettings()
        const opts = { cookie: settings.cookie || '', gapMs: Math.max(300, Number(settings.gapMs) || 1200) }
        const phrases = String(args.keyword || '')
          .split(/[\n|｜;；]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 4)
        if (!phrases.length) return { ok: false, items: [], sampled: 0, kept: 0, dropped: 0, phrases: [], note: 'keyword 为空' }

        const orderRaw = String(args.order || '').trim().toLowerCase()
        const allowed = ['totalrank', 'click', 'pubdate', 'dm', 'stow']
        const explicitOrder = allowed.includes(orderRaw) ? orderRaw : ''
        // 服务端综合排序就是「不传 order」。它比单纯 click / pubdate 都更稳：
        // 只按播放排序会把新内容压死；只按发布时间排序又全是刚发几分钟、播放必然很低的。
        const order = !explicitOrder || explicitOrder === 'totalrank' ? undefined : explicitOrder
        // 带天数筛选时要多抓几页：综合排序里"既新又热"的条目分散在若干页，
        // 只抓一页再按时间过滤，很容易筛完什么都不剩。
        const days = Math.max(0, Number(args.days) || 0)
        const defaultPages = days > 0 ? 3 : 2
        const pages = Math.min(Math.max(Number(args.pages) || defaultPages, 1), 5)
        const minPlay = Math.max(0, Number(args.minPlay) || 0)
        const dMin = Math.max(0, Number(args.durationMin) || 0) * 60
        const dMax = Math.max(0, Number(args.durationMax) || 0) * 60
        const upCap = Math.max(1, Number(args.upCap) || 3)
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50)
        const words = String(args.exclude || '')
          .split(/[\s,，]+/)
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)

        const pool = new Map()
        const errors = []
        for (const phrase of phrases) {
          for (let page = 1; page <= pages; page += 1) {
            const r = await searchVideos(phrase, { ...opts, order, page })
            if (r.error) {
              errors.push(phrase + ' p' + page + ': ' + r.error)
              break
            }
            for (const it of r.items || []) {
              if (!it.bvid || pool.has(it.bvid)) continue
              pool.set(it.bvid, {
                bvid: it.bvid,
                title: it.title,
                author: it.author,
                playNum: toCount(it.play),
                playText: String(it.play === undefined || it.play === null ? '0' : it.play),
                durSec: toSeconds(it.duration),
                durationText: it.duration || '-',
                pubdate: Number(it.pubdate) || 0,
                pubdateText: dateOf(it.pubdate),
                desc: it.desc || '',
              })
            }
            if ((r.items || []).length < 20) break
          }
        }

        const all = [...pool.values()]
        const sampled = all.length
        const cutoff = days > 0 ? Math.floor(Date.now() / 1000) - days * 86400 : 0
        const kept = []
        const perUp = new Map()
        for (const it of all) {
          if (cutoff && it.pubdate && it.pubdate < cutoff) continue
          if (minPlay && it.playNum < minPlay) continue
          if (dMin && it.durSec && it.durSec < dMin) continue
          if (dMax && it.durSec && it.durSec > dMax) continue
          if (words.length) {
            const hay = (it.title + ' ' + it.author).toLowerCase()
            if (words.some((w) => hay.includes(w))) continue
          }
          const used = perUp.get(it.author) || 0
          if (used >= upCap) continue
          perUp.set(it.author, used + 1)
          kept.push(it)
        }

        kept.sort((a, b) => (order === 'pubdate' ? b.pubdate - a.pubdate : b.playNum - a.playNum))
        const items = kept.slice(0, limit)

        const noteBits = []
        if (days) noteBits.push('最近 ' + days + ' 天')
        if (minPlay) noteBits.push('播放 ≥ ' + minPlay)
        if (dMin) noteBits.push('时长 ≥ ' + dMin / 60 + ' 分钟')
        if (dMax) noteBits.push('时长 ≤ ' + dMax / 60 + ' 分钟')
        if (words.length) noteBits.push('排除 ' + words.join('/'))
        noteBits.push('同 UP ≤ ' + upCap, '排序 ' + (order || '综合'))
        if (days > 0 && !Number(args.pages)) noteBits.push('为凑够近期结果多抓了页')
        if (errors.length) noteBits.push('部分失败：' + errors.slice(0, 2).join('; '))

        return {
          ok: true,
          items,
          sampled,
          kept: kept.length,
          dropped: sampled - kept.length,
          phrases,
          note: noteBits.join(' · '),
        }
      },
    }),
  )
}
