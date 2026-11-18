/**
 * 抽帧 + 视觉模型读画面 —— 从 index.js 的 registerTools 里拆出来。
 *
 * 拆分依据是 Prisma 的模块化重构指南 Phase 2：纯函数层稳定之后，按功能域拆。
 * 这个模块只依赖 deps 里传进来的东西，不 import 任何项目内部文件。
 */
export function registerFrames(ctx, deps) {
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
      name: 'bili_frames',
      description:
        'Look at what is actually on screen in a Bilibili video. Downloads the lowest-bitrate video ' +
        'track, extracts frames, and has a vision model describe each one with a timestamp. ' +
        'Subtitles only carry what the uploader said; this carries what was shown: slides, code on ' +
        'screen, UI states, gameplay, physical demonstrations. Use it when the request depends on ' +
        'visual content that a transcript cannot describe. Each frame costs one vision call, so keep ' +
        'maxFrames small and raise it only when the first pass misses something.',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV id, e.g. BV1fAZtYoEnW.' },
          maxFrames: {
            type: 'integer',
            description: 'How many distinct frames to look at. Default 8, maximum 16. One vision call per frame.',
          },
          interval: {
            type: 'integer',
            description: 'Seconds between sampled frames. Omit to derive it from duration and maxFrames.',
          },
          prompt: {
            type: 'string',
            description:
              'What the vision model should pull out, e.g. "只读屏幕上的代码和终端输出". Defaults to a general scene description.',
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
            frames: { type: 'integer' },
            markdown: { type: 'string' },
            log: { type: 'string' },
            note: { type: 'string' },
          },
        },
        render(args, value) {
          if (!value?.ok) return textBlock(`bili_frames 失败：${value?.note || '未知原因'}`)
          return textBlock(
            `${value.bvid}：看了 ${value.frames} 帧\n\n${value.markdown}${value.log ? `\n\n---\n${value.log}` : ''}`,
          )
        },
      },
      async execute(args) {
        const s = await loadSettings()
        const bvid = String(args.bvid || '').trim()
        if (!/^BV[0-9A-Za-z]+$/.test(bvid)) {
          return { ok: false, bvid, note: 'invalid bvid', frames: 0, markdown: '' }
        }
        const meta = await getCid(bvid, { cookie: s.cookie || '', gapMs: 400 })
        if (!meta?.cid) {
          return { ok: false, bvid, note: '取不到 cid，可能视频不存在或接口被拦', frames: 0, markdown: '' }
        }
        let ff
        try {
          ff = await ensureFfmpeg()
        } catch (err) {
          return {
            ok: false,
            bvid,
            frames: 0,
            markdown: '',
            note: `需要 ffmpeg 但没准备好：${String(err).slice(0, 200)}`,
          }
        }
        const r = await readFrames(bvid, meta.cid, meta.duration, s, {
          maxFrames: args.maxFrames,
          interval: args.interval,
          prompt: args.prompt,
          ffmpegPath: ff.path,
        })
        return { ...r, bvid, ffmpeg: ff.path, ffmpegDownloaded: ff.downloaded }
      },
    }),
  )
}
