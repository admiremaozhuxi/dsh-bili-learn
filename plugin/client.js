/**
 * Client half: one sidebar panel icon plus its main panel.
 *
 * The sidebar owns the button, so the icon component only paints; it receives
 * { size, active } from the global panel row. The matching `main` registration
 * uses the same key, so selecting the icon switches the central column here.
 *
 * Deliberately dependency-free: plain React elements and theme tokens only.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-bili-learn',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const C = {
      text: 'var(--dsw-alias-text-primary, #e6e6e6)',
      dim: 'var(--dsw-alias-text-secondary, #9a9a9a)',
      faint: 'var(--dsw-alias-text-tertiary, #6f6f6f)',
      line: 'var(--dsw-alias-border-subtle, rgba(255,255,255,0.12))',
      panel: 'var(--dsw-alias-bg-elevated, rgba(255,255,255,0.03))',
      accent: '#5ec48a',
      warn: '#e0b040',
    }

    const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    /* ------------------------------------------------------------- icon */

    function Icon(props) {
      const size = (props && props.size) || 20
      const active = Boolean(props && props.active)
      const stroke = active ? C.accent : 'currentColor'
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', {
          x: 2.5, y: 4.5, width: 19, height: 13, rx: 3.5,
          stroke, strokeWidth: 1.6,
        }),
        h('path', {
          d: 'M10 8.6 L15 11 L10 13.4 Z',
          fill: active ? C.accent : 'currentColor',
        }),
        h('path', {
          d: 'M7 20.4 h10',
          stroke, strokeWidth: 1.6, strokeLinecap: 'round',
        }),
      )
    }

    /* ------------------------------------------------------------ pieces */

    function Row(props) {
      const cells = props.cells || []
      return h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: props.cols || '110px 1fr',
            gap: 12,
            padding: '7px 10px',
            borderTop: `1px solid ${C.line}`,
            fontSize: 12.5,
            lineHeight: 1.55,
          },
        },
        cells.map((c, i) =>
          h(
            'div',
            { key: i, style: { color: i === 0 ? C.dim : C.text, fontFamily: i === 0 ? 'inherit' : mono } },
            c,
          ),
        ),
      )
    }

    function Section(props) {
      return h(
        'div',
        { style: { marginTop: 18 } },
        h(
          'div',
          {
            style: {
              fontSize: 11.5,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: C.faint,
              marginBottom: 7,
            },
          },
          props.title,
        ),
        h(
          'div',
          {
            style: {
              border: `1px solid ${C.line}`,
              borderRadius: 8,
              background: C.panel,
              overflow: 'hidden',
            },
          },
          props.children,
        ),
      )
    }

    /* ------------------------------------------------------------ panel */

    const MODES = [
      ['default', '默认（什么都不做）', '插件不发起任何请求；调用会被明确拒绝并说明原因。'],
      ['direct', '直连 B 站接口', '本机 IP 直接访问官方 API。最快，但本机 IP 也会被风控。'],
      ['self', '走自建服务器', '直链与字幕走你自己的解析服务，把风控挪到服务器 IP 上。'],
      ['proxy', '走第三方解析站', '站点池依次尝试。当前只作占位：这类站点只给视频文件，不给字幕。'],
      ['auto', '全自动（依次尝试）', '探测自建服务器是否在线，不通就回落直连。推荐。'],
    ]

    const EXAMPLES = [
      '学习B站上前端的做法，帮我去做一个前端',
      'B站上关于 React 状态管理的视频，总结成一篇笔记',
      '把 B 站上播放量最高的几条 RAG 讲解看完，给我一份实现方案',
    ]

    function Panel() {
      return h(
        'div',
        {
          style: {
            padding: '22px 26px 40px',
            maxWidth: 920,
            color: C.text,
            fontSize: 13,
            lineHeight: 1.65,
            overflowY: 'auto',
            height: '100%',
            boxSizing: 'border-box',
          },
        },

        h('div', { style: { fontSize: 17, fontWeight: 600, letterSpacing: '0.01em' } }, 'B站学习器'),
        h(
          'div',
          { style: { color: C.dim, marginTop: 4, fontSize: 12.5 } },
          '把 B 站当研究资料库：按播放量搜索 → 抓字幕与高赞评论 → 写成本地 markdown → 交给子 agent 学习 → 再动手施工。',
        ),

        h(
          Section,
          { title: '取数方式' },
          MODES.map(([id, name, note], i) =>
            h(
              'div',
              {
                key: id,
                style: {
                  display: 'grid',
                  gridTemplateColumns: '150px 1fr',
                  gap: 12,
                  padding: '8px 10px',
                  borderTop: i === 0 ? 'none' : `1px solid ${C.line}`,
                  fontSize: 12.5,
                },
              },
              h(
                'div',
                { style: { color: C.text } },
                h('span', { style: { fontFamily: mono, color: C.accent, marginRight: 8 } }, id),
                name,
              ),
              h('div', { style: { color: C.dim } }, note),
            ),
          ),
        ),

        h(
          Section,
          { title: '怎么改' },
          h(
            'div',
            { style: { padding: '10px 12px', fontSize: 12.5, color: C.dim } },
            '在对话里说一句就行，例如：',
            h(
              'div',
              {
                style: {
                  margin: '8px 0',
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: 'rgba(94,196,138,0.08)',
                  border: `1px solid rgba(94,196,138,0.22)`,
                  fontFamily: mono,
                  color: C.text,
                },
              },
              '把 B站学习器设成 auto 模式，并行度 6',
            ),
            'DSH 会调用 bili_config 写入 ',
            h('span', { style: { fontFamily: mono } }, '~/.dsh-bili-learn/settings.json'),
            '。面板本身只做展示，避免浏览器侧直接改动文件。',
          ),
        ),

        h(
          Section,
          { title: '字幕的前提' },
          h(
            'div',
            { style: { padding: '10px 12px', fontSize: 12.5, color: C.dim } },
            h('span', { style: { color: C.warn, fontWeight: 600 } }, '需要 SESSDATA。'),
            ' 实测：无登录态时 B 站对字幕接口返回 code=0 但字幕列表为空，' +
              '签名版本也一样。没有凭证时插件仍能拿到标题、简介和评论，但正文要另想办法（音频转写）。',
          ),
        ),

        h(
          Section,
          { title: '典型用法' },
          EXAMPLES.map((e, i) =>
            h(
              'div',
              {
                key: i,
                style: {
                  padding: '8px 10px',
                  borderTop: i === 0 ? 'none' : `1px solid ${C.line}`,
                  fontFamily: mono,
                  fontSize: 12.5,
                  color: C.text,
                },
              },
              e,
            ),
          ),
        ),

        h(
          Section,
          { title: '一键研读（bili_study）' },
          h(
            'div',
            { style: { padding: '10px 12px', fontSize: 12.5, color: C.dim } },
            h('div', { style: { fontFamily: mono, color: C.text, marginBottom: 6 } }, 'bili_study'),
            '采集完成后立刻按并发派子 agent，一个视频一个，各自提炼再合并成一份 brief。',
            h('div', { style: { marginTop: 6 } }, '派发不可用时不会失败：降级返回文件清单和明确指令，任何情况下都不空手。'),
          ),
        ),

        h(
          Section,
          { title: '采集落到哪里' },
          h(
            'div',
            { style: { padding: '10px 12px', fontSize: 12.5, color: C.dim } },
            h('div', { style: { fontFamily: mono, color: C.text, marginBottom: 6 } }, '~/.dsh-bili-learn/harvests/<时间>-<主题>/'),
            h(Row, { cells: ['index.json', '本次采集的视频索引：标题 / 播放量 / 字幕行数 / 评论数'] }),
            h(Row, { cells: ['<BV号>.md', '单条视频的可读正文：简介 + 带时间轴字幕 + 高赞评论'] }),
          ),
        ),

        h(
          'div',
          { style: { marginTop: 20, color: C.faint, fontSize: 11.5 } },
          '并行度 concurrency 控制的是同时派发多少个子 agent 去读这些文件；取数本身始终串行限速，' +
            '因为风控的计数单位是 IP 请求数，不是 agent 数量。',
        ),
      )
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
