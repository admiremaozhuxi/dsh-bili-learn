/**
 * 分P 清单与系列信息 —— 从 index.js 的 registerTools 里拆出来。
 *
 * 拆分依据是 Prisma 的模块化重构指南 Phase 2：纯函数层稳定之后，按功能域拆。
 * 这个模块只依赖 deps 里传进来的东西，不 import 任何项目内部文件。
 */
export function registerSeries(ctx, deps) {
  const {
    loadSettings, saveSettings, harvest, effectiveSources, probeAll, sourceState,
    getJson, getCid, getParts, getViewMeta, getUpStat, getSubtitles, getComments,
    getCommentReplies, toMarkdown, textBlock, splitSegments, agentsFor, resultText,
    transcribeAudio, readFrames, ensureFfmpeg, startQrLogin, pollQrLogin,
    SETTINGS_FILE, HARVEST_ROOT, SETTING_SPECS, NUMERIC_SPECS, DEFAULT_SETTINGS,
    checkNumber, readPlanSummary, selfHealth, API,
  } = deps

  ctx.effect(() =>
    ctx.tools.register({
      name: 'bili_series',
      description:
        'List every part of a multi-part video. Courses and tutorial series often have dozens to hundreds of ' +
        'parts — without this you only ever read part one. Returns each part with its page number, cid, title ' +
        'and duration, plus the uploader profile and the whole-video stats. Optionally probes the first few ' +
        'parts for subtitles, since the subtitle endpoint is per-part. Use it before studying a course so you ' +
        'can pick which parts are worth the tokens instead of fetching everything.',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV id of any part of the series.' },
          probeSubtitles: {
            type: 'integer',
            description:
              'Check the first N parts for a subtitle track. Default 0 (list only). Each part costs one request.',
          },
        },
        required: ['bvid'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            bvid: { type: 'string' },
            title: { type: 'string' },
            owner: { type: 'object' },
            stat: { type: 'object' },
            partCount: { type: 'integer' },
            totalDuration: { type: 'integer' },
            subtitled: { type: 'integer' },
            parts: { type: 'array', items: { type: 'object' } },
            note: { type: 'string' },
          },
        },
        render(args, value) {
          if (!value?.ok) return textBlock(`bili_series 失败：${value?.note || '未知原因'}`)
          const o = value.owner || {}
          const st = value.stat || {}
          const lines = [
            `${value.title}  ·  ${value.partCount} 个分P  ·  总时长 ${Math.round((value.totalDuration || 0) / 60)} 分钟`,
            `UP：${o.name || '-'}（粉丝 ${(o.follower || 0).toLocaleString()}）`,
            `播放 ${(st.view || 0).toLocaleString()} · 弹幕 ${(st.danmaku || 0).toLocaleString()} · 评论 ${(st.reply || 0).toLocaleString()}`,
            '',
          ]
          for (const p of (value.parts || []).slice(0, 40)) {
            const mm = Math.floor((p.duration || 0) / 60)
            const ss = String((p.duration || 0) % 60).padStart(2, '0')
            const flag = p.hasSubtitle === true ? ' [字幕]' : p.hasSubtitle === false ? ' [无字幕]' : ''
            lines.push(`P${p.page}  ${mm}:${ss}${flag}  ${p.title}`)
          }
          if ((value.parts || []).length > 40) lines.push(`…还有 ${value.parts.length - 40} 个分P`)
          if (value.note) lines.push('', value.note)
          return textBlock(lines.join('\n'))
        },
      },
      async execute(args) {
        const s = await loadSettings()
        const opts = { cookie: s.cookie || '', gapMs: Math.max(300, Number(s.gapMs) || 1200) }
        const bvid = String(args.bvid || '').trim()
        if (!/^BV[0-9A-Za-z]+$/.test(bvid)) {
          return { ok: false, bvid, note: 'invalid bvid', parts: [], partCount: 0 }
        }

        const grabbed = await getParts(bvid, opts)
        if (!grabbed.parts || !grabbed.parts.length) {
          return {
            ok: false,
            bvid,
            note: grabbed.error || '取不到分P清单',
            parts: [],
            partCount: 0,
          }
        }
        const parts = grabbed.parts

        const meta = await getViewMeta(bvid, opts)
        const owner = { name: meta?.owner || '', mid: meta?.ownerMid || 0, follower: 0 }
        if (owner.mid) {
          const upStat = await getUpStat(owner.mid, opts)
          if (upStat) owner.follower = upStat.follower
        }

        // 可选：探测前 N 个 P 有没有字幕
        const probe = Math.min(Math.max(Number(args.probeSubtitles) || 0, 0), 20)
        let subtitled = 0
        if (probe > 0) {
          for (const p of parts.slice(0, probe)) {
            const r = await getSubtitles(bvid, p.cid, opts)
            p.hasSubtitle = r.lines.length > 0
            if (p.hasSubtitle) subtitled += 1
          }
        }

        const totalDuration = parts.reduce((n, p) => n + (p.duration || 0), 0)
        const stat = meta?.stat || {}
        return {
          ok: true,
          bvid,
          title: meta?.title || '',
          owner,
          stat: {
            view: stat.view || 0,
            danmaku: stat.danmaku || 0,
            reply: stat.reply || 0,
            like: stat.like || 0,
            favorite: stat.favorite || 0,
          },
          partCount: parts.length,
          totalDuration,
          subtitled,
          parts,
          note:
            probe > 0
              ? `已探测前 ${probe} 个分P，其中 ${subtitled} 个有字幕。用 bili_watch 加 p 参数抓具体某一集。`
              : '只列清单，未探测字幕。要看某集内容，用 bili_watch 加 p 参数；想知道哪些集有字幕，传 probeSubtitles。',
        }
      },
    }),
  )
}
