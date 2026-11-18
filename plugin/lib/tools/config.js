/**
 * 读写设置 —— 从 index.js 的 registerTools 里拆出来。
 *
 * 拆分依据是 Prisma 的模块化重构指南 Phase 2：纯函数层稳定之后，按功能域拆。
 * 这个模块只依赖 deps 里传进来的东西，不 import 任何项目内部文件。
 */
export function registerConfig(ctx, deps) {
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
      name: 'bili_config',
      description:
        'Read or change the Bilibili learner settings: fetch mode, how many videos to read at once, how many ' +
        'subagents each video gets, the total subagent cap, self-hosted endpoint, login cookie, and third-party ' +
        'pool. Call with no arguments to read the current settings.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['default', 'direct', 'self', 'proxy', 'auto'],
            description: 'Fetch strategy.',
          },
          videoConcurrency: {
            type: 'integer',
            description: '同时阅读几个视频。1-12，建议 3 以上以免只看一个来源而片面。',
          },
          agentsPerVideoMin: {
            type: 'integer',
            description: '每个视频至少分配几个子 agent。1-8。',
          },
          agentsPerVideoMax: {
            type: 'integer',
            description:
              '每个视频正常情况下分配几个子 agent（内容长时会超过它，靠别人的空闲 worker 补）。1-8。',
          },
          maxTotalAgents: {
            type: 'integer',
            description: '子 agent 总数硬上限。同时在跑的数量不超过它。1-24。',
          },
          maxAttempts: {
            type: 'integer',
            description: '采集时最多尝试几个视频。没字幕的会跳过继续找，这是硬上限。1-60。',
          },
          fillByTranscribe: {
            type: 'boolean',
            description: '没字幕轨时是否改用音频转写补正文。慢，默认 false。',
          },
          transcribeCap: {
            type: 'integer',
            description: '开启转写后一次最多补几条。0-10。',
          },
          fillByFrames: {
            type: 'boolean',
            description: '没字幕轨时是否抽帧看画面。比转写贵得多（每帧一次视觉调用），默认 false。',
          },
          framesCap: {
            type: 'integer',
            description: '抽帧最多补几条视频。0-10。',
          },
          framesPerVideo: {
            type: 'integer',
            description: '每条视频抽几帧。1-8。',
          },
          fillByFrames: {
            type: 'boolean',
            description: '没字幕轨时是否抽帧看画面。比转写贵得多（每帧一次视觉调用），默认 false。',
          },
          framesCap: {
            type: 'integer',
            description: '抽帧最多补几条视频。0-10。',
          },
          framesPerVideo: {
            type: 'integer',
            description: '每条视频抽几帧。1-8。',
          },
          endpoint: { type: 'string', description: 'Self-hosted parse service base URL.' },
          cookie: { type: 'string', description: 'Bilibili login cookie, normally the SESSDATA pair.' },
          proxies: { type: 'array', items: { type: 'string' }, description: 'Third-party parser base URLs.' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            mode: { type: 'string' },
            videoConcurrency: { type: 'integer' },
            agentsPerVideoMin: { type: 'integer' },
            agentsPerVideoMax: { type: 'integer' },
            maxTotalAgents: { type: 'integer' },
            maxAttempts: { type: 'integer' },
            fillByTranscribe: { type: 'boolean' },
            transcribeCap: { type: 'integer' },
            fillByFrames: { type: 'boolean' },
            framesCap: { type: 'integer' },
            framesPerVideo: { type: 'integer' },
            endpoint: { type: 'string' },
            cookieSet: { type: 'boolean' },
            proxies: { type: 'array', items: { type: 'string' } },
            file: { type: 'string' },
          },
        },
        render(args, value) {
          return textBlock(
            [
              `取数方式：${value.mode}`,
              `同时阅读视频数：${value.videoConcurrency}`,
              `每个视频分配 AI：${value.agentsPerVideoMin}-${value.agentsPerVideoMax} 个（长的会超过，靠空闲的补）`,
              `AI 总数上限：${value.maxTotalAgents}`,
              `最多尝试视频数：${value.maxAttempts}`,
              `没字幕时转写补齐：${value.fillByTranscribe ? `开（最多 ${value.transcribeCap} 条）` : '关'}`,
              `没字幕时抽帧看画面：${value.fillByFrames ? `开（最多 ${value.framesCap} 条，每条约 ${value.framesPerVideo} 帧）` : '关'}`,
              `自建服务器：${value.endpoint}`,
              `登录凭证：${value.cookieSet ? '已配置' : '未配置（字幕为空）'}`,
              `第三方池：${(value.proxies || []).length ? value.proxies.join(', ') : '（空）'}`,
              `配置文件：${value.file}`,
            ].join('\n'),
          )
        },
      },
      async execute(args) {
        const patch = {}
        if (args.mode) patch.mode = args.mode
        if (args.videoConcurrency) {
          patch.videoConcurrency = Math.min(Math.max(Number(args.videoConcurrency), 1), 12)
        }
        if (args.agentsPerVideoMin) {
          patch.agentsPerVideoMin = Math.min(Math.max(Number(args.agentsPerVideoMin), 1), 8)
        }
        if (args.agentsPerVideoMax) {
          patch.agentsPerVideoMax = Math.min(Math.max(Number(args.agentsPerVideoMax), 1), 8)
        }
        if (args.maxTotalAgents) {
          patch.maxTotalAgents = Math.min(Math.max(Number(args.maxTotalAgents), 1), 24)
        }
        if (args.maxAttempts) {
          patch.maxAttempts = Math.min(Math.max(Number(args.maxAttempts), 1), 60)
        }
        if (typeof args.fillByTranscribe === 'boolean') {
          patch.fillByTranscribe = args.fillByTranscribe
        }
        if (args.transcribeCap !== undefined) {
          patch.transcribeCap = Math.min(Math.max(Number(args.transcribeCap), 0), 10)
        }
        if (typeof args.fillByFrames === 'boolean') patch.fillByFrames = args.fillByFrames
        if (args.framesCap !== undefined) {
          patch.framesCap = Math.min(Math.max(Number(args.framesCap), 0), 10)
        }
        if (args.framesPerVideo !== undefined) {
          patch.framesPerVideo = Math.min(Math.max(Number(args.framesPerVideo), 1), 8)
        }
        if (patch.agentsPerVideoMin && patch.agentsPerVideoMax && patch.agentsPerVideoMin > patch.agentsPerVideoMax) {
          const lo = patch.agentsPerVideoMin
          patch.agentsPerVideoMin = patch.agentsPerVideoMax
          patch.agentsPerVideoMax = lo
        }
        if (typeof args.endpoint === 'string') patch.endpoint = args.endpoint
        if (typeof args.cookie === 'string') patch.cookie = args.cookie
        if (Array.isArray(args.proxies)) patch.proxies = args.proxies
        const s = Object.keys(patch).length ? await saveSettings(patch) : await loadSettings()
        return {
          mode: s.mode,
          videoConcurrency: s.videoConcurrency ?? s.concurrency ?? 3,
          agentsPerVideoMin: s.agentsPerVideoMin ?? 2,
          agentsPerVideoMax: s.agentsPerVideoMax ?? 4,
          maxTotalAgents: s.maxTotalAgents ?? 12,
          maxAttempts: s.maxAttempts ?? 30,
    fillByTranscribe: Boolean(s.fillByTranscribe),
    transcribeCap: s.transcribeCap ?? 3,
    fillByFrames: Boolean(s.fillByFrames),
    framesCap: s.framesCap ?? 2,
    framesPerVideo: s.framesPerVideo ?? 3,
          endpoint: s.endpoint,
          cookieSet: Boolean(s.cookie),
          proxies: s.proxies || [],
          file: SETTINGS_FILE,
        }
      },
    }),
  )
}
