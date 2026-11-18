/**
 * 视频检索与批量采集 —— 从 index.js 的 registerTools 里拆出来。
 *
 * 拆分依据是 Prisma 的模块化重构指南 Phase 2：纯函数层稳定之后，按功能域拆。
 * 这个模块只依赖 deps 里传进来的东西，不 import 任何项目内部文件。
 */
export function registerLearn(ctx, deps) {
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
      name: 'bili_learn',
      description:
        'Study a topic from Bilibili before doing the work. Searches videos sorted by play count, ' +
        'harvests subtitles and top comments, and writes one readable markdown file per video. ' +
        'Returns a compact index with absolute file paths. Call it when the user asks to learn how ' +
        'something is done from Bilibili, or wants Bilibili used as a research source. After it ' +
        'returns, read those files in parallel — each video gets several subagents proportional to its length, ' +
        'and the total number running at once is capped — merge what they learned, then do the actual task. ' +
        'Subtitles and comment pages beyond a preview need a login cookie.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'What to learn, in the user\'s words. First search keyword.' },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Extra search phrases, each a full variant of the intent. Max 4.',
          },
          maxVideos: { type: 'integer', description: 'Videos to harvest in full. Default 8, max 20.' },
          maxAttempts: {
            type: 'integer',
            description:
              '最多尝试多少个视频。遇到没有字幕的会跳过并继续找下一个，这个值防止一路试到搜索结果的尽头。' +
              '默认取面板设置（30），必须不小于 maxVideos，上限 60。',
          },
          withComments: { type: 'boolean', description: 'Also fetch top comments. Default true.' },
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
            tried: { type: 'integer' },
            skipped: { type: 'array', items: { type: 'object' } },
            transcribed: { type: 'array', items: { type: 'string' } },
            framed: { type: 'array', items: { type: 'string' } },
            mode: { type: 'string' },
            note: { type: 'string' },
            videos: { type: 'array', items: { type: 'object' } },
          },
        },
        render(args, value) {
          if (!value || value.ok !== true) return textBlock(`bili_learn 失败：${value?.note || '未知原因'}`)
          const lines = [`已采集 ${value.count} 条（取数方式：${value.mode}）`, `落盘目录：${value.dir}`, '']
          for (const v of value.videos || []) {
            lines.push(`- ${v.title} ｜ ${v.play} 播放 ｜ ${v.author} ｜ 字幕 ${v.subtitleLines} 行（${v.subtitleTrace}）｜ 评论 ${v.comments} 条`)
          }
          lines.push('', '建议派子 agent 各读一个文件（并发按面板配置），再合并结论。')
          if (value.note) lines.push('', value.note)
          return textBlock(lines.join('\n'))
        },
      },
      async execute(args) {
        const settings = await loadSettings()
        const r = await harvest(args, settings)
        if (!r.ok) return r
        return {
          ok: true,
          mode: r.mode,
          dir: r.dir,
          count: r.count,
          videos: r.videos,
          note: `${r.note} 每个文件都是独立正文，可并行阅读。`.trim(),
        }
      },
    }),
  )
}
