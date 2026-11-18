/**
 * 采集 + 派子 agent 研读 —— 从 index.js 的 registerTools 里拆出来。
 *
 * 拆分依据是 Prisma 的模块化重构指南 Phase 2：纯函数层稳定之后，按功能域拆。
 * 这个模块只依赖 deps 里传进来的东西，不 import 任何项目内部文件。
 */
export function registerStudy(ctx, deps) {
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
      name: 'bili_study',
      description:
        'One-shot study pipeline: harvest a topic from Bilibili, then dispatch subagents to read and ' +
        'condense the videos and merge their findings into a single brief. Use it when the user says to ' +
        'learn something from Bilibili AND then do work, so the reading starts without extra turns. ' +
        'NOTE: DSH subagents start immediately and report back asynchronously, so their text usually is ' +
        'not in this call\'s return value. `pending` counts the subagents still running; their results ' +
        'arrive as completion notices afterwards. Every harvest file is also on disk under `dir`, so you ' +
        'can always read them yourself instead of waiting.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'What to learn. Used as the first search keyword.' },
          keywords: { type: 'array', items: { type: 'string' }, description: 'Extra search variants. Max 4.' },
          maxVideos: { type: 'integer', description: 'Videos to study. Default 6, max 20.' },
          focus: {
            type: 'string',
            description:
              'What the reader should extract, e.g. "可落地的工程步骤与踩坑". Becomes the per-video instruction.',
          },
        },
        required: ['topic'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            dir: { type: 'string' },
            count: { type: 'integer' },
            dispatched: { type: 'integer' },
            degraded: { type: 'boolean' },
            pending: { type: 'integer' },
            note: { type: 'string' },
            brief: { type: 'string' },
          },
        },
        render(args, value) {
          if (!value?.ok) return textBlock(`bili_study 失败：${value?.note || '未知原因'}`)
          let head
          if (value.degraded && !value.dispatched) {
            head = `已采集 ${value.count} 条，但子 agent 派发不可用（降级模式）。`
          } else if (value.pending) {
            head =
              `已采集 ${value.count} 条 · ${value.pending} 个子 agent 已启动（结果异步送达）` +
              (value.dispatched ? ` · ${value.dispatched} 个已合并` : '')
          } else {
            head = `已采集 ${value.count} 条，并合并了 ${value.dispatched} 个子 agent 的研读结果。`
          }
          return textBlock(`${head}\n目录：${value.dir}\n\n${value.brief || ''}${value.note ? '\n\n' + value.note : ''}`)
        },
      },
      async execute(args, exec) {
        const settings = await loadSettings()
        const r = await harvest({ ...args, withComments: true }, settings)
        if (!r.ok) return r

        const focus = String(args.focus || '核心观点、可复用的具体做法与步骤、踩坑与注意事项、与本主题最相关的结论').trim()

        const clampN = (v, lo, hi, dflt) => {
          const n = Number(v)
          return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : dflt
        }
        const videosAtOnce = clampN(settings.videoConcurrency ?? settings.concurrency, 1, 12, 3)
        const aMin = clampN(settings.agentsPerVideoMin, 1, 8, 2)
        const aMax = Math.max(aMin, clampN(settings.agentsPerVideoMax, 1, 8, 4))
        const pool = clampN(settings.maxTotalAgents, 1, 24, 12)

        const targets = r.videos.slice(0, videosAtOnce)

        // 每个视频按内容量分配若干子 agent，各自读一段。
        // 全部段落进同一个队列，由固定大小的池消费 —— 短片读完它的段落，
        // 那些 worker 立刻接手长片剩下的段落，所以单个视频可以超过 aMax，
        // 但同时在跑的子 agent 数始终不超过 pool。
        const tasks = []
        for (const v of targets) {
          const k = agentsFor(v, aMin, aMax)
          let text = ''
          try {
            text = await readFile(v.file, 'utf8')
          } catch {
            text = ''
          }
          const segs = text ? splitSegments(text, k) : [null]
          segs.forEach((seg, i) => {
            tasks.push({ v, seg, idx: i + 1, total: segs.length })
          })
        }

        const collected = []
        const activationRuns = [] // 已启动但结果要异步回来的
        let degraded = false
        let degradeReason = ''
        if (!exec?.agent) {
          degraded = true
          degradeReason = '当前调用没有 agent 上下文，无法派发子 agent。'
        } else {
          let cursor = 0
          const runners = Array.from({ length: Math.max(1, Math.min(pool, tasks.length)) }, async () => {
            for (;;) {
              const mine = cursor
              cursor += 1
              if (mine >= tasks.length) return
              const t = tasks[mine]
              const segNote =
                t.total > 1
                  ? `\n\n注意：这是同一个视频的第 ${t.idx}/${t.total} 段，只提炼这一段里出现的内容，不要补别的段。`
                  : ''
              const prompt =
                `阅读文件：${t.v.file}\n\n` +
                `这是一个 B 站视频的记录（标题、简介、字幕、高赞评论）。主题：${args.topic}。${segNote}\n\n` +
                `请只做提炼，不要复述原文：\n1) 核心观点\n2) 可复用的具体做法 / 步骤 / 命令 / 参数\n` +
                `3) 踩坑与注意事项\n4) 最值得转述的结论\n\n重点：${focus}。\n` +
                `输出 markdown，400 字以内。信息不足就直说，不要编。`
              try {
                const batch = await ctx.tools.execute({
                  calls: [
                    {
                      type: 'tool-call',
                      id: `bili-study-${t.v.bvid}-${t.idx}`,
                      name: 'subagent',
                      arguments: JSON.stringify({
                        description: `研读 ${t.v.bvid}${t.total > 1 ? ` 第${t.idx}段` : ''}`,
                        prompt,
                      }),
                    },
                  ],
                  signal: exec.signal,
                  agent: exec.agent,
                })
                // ctx.tools.execute 的每一项是 { callId, result }，真正的工具
                // 返回值在 result 里。不解包的话下面所有判断都作用在外层对象上，
                // 最终落到 JSON.stringify，把整个响应当成正文塞进简报。
                const raw = batch?.results?.[0]
                const payload = raw?.result !== undefined ? raw.result : raw
                // DSH 的 subagent 是「启动即返回、结果异步送达」，拿到的往往是
                // activation 而不是正文，识别出来单独计数。
                const isActivation =
                  payload?.value?.kind === 'activation' ||
                  payload?.meta?.kind === 'activation' ||
                  /^started subagent/.test(String(payload?.value?.name || ''))
                if (isActivation) {
                  activationRuns.push(t.v.bvid)
                  continue
                }
                const text = resultText(payload)
                if (payload?.isError || !text.trim()) {
                  degraded = true
                  degradeReason = '有子 agent 返回空结果或被拒绝。'
                  continue
                }
                collected.push({ bvid: t.v.bvid, title: t.v.title, idx: t.idx, read: text })
              } catch (err) {
                degraded = true
                degradeReason = `子 agent 派发失败：${String(err).slice(0, 160)}`
              }
            }
          })
          await Promise.all(runners)
        }

        // 合并：同一个视频的多个段落按顺序拼回去
        const grouped = new Map()
        for (const c of collected.sort((a, b) => a.idx - b.idx)) {
          if (!grouped.has(c.bvid)) grouped.set(c.bvid, { title: c.title, segs: [] })
          grouped.get(c.bvid).segs.push(c.read.trim())
        }
        const dispatched = [...grouped.entries()].map(([bvid, o]) => ({
          bvid,
          title: o.title,
          read: o.segs.join('\n\n'),
          segments: o.segs.length,
        }))

        const parts = []
        for (const d of dispatched) {
          parts.push(
            `## ${d.title}（${d.bvid}）${d.segments > 1 ? ` · ${d.segments} 段` : ''}`,
            '',
            d.read.trim(),
            '',
          )
        }
        const brief = parts.length
          ? parts.join('\n')
          : ''

        // 子 agent 是异步的：派出去之后结果要等通知，这里不可能同步拿到正文。
        // 所以分三种情况说明白，而不是假装已经合并完成。
        let note
        if (activationRuns.length && !dispatched.length) {
          note =
            `已派出 ${activationRuns.length} 个子 agent 研读，但它们的结果要异步回来，` +
            `不会出现在本次返回里。文件都在 ${r.dir}。` +
            `可等它们各自回报后再合并；或直接读取这些文件自己总结。`
        } else if (degraded) {
          note = `${degradeReason} 文件已全部落盘在 ${r.dir}，请直接派子 agent 读取，每个文件一个。`
        } else if (activationRuns.length) {
          note =
            `${dispatched.length} 个视频的研读结果已合并；另有 ${activationRuns.length} 个子 agent ` +
            `仍在后台跑，结果会另行送达。`
        } else {
          note = r.note
        }

        return {
          ok: true,
          dir: r.dir,
          count: r.count,
          dispatched: dispatched.length,
          pending: activationRuns.length,
          degraded,
          brief,
          note,
        }
      },
    }),
  )
}
