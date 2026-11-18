/**
 * Client half: one sidebar panel icon plus its main panel.
 *
 * Visual language follows the host application, not a terminal: light/dark is
 * decided by theme tokens alone, cards sit on layer-1, headings use
 * label-primary and descriptions use label-secondary.
 *
 * A hard rule learned the hard way: never paint text with a *state* token.
 * --dsw-alias-state-idle-primary is a disabled-state colour; using it for body
 * copy makes the panel unreadable in the light theme. Text uses label tokens,
 * period. No token here carries a hard-coded hex fallback, because a fallback is
 * a silent bet that the user runs a dark theme.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-bili-learn',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ---------------------------------------------------------------- theme */
    // Only semantic tokens. No hex fallbacks: the host always provides them.
    const V = {
      bgBase: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      line1: 'var(--dsw-alias-border-l1)',
      line2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      // 文本一律走 label 令牌，绝不用 state 令牌
      text: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-secondary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    }

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    const SANS = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'

    /* ----------------------------------------------------------------- icon */

    function Icon(props) {
      const size = (props && props.size) || 20
      const active = Boolean(props && props.active)
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
          x: 2.5, y: 4.5, width: 19, height: 12.5, rx: 3,
          stroke: 'currentColor', strokeWidth: 1.6,
        }),
        h('path', {
          d: 'M9.8 8.4 L14.6 10.75 L9.8 13.1 Z',
          fill: 'currentColor',
          opacity: active ? 1 : 0.7,
        }),
        h('path', {
          d: 'M7.5 20.2 H16.5',
          stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
        }),
      )
    }

    /* --------------------------------------------------------------- pieces */

    /** 卡片行：DSH 原生列表的形态——图标块 + 标题 + 描述 + 右侧可选状态。 */
    function Card(props) {
      return h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: props.icon ? '34px 1fr auto' : '1fr auto',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            background: V.layer1,
            border: `1px solid ${V.line1}`,
            borderRadius: 8,
            marginBottom: 8,
          },
        },
        props.icon
          ? h(
              'div',
              {
                style: {
                  width: 34,
                  height: 34,
                  borderRadius: 8,
                  background: V.layer2,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: props.iconTone || V.brand,
                  flex: '0 0 auto',
                },
              },
              props.icon,
            )
          : null,
        h(
          'div',
          { style: { minWidth: 0 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'nowrap' } },
            h(
              'span',
              { style: { fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: V.text } },
              props.title,
            ),
            props.tag || null,
          ),
          props.desc
            ? h(
                'div',
                {
                  style: {
                    fontFamily: SANS,
                    fontSize: 12,
                    color: V.sub,
                    lineHeight: 1.55,
                    marginTop: 2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                props.desc,
              )
            : null,
        ),
        props.right || null,
      )
    }

    /** 小标签：弱信息用描边，不填色，避免和正文抢注意力。 */
    function Tag(props) {
      return h(
        'span',
        {
          style: {
            fontFamily: SANS,
            fontSize: 10.5,
            color: props.tone || V.sub,
            border: `1px solid ${props.tone || V.line2}`,
            borderRadius: 4,
            padding: '1px 6px',
            lineHeight: '14px',
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    /** 分区标题：DSH 原生是小标题 + 右侧次级入口。 */
    function Section(props) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            margin: '18px 0 10px',
          },
        },
        h(
          'span',
          { style: { fontFamily: SANS, fontSize: 13, fontWeight: 600, color: V.text } },
          props.title,
        ),
        props.right || null,
      )
    }

    /** 状态点：正常实心，警告空心环——形状区分，不只靠颜色。 */
    function Dot(props) {
      const filled = props.tone === 'ok'
      return h('span', {
        style: {
          display: 'inline-block',
          width: filled ? 7 : 8,
          height: filled ? 7 : 8,
          borderRadius: '50%',
          background: filled ? V.ok : 'transparent',
          border: filled ? 'none' : `1.5px solid ${V.warn}`,
          boxSizing: 'border-box',
          flex: '0 0 auto',
        },
      })
    }

    /* ----------------------------------------------------------------- data */

    const MODES = [
      ['auto', '全自动', '探测自建服务是否在线，不通就回落直连。推荐', true],
      ['direct', '直连', '本机直接访问 B 站官方接口', false],
      ['self', '自建服务', '直链与字幕走自己的解析服务，把风控挪到服务器 IP', false],
      ['proxy', '第三方站', '站点池依次尝试（当前为占位，这类站点不给字幕）', false],
      ['default', '默认', '什么都不做，调用会被明确拒绝并说明原因', false],
    ]

    const TOOLS = [
      ['learn', 'bili_learn', '批量采集', '按播放量搜索 → 抓字幕与评论 → 每个视频落一份 markdown'],
      ['study', 'bili_study', '一键研读', '采集后按并发派子 agent 各读一个文件，再合并成简报'],
      ['watch', 'bili_watch', '单条深度', '给一个 BV 号直接抓，不用搜索'],
      ['config', 'bili_config', '配置', '读写取数方式、并发、自建服务器与登录凭证'],
    ]

    const CAPS = [
      ['元数据', 'ok', '一次 100 条'],
      ['评论', 'ok', '需凭据取全'],
      ['字幕', 'warn', '约 11% 命中'],
      ['音视频直链', 'ok', '无需登录'],
      ['音频转写', 'ok', '慢，但一定有'],
    ]

    /* ---------------------------------------------------------------- panel */

    function Panel() {
      return h(
        'div',
        {
          style: {
            height: '100%',
            overflowY: 'auto',
            background: V.bgBase,
            color: V.text,
            fontFamily: SANS,
            boxSizing: 'border-box',
            padding: '20px 24px 32px',
          },
        },
        h(
          'div',
          { style: { maxWidth: 860 } },

          // 页头：标题 + 说明，与 DSH 原生页一致
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 } },
            h(
              'div',
              null,
              h('div', { style: { fontSize: 18, fontWeight: 600, color: V.text, letterSpacing: '0.01em' } }, 'B站学习器'),
              h(
                'div',
                { style: { fontSize: 12.5, color: V.sub, marginTop: 4, lineHeight: 1.6 } },
                '把 B 站视频变成可读的正文：按播放量搜索，抓字幕与高赞评论，落成本地 markdown，再交给子 agent 研读。',
              ),
            ),
            h('div', { style: { display: 'flex', gap: 8, flex: '0 0 auto', paddingTop: 2 } },
              h(Tag, { tone: V.brand }, 'auto'),
              h(Tag, null, '并发 4'),
            ),
          ),

          // 取数方式
          h(Section, {
            title: '取数方式',
            right: h('span', { style: { fontSize: 11.5, color: V.sub } }, '在对话里说一句即可修改'),
          }),
          MODES.map(([id, name, desc, on]) =>
            h(
              'div',
              {
                key: id,
                style: {
                  display: 'grid',
                  gridTemplateColumns: '22px 1fr auto',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 14px',
                  marginBottom: 8,
                  background: on ? V.layer1 : 'transparent',
                  border: `1px solid ${on ? V.brand : V.line1}`,
                  borderRadius: 8,
                },
              },
              // 单选用圆圈，选中填充——形状本身表达状态，不依赖颜色深浅
              h('span', {
                style: {
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  border: `1.5px solid ${on ? V.brand : V.line2}`,
                  background: on ? V.brand : 'transparent',
                  boxSizing: 'border-box',
                  flex: '0 0 auto',
                },
              }),
              h(
                'div',
                { style: { minWidth: 0 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
                  h('span', { style: { fontSize: 13, fontWeight: on ? 600 : 400, color: V.text } }, name),
                  h('span', { style: { fontFamily: MONO, fontSize: 10.5, color: V.sub } }, id),
                ),
                h(
                  'div',
                  {
                    style: {
                      fontSize: 11.5, color: V.sub, marginTop: 1, lineHeight: 1.5,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    },
                  },
                  desc,
                ),
              ),
              on ? h(Tag, { tone: V.brand }, '当前') : h('span'),
            ),
          ),

          // 工具
          h(Section, { title: '工具' }),
          TOOLS.map(([key, name, label, desc]) =>
            h(
              Card,
              {
                key,
                icon: h(Icon, { size: 17, active: false }),
                title: name,
                tag: h(Tag, null, label),
                desc,
              },
            ),
          ),

          // 数据能力
          h(Section, {
            title: '数据能力',
            right: h('span', { style: { fontSize: 11.5, color: V.sub } }, '字幕需登录态，其余不需要'),
          }),
          h(
            'div',
            {
              style: {
                background: V.layer1,
                border: `1px solid ${V.line1}`,
                borderRadius: 8,
                overflow: 'hidden',
              },
            },
            CAPS.map(([name, tone, note], i) =>
              h(
                'div',
                {
                  key: name,
                  style: {
                    display: 'grid',
                    gridTemplateColumns: '18px 92px 1fr',
                    alignItems: 'center',
                    gap: 8,
                    padding: '9px 14px',
                    borderTop: i === 0 ? 'none' : `1px solid ${V.line1}`,
                  },
                },
                h(Dot, { tone }),
                h('span', { style: { fontSize: 12.5, color: V.text } }, name),
                h('span', { style: { fontFamily: MONO, fontSize: 11.5, color: V.sub } }, note),
              ),
            ),
          ),

          // 说明
          h(
            'div',
            {
              style: {
                marginTop: 18,
                padding: '11px 14px',
                background: V.layer2,
                border: `1px solid ${V.line1}`,
                borderRadius: 8,
                fontSize: 11.5,
                lineHeight: 1.7,
                color: V.sub,
              },
            },
            '改配置不用点这个面板：在对话里说 ',
            h('span', { style: { fontFamily: MONO, color: V.text } }, '把 B站学习器设成 auto 模式，并发 6'),
            ' 就行，DSH 会写进 ',
            h('span', { style: { fontFamily: MONO, color: V.text } }, '~/.dsh-bili-learn/settings.json'),
            '。采集产物在 ',
            h('span', { style: { fontFamily: MONO, color: V.text } }, 'harvests/'),
            ' 下，每个视频一份 markdown。',
          ),
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
