/**
 * 来源探测 —— 从 index.js 的 registerTools 里拆出来。
 *
 * 拆分依据是 Prisma 的模块化重构指南 Phase 2：纯函数层稳定之后，按功能域拆。
 * 这个模块只依赖 deps 里传进来的东西，不 import 任何项目内部文件。
 */
export function registerSources(ctx, deps) {
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
      name: 'bili_sources',
      description:
        'Report which fetch sources are reachable right now: the official API paths, an optional self-hosted ' +
        'server, and human-facing parser sites. The sites matter even though they cannot be called over plain ' +
        'HTTP — each carries its own egress IP, so a subagent driving a browser through one spreads load away ' +
        'from this machine. Call this before a large harvest to pick a plan, or after repeated 412s to find a ' +
        'route that still answers. Pass refresh to re-probe instead of reading the cache.',
      parameters: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean', description: 'Re-probe every source now instead of using the cache.' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            at: { type: 'string' },
            api: { type: 'array', items: { type: 'object' } },
            web: { type: 'array', items: { type: 'object' } },
            advice: { type: 'string' },
          },
        },
        render(args, value) {
          if (!value?.ok) return textBlock('源状态读取失败')
          const line = (r) =>
            `${r.ok ? '在线' : '不可用'}  ${String(r.ms).padStart(5)}ms  ${r.name}${r.note ? ' — ' + r.note : ''}`
          const parts = ['接口类（可自动竞速）', ...value.api.map((r) => '  ' + line(r))]
          parts.push('', '网页类（有独立出口 IP，需子 agent 用浏览器操作）')
          parts.push(...value.web.map((r) => '  ' + line(r)))
          if (value.advice) parts.push('', value.advice)
          return textBlock(parts.join('\n'))
        },
      },
      async execute(args) {
        if (args.refresh || !sourceState.at) await probeAll()
        const list = effectiveSources(await loadSettings())
        const pick = (kind) =>
          sourceState.items
            .map((r) => ({ ...r, kind: (list.find((s) => s.id === r.id) || {}).kind }))
            .filter((r) => r.kind === kind)
            .map((r) => ({ id: r.id, name: r.name, ok: r.ok, ms: r.ms, note: r.note }))
        const api = pick('api').concat(pick('self'))
        const web = pick('web')
        const liveWeb = web.filter((r) => r.ok).map((r) => r.name) // 已是字符串数组
        const apiOk = api.some((r) => r.ok)
        const advice = apiOk
          ? `接口类可用，正常采集即可。${liveWeb.length ? `另有 ${liveWeb.length} 个网页源在线；需要分摊风险时可派子 agent 走 ${liveWeb[0]}。` : ''}`
          : `接口类全部不可用。派子 agent 用浏览器打开 ${liveWeb[0] || '任一网页源'} 解析，实测约 12 秒一条、无需验证码；完整步骤见插件 docs/BROWSER_SCRAPE.md。`
        return { ok: true, at: new Date(sourceState.at).toISOString(), api, web, advice }
      },
    }),
  )
}
