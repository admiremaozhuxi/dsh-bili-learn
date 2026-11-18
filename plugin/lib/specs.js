/**
 * 设置的规格与派生计算 —— 全部是纯函数，不碰 IO、不依赖 ctx。
 *
 * 单独放一个文件的原因见 Prisma 的模块化重构指南：纯函数最好测、没有状态依赖、
 * 移动不会破坏任何东西，而且先做这一步，后面拆业务模块才有基础。
 */

/**
 * 所有「标量设置」的唯一来源。
 *
 * 以前每加一个设置项要改十处：默认值、view 返回、POST 校验、bili_config 的
 * 参数/schema/render/execute/返回、采集读取、面板 state/加载/保存/UI。
 * 漏一处就是一个静默 bug——前端拿不到、或者写进去不生效。
 */
export const SETTING_SPECS = {
  videoConcurrency: { kind: 'int', lo: 1, hi: 12, dflt: 3 },
  agentsPerVideoMin: { kind: 'int', lo: 1, hi: 8, dflt: 2 },
  agentsPerVideoMax: { kind: 'int', lo: 1, hi: 8, dflt: 4 },
  maxTotalAgents: { kind: 'int', lo: 1, hi: 24, dflt: 12 },
  maxAttempts: { kind: 'int', lo: 1, hi: 60, dflt: 30 },
  transcribeCap: { kind: 'int', lo: 0, hi: 10, dflt: 3 },
  framesCap: { kind: 'int', lo: 0, hi: 10, dflt: 2 },
  framesPerVideo: { kind: 'int', lo: 1, hi: 8, dflt: 3 },
  gapMs: { kind: 'int', lo: 300, hi: 5000, dflt: 1200 },
  fillByTranscribe: { kind: 'bool', dflt: false },
  fillByFrames: { kind: 'bool', dflt: false },
}

/** 默认值：从规格派生，避免两张表各写一遍而对不上。 */
export function scalarDefaults() {
  const out = {}
  for (const [k, sp] of Object.entries(SETTING_SPECS)) out[k] = sp.dflt
  return out
}

/** 面板要看的标量：同样派生，漏字段会导致前端拿不到值。 */
export function scalarView(s) {
  const out = {}
  for (const [k, sp] of Object.entries(SETTING_SPECS)) {
    out[k] = sp.kind === 'bool' ? Boolean(s[k]) : Number(s[k] ?? sp.dflt)
  }
  return out
}

/** 按规格校验一批写入，返回能用的 patch 和被拒的字段名。 */
export function coerceScalars(raw) {
  const patch = {}
  const rejected = []
  for (const [k, sp] of Object.entries(SETTING_SPECS)) {
    if (!(k in raw)) continue
    const v = raw[k]
    if (sp.kind === 'bool') {
      if (typeof v === 'boolean') patch[k] = v
      else rejected.push(k)
      continue
    }
    const n = Number(v)
    if (Number.isFinite(n) && n >= sp.lo && n <= sp.hi) patch[k] = Math.round(n)
    else rejected.push(k)
  }
  return { patch, rejected }
}

/**
 * 命令层的数字参数。label 是给人看的措辞，范围统一从 SETTING_SPECS 取——
 * 否则同一个范围要在两处维护，改一处忘一处就会「命令说 1-12、实际校验 1-8」。
 */
export const NUMERIC_SPECS = {
  videos: { field: 'videoConcurrency', label: '同时阅读视频数' },
  total: { field: 'maxTotalAgents', label: 'AI 总数上限' },
  gap: { field: 'gapMs', label: '请求间隔' },
  attempts: { field: 'maxAttempts', label: '最多尝试视频数' },
}
for (const spec of Object.values(NUMERIC_SPECS)) {
  spec.lo = SETTING_SPECS[spec.field].lo
  spec.hi = SETTING_SPECS[spec.field].hi
}

/** 校验一个数字型设置。返回 { ok, value } 或 { ok:false, message }。 */
export function checkNumber(raw, spec) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < spec.lo || n > spec.hi) {
    return { ok: false, message: `${spec.label}必须是 ${spec.lo} 到 ${spec.hi} 之间的整数` }
  }
  return { ok: true, value: Math.round(n) }
}

/** 阅读编排的一句话摘要，status 与 set 共用，避免两套措辞。 */
export function readPlanSummary(s) {
  return (
    `取数方式 ${s.mode} · 同时读 ${s.videoConcurrency ?? s.concurrency ?? 3} 个视频` +
    ` · 每片 ${s.agentsPerVideoMin ?? 2}-${s.agentsPerVideoMax ?? 4} 个AI` +
    ` · 总数上限 ${s.maxTotalAgents ?? 12} · 间隔 ${s.gapMs}ms`
  )
}
