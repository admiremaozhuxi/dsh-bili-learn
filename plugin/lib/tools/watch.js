/**
 * 单条视频深度抓取 —— 从 index.js 的 registerTools 里拆出来。
 *
 * 拆分依据是 Prisma 的模块化重构指南 Phase 2：纯函数层稳定之后，按功能域拆。
 * 这个模块只依赖 deps 里传进来的东西，不 import 任何项目内部文件。
 */
export function registerWatch(ctx, deps) {
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
      name: 'bili_watch',
      description:
        'Fetch subtitles and top comments for a single Bilibili video by BV id, without searching. ' +
        'Use it when the user names a specific video. Returns the text inline and writes a markdown file.',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV id, e.g. BV15es76gEgL.' },
          p: {
            type: 'integer',
            description:
              '第几 P（分P 序号）。多集课程里指定这一集，默认 1。分P 清单用 bili_series 查。',
          },
          aid: {
            type: 'string',
            description:
              'Optional numeric aid (the av number). Comments need it; a BV id alone cannot resolve ' +
              'comments without the view endpoint, which is risk-blocked.',
          },
          withComments: { type: 'boolean', description: 'Include top comments. Default true.' },
          commentLimit: {
            type: 'integer',
            description: '最多取多少条主评论。默认 20，上限 100。需要登录才能超过 3 条。',
          },
          commentPages: {
            type: 'integer',
            description: '翻几页评论（每页约 20 条）。默认 1，上限 5。页与页之间会自动限速。',
          },
          replyLimit: {
            type: 'integer',
            description: '给前几条「有回复的」主评论再取二级评论。默认 3，传 0 表示不取。',
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
            subtitleLines: { type: 'integer' },
            subtitleTrace: { type: 'string' },
            comments: { type: 'integer' },
            file: { type: 'string' },
            preview: { type: 'string' },
          },
        },
        render(args, value) {
          if (!value?.ok) return textBlock(`bili_watch 失败：${value?.subtitleTrace || '未知原因'}`)
          return textBlock(
            `${value.bvid}：字幕 ${value.subtitleLines} 行（${value.subtitleTrace}），评论 ${value.comments} 条\n` +
              `已写入 ${value.file}\n\n${value.preview || ''}`,
          )
        },
      },
      async execute(args) {
        const settings = await loadSettings()
        const opts = { cookie: settings.cookie || '', gapMs: Math.max(300, Number(settings.gapMs) || 1200) }
        const bvid = String(args.bvid || '').trim()
        if (!/^BV[0-9A-Za-z]+$/.test(bvid)) {
          return { ok: false, bvid, subtitleTrace: 'invalid bvid', subtitleLines: 0, comments: 0 }
        }
        // 分P：一集课程就是多个 P，只取第一个等于读错了集
        const wantPage = Math.max(1, Number(args.p) || 1)
        const grabbed = await getParts(bvid, opts)
        if (!grabbed.parts || !grabbed.parts.length) {
          return {
            ok: false,
            bvid,
            subtitleTrace: grabbed.error || '取不到分P清单',
            subtitleLines: 0,
            comments: 0,
          }
        }
        const target = grabbed.parts.find((x) => x.page === wantPage) || grabbed.parts[0]

        // 评论要 aid；整条视频共用同一个 aid，与第几 P 无关
        const meta = await getViewMeta(bvid, opts)
        const subs = await getSubtitles(bvid, target.cid, opts)
        const aid = meta?.aid || args.aid
        // 翻几页就该给几页的量：只说 commentPages 而没说 commentLimit 时，
        // 上限按页数放大，否则「翻 2 页」会莫名其妙只拿到 20 条。
        const cPages = Math.min(Math.max(Number(args.commentPages) || 1, 1), 5)
        const cLimit = Math.min(Math.max(Number(args.commentLimit) || cPages * 20, 1), 100)

        const comments =
          args.withComments === false
            ? { items: [], trace: 'skipped', pages: 0 }
            : aid
              ? await getComments(aid, opts, { limit: cLimit, maxPages: cPages })
              : { items: [], trace: 'no_aid（登录后可得）', pages: 0 }

        // 二级评论：只对前几条有回复的主评论取，避免请求爆炸
        if (aid && comments.items.length && Number(args.replyLimit) !== 0) {
          const want = Math.min(Math.max(Number(args.replyLimit) || 3, 0), 8)
          let fetched = 0
          for (const c of comments.items) {
            if (fetched >= want) break
            if (!c.replyCount) continue
            const r = await getCommentReplies(aid, c.rpid, opts, { limit: 6 })
            if (r.items.length) {
              c.replies = r.items
              fetched += 1
            }
          }
        }
        await mkdir(HARVEST_ROOT, { recursive: true })
        // 分P 必须进文件名，否则连抓几集只会留下最后一集
        const suffix = wantPage > 1 ? `-P${wantPage}` : ''
        const file = path.join(HARVEST_ROOT, `${bvid}${suffix}.md`)
        await writeFile(
          file,
          toMarkdown({
            bvid,
            title: bvid,
            author: '-',
            play: 0,
            duration: 0,
            desc: '',
            subtitles: subs.lines,
            subtitleTrace: subs.trace,
            comments: comments.items,
            commentTrace: comments.trace,
          }),
          'utf8',
        )
        return {
          ok: true,
          bvid,
          subtitleLines: subs.lines.length,
          subtitleTrace: subs.trace,
          comments: comments.items.length,
          file,
          preview: subs.lines.slice(0, 12).map((l) => l.text).join('\n'),
        }
      },
    }),
  )
}
