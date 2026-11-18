/**
 * 音频转写 —— 从 index.js 的 registerTools 里拆出来。
 *
 * 拆分依据是 Prisma 的模块化重构指南 Phase 2：纯函数层稳定之后，按功能域拆。
 * 这个模块只依赖 deps 里传进来的东西，不 import 任何项目内部文件。
 */
export function registerTranscribe(ctx, deps) {
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
      name: 'bili_transcribe',
      description:
        'Turn the spoken audio of a video into text, without a login. Use it when the subtitle is missing — ' +
        'only about one video in nine has one — and you need what was actually said. Downloads the audio ' +
        'track and sends it to a speech-to-text endpoint. Costs roughly the audio duration in wall time, ' +
        'so it suits a few key videos rather than a bulk harvest.',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV id, e.g. BV1fAZtYoEnW.' },
        },
        required: ['bvid'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            bvid: { type: 'string' },
            chars: { type: 'integer' },
            seconds: { type: 'integer' },
            text: { type: 'string' },
            file: { type: 'string' },
            log: { type: 'string' },
            note: { type: 'string' },
          },
        },
        render(args, value) {
          if (!value?.ok) return textBlock(`转写失败：${value?.note || '未知原因'}`)
          return textBlock(
            `${value.bvid}：${value.chars} 字 / ${value.seconds}s\n已写入 ${value.file}\n\n${String(value.text || '').slice(0, 1200)}`,
          )
        },
      },
      async execute(args) {
        const s = await loadSettings()
        const bvid = String(args.bvid || '').trim()
        if (!/^BV[0-9A-Za-z]+$/.test(bvid)) {
          return { ok: false, bvid, note: 'invalid bvid', chars: 0, text: '' }
        }
        const meta = await getCid(bvid, { cookie: s.cookie || '', gapMs: 400 })
        if (!meta?.cid) return { ok: false, bvid, note: '取不到 cid', chars: 0, text: '' }

        const r = await transcribeAudio(bvid, meta.cid, s)
        if (!r.ok) return { ok: false, bvid, chars: 0, text: '', log: r.log, note: r.note }

        const dir = path.join(HARVEST_ROOT, `${bvid}-转写`)
        await mkdir(dir, { recursive: true })
        const file = path.join(dir, `${bvid}.md`)
        await writeFile(
          file,
          `# ${bvid}（音频转写）\n\n- 链接: https://www.bilibili.com/video/${bvid}\n- 来源: 音频转写\n\n${r.text}\n`,
          'utf8',
        )
        return {
          ok: true,
          bvid,
          chars: r.text.length,
          seconds: r.seconds,
          text: r.text,
          file,
          log: r.log,
        }
      },
    }),
  )
}
