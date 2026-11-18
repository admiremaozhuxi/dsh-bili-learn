/**
 * Client half: one sidebar panel icon plus its main panel.
 *
 * The sidebar owns the button, so the icon component only paints; it receives
 * { size, active } from the global panel row. The matching `main` registration
 * uses the same key, so selecting the icon switches the central column here.
 *
 * Design rules applied here (learned from two Bilibili design channels):
 *  - Status has levels, not one flat indicator: the stronger the state, the more
 *    position and weight it earns. Quiet facts get quiet marks.
 *  - Uniform spacing is not the same as visual balance: monospace numbers and CJK
 *    labels have different optical weight, so row heights, letter spacing and
 *    numeric alignment are compensated per column rather than set once.
 *  - Empty states are designed, never left as a bare sentence.
 *
 * Dependency-free on purpose: plain React elements and theme tokens only.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-bili-learn',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ---------------------------------------------------------------- theme */

    const T = {
      base: 'var(--dsw-alias-bg-base, #16191c)',
      layer1: 'var(--dsw-alias-bg-layer-1, #1c2024)',
      layer2: 'var(--dsw-alias-bg-layer-2, #22272c)',
      sidebar: 'var(--dsw-specific-sidebar-fill, #14171a)',
      line1: 'var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
      line2: 'var(--dsw-alias-border-l2, rgba(255,255,255,0.14))',
      brand: 'var(--dsw-alias-brand-primary, #4f9cf9)',
      text1: 'var(--dsw-alias-label-primary, #e8eaed)',
      text2: 'var(--dsw-alias-label-secondary, #9aa0a6)',
      idle: 'var(--dsw-alias-state-idle-primary, #5f6368)',
      ok: 'var(--dsw-alias-state-success-primary, #34a853)',
      warn: 'var(--dsw-alias-state-warn-primary, #f9ab00)',
      err: 'var(--dsw-alias-state-error-primary, #ea4335)',
    }

    const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'
    const SANS = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'

    // 桌面式节奏：行高 26、栏高 34、字 12.5
    const Z = {
      rowH: 26,
      barH: 34,
      footH: 26,
      fs: 12.5,
      fsSm: 11.5,
    }

    /* ----------------------------------------------------------------- icon */

    function Icon(props) {
      const size = (props && props.size) || 20
      const active = Boolean(props && props.active)
      const tint = active ? T.brand : 'currentColor'
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', flex: '0 0 auto' },
        },
        h('rect', {
          x: 2.5, y: 4.5, width: 19, height: 12.5, rx: 3,
          stroke: tint, strokeWidth: 1.5,
        }),
        h('path', {
          d: 'M9.8 8.4 L14.6 10.75 L9.8 13.1 Z',
          fill: active ? T.brand : 'currentColor',
        }),
        h('path', {
          d: 'M7.5 20.2 H16.5',
          stroke: tint, strokeWidth: 1.5, strokeLinecap: 'round',
        }),
        active
          ? h('circle', { cx: 19.2, cy: 19.2, r: 2.6, fill: T.brand })
          : null,
      )
    }

    /* --------------------------------------------------------------- pieces */

    /** 分区标题：小号、字距拉开，靠字重和留白分层，不靠色块。 */
    function GroupTitle(props) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: Z.barH,
            padding: '0 12px',
            borderBottom: `1px solid ${T.line1}`,
            background: T.layer1,
          },
        },
        h(
          'span',
          {
            style: {
              fontFamily: SANS,
              fontSize: Z.fsSm,
              fontWeight: 600,
              letterSpacing: '0.06em',
              color: T.text2,
              textTransform: 'uppercase',
            },
          },
          props.title,
        ),
        props.right || null,
      )
    }

    /** 右侧小徽标：弱提示用 idle 色，强的才用品牌/状态色（状态分级）。 */
    function Badge(props) {
      const tone = props.tone || T.idle
      return h(
        'span',
        {
          style: {
            fontFamily: MONO,
            fontSize: 10.5,
            letterSpacing: '0.02em',
            color: tone,
            border: `1px solid ${tone}`,
            borderRadius: 3,
            padding: '1px 5px',
            opacity: props.quiet ? 0.75 : 1,
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    /** 一行键值：左边中文标签，右边等宽值。中英混排做视觉补偿。 */
    function KV(props) {
      return h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: props.cols || '96px 1fr',
            alignItems: 'center',
            minHeight: Z.rowH,
            padding: '0 12px',
            borderBottom: `1px solid ${T.line1}`,
          },
        },
        h(
          'span',
          { style: { fontFamily: SANS, fontSize: Z.fs, color: T.text2 } },
          props.k,
        ),
        h(
          'span',
          {
            style: {
              fontFamily: props.mono === false ? SANS : MONO,
              fontSize: props.mono === false ? Z.fs : Z.fs - 0.5,
              color: props.tone || T.text1,
              fontVariantNumeric: 'tabular-nums',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          props.v,
        ),
      )
    }

    /* ----------------------------------------------------------------- data */

    const MODES = [
      ['auto', '全自动', '探测自建服务，不通回落直连', true],
      ['direct', '直连', '本机直接访问官方接口', false],
      ['self', '自建服务', '直链与字幕走自己的服务器', false],
      ['proxy', '第三方站', '站点池轮询（当前为占位）', false],
      ['default', '默认', '不发起任何请求', false],
    ]

    const TOOLS = [
      ['bili_learn', '批量采集', '按播放量搜索 → 字幕/评论 → 落盘 markdown'],
      ['bili_study', '一键研读', '采集后派子 agent 并行读，合并成简报'],
      ['bili_watch', '单条深度', '给 BV 号直接抓，不用搜索'],
      ['bili_config', '配置', '读写取数方式、并发、凭据'],
    ]

    const CAPS = [
      ['元数据', 'ok', '一次 100 条'],
      ['评论', 'ok', '需凭据取全'],
      ['字幕', 'warn', '约 11%'],
      ['直链', 'ok', '无需登录'],
      ['音频转写', 'ok', '慢，但一定有'],
    ]

    const CAP_TONE = { ok: T.ok, warn: T.warn, err: T.err }

    /* ---------------------------------------------------------------- panel */

    function Panel() {
      const shell = {
        height: '100%',
        background: T.base,
        color: T.text1,
        fontFamily: SANS,
        fontSize: Z.fs,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }

      // 标题栏：牌子在左，关键状态在右，安静的事实不抢注意力
      const titleBar = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 42,
            padding: '0 14px',
            background: T.sidebar,
            borderBottom: `1px solid ${T.line2}`,
            flex: '0 0 auto',
          },
        },
        h('div', { style: { transform: 'scale(0.82)', transformOrigin: 'left center' } }, h(Icon, { size: 22, active: true })),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 1 } },
          h('div', { style: { fontSize: 13, fontWeight: 600, letterSpacing: '0.01em' } }, 'B站学习器'),
          h('div', { style: { fontSize: 10.5, color: T.text2 } }, '把视频变成可读正文'),
        ),
        h('div', { style: { flex: 1 } }),
        h(Badge, { tone: T.brand }, 'auto'),
        h(Badge, { tone: T.idle, quiet: true }, '并发 4'),
      )

      // 主体：左栏配置，右栏工具，中间一条细分隔线（桌面式双栏）
      const body = h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: '300px 1px 1fr',
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
          },
        },
        // 左：取数方式
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'auto' } },
          h(GroupTitle, { title: '取数方式' }),
          MODES.map(([id, name, desc, on], i) =>
            h(
              'div',
              {
                key: id,
                style: {
                  display: 'grid',
                  gridTemplateColumns: '3px 1fr',
                  minHeight: Z.rowH + 10,
                  borderBottom: `1px solid ${T.line1}`,
                  background: on ? T.layer1 : 'transparent',
                },
              },
              // 选中用左侧竖条，不用胶囊；未选中留空位，保证文字左缘对齐
              h('div', { style: { background: on ? T.brand : 'transparent' } }),
              h(
                'div',
                { style: { padding: '5px 11px', display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
                  h('span', { style: { fontSize: Z.fs, color: on ? T.text1 : T.text2, fontWeight: on ? 600 : 400 } }, name),
                  h('span', { style: { fontFamily: MONO, fontSize: 10, color: on ? T.brand : T.idle } }, id),
                ),
                h('div', {
                  style: { fontSize: 11, color: T.idle, lineHeight: 1.45, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                }, desc),
              ),
            ),
          ),
        ),
        h('div', { style: { background: T.line1 } }),
        // 右：工具与能力
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'auto' } },
          h(GroupTitle, { title: '工具' }),
          TOOLS.map(([name, label, desc], i) =>
            h(
              'div',
              {
                key: name,
                style: {
                  display: 'grid',
                  gridTemplateColumns: '132px 1fr',
                  alignItems: 'center',
                  minHeight: Z.rowH + 4,
                  padding: '2px 12px',
                  borderBottom: `1px solid ${T.line1}`,
                },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
                h('span', { style: { fontFamily: MONO, fontSize: 11.5, color: T.brand } }, name.replace('bili_', '')),
                h('span', { style: { fontSize: 10.5, color: T.idle } }, label),
              ),
              h(
                'div',
                { style: { fontSize: 11.5, color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                desc,
              ),
            ),
          ),
          h(GroupTitle, { title: '数据能力', right: h(Badge, { tone: T.warn, quiet: true }, '字幕需凭据') }),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column' } },
            CAPS.map(([name, tone, note], i) =>
              h(
                'div',
                {
                  key: name,
                  style: {
                    display: 'grid',
                    gridTemplateColumns: '14px 76px 1fr',
                    alignItems: 'center',
                    minHeight: Z.rowH - 2,
                    padding: '0 12px',
                    borderBottom: i === CAPS.length - 1 ? 'none' : `1px solid ${T.line1}`,
                  },
                },
                // 状态点有强弱：正常是小实心，警告带一圈，避免所有点长得一样
                h('div', {
                  style: {
                    width: tone === 'ok' ? 6 : 7,
                    height: tone === 'ok' ? 6 : 7,
                    borderRadius: '50%',
                    background: tone === 'ok' ? CAP_TONE.ok : 'transparent',
                    border: tone === 'ok' ? 'none' : `1.5px solid ${CAP_TONE[tone]}`,
                    boxSizing: 'border-box',
                  },
                }),
                h('span', { style: { fontSize: Z.fs, color: T.text1 } }, name),
                h('span', { style: { fontFamily: MONO, fontSize: Z.fs - 0.5, color: T.text2 } }, note),
              ),
            ),
          ),
        ),
      )

      // 状态栏：只放最有判断价值的三件事，等宽对齐
      const foot = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            height: Z.footH,
            padding: '0 12px',
            background: T.sidebar,
            borderTop: `1px solid ${T.line2}`,
            fontFamily: MONO,
            fontSize: 10.5,
            color: T.text2,
            flex: '0 0 auto',
          },
        },
        h('span', { style: { color: T.ok } }, '● 就绪'),
        h('span', null, 'gap 1200ms'),
        h('span', null, 'harvests ~/.dsh-bili-learn'),
        h('div', { style: { flex: 1 } }),
        h('span', { style: { color: T.idle } }, 'bili-learn 0.1.0'),
      )

      // 说明区：只在宽屏出现，窄屏不挤——用说明承载「怎么改」，不占操作位
      const note = h(
        'div',
        {
          style: {
            padding: '9px 14px',
            borderTop: `1px solid ${T.line1}`,
            background: T.layer1,
            fontSize: 11,
            lineHeight: 1.6,
            color: T.idle,
            flex: '0 0 auto',
          },
        },
        '在对话里说一句就能改配置，例如 ',
        h('span', { style: { fontFamily: MONO, color: T.text2 } }, '把 B站学习器设成 auto 模式，并发 6'),
        '。面板只读，避免浏览器侧改写配置文件。',
      )

      return h('div', { style: shell }, titleBar, body, note, foot)
    }

    /* ------------------------------------------------------------- apply */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'bili-learn', order: 25, label: 'B站学习器' },
            Icon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'bili-learn' }, Panel),
        )
      },
    }
  },
})
