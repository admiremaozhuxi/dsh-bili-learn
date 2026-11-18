/**
 * Client half: sidebar panel icon plus its main panel.
 *
 * The panel is operable, not a brochure: it carries tab navigation, a mode
 * picker, steppers for concurrency and gap, and a command assembler that turns
 * the current draft into one `/bili set ...` line.
 *
 * Why the panel assembles a command instead of writing settings itself: a Client
 * plugin has no write access to Host files, and the sanctioned route for a UI
 * action to change Host state is a session command that the Host command
 * handler owns. So the panel drafts, the command applies, and the agent tool
 * `bili_config` calls the very same saveSettings path — one operation, three
 * callers, no duplicated logic.
 *
 * Text colours use label tokens only. A state token is a disabled-state colour
 * and must never paint body copy.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-bili-learn',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState } = React

    /* ---------------------------------------------------------------- theme */

    const V = {
      bgBase: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      line1: 'var(--dsw-alias-border-l1)',
      line2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
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
      return h(
        'svg',
        {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          'aria-hidden': true, style: { display: 'block' },
        },
        h('rect', {
          x: 2.5, y: 4.5, width: 19, height: 12.5, rx: 3,
          stroke: 'currentColor', strokeWidth: 1.6,
        }),
        h('path', {
          d: 'M9.8 8.4 L14.6 10.75 L9.8 13.1 Z',
          fill: 'currentColor', opacity: props && props.active ? 1 : 0.72,
        }),
        h('path', { d: 'M7.5 20.2 H16.5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    /* --------------------------------------------------------------- pieces */

    function Tag(props) {
      return h(
        'span',
        {
          style: {
            fontFamily: SANS, fontSize: 10.5,
            color: props.tone || V.sub,
            border: `1px solid ${props.tone || V.line2}`,
            borderRadius: 4, padding: '1px 6px', lineHeight: '14px', whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    function Section(props) {
      return h(
        'div',
        {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            margin: props.first ? '0 0 10px' : '18px 0 10px',
          },
        },
        h('span', { style: { fontSize: 13, fontWeight: 600, color: V.text } }, props.title),
        props.right || null,
      )
    }

    /** 可点按钮：hover 与按下都有反馈，disabled 真的不可点。 */
    function Btn(props) {
      const [hover, setHover] = useState(false)
      const disabled = Boolean(props.disabled)
      const primary = Boolean(props.primary)
      const bg = disabled
        ? V.layer2
        : primary
          ? (hover ? V.brand : V.brand)
          : (hover ? V.layer2 : 'transparent')
      return h(
        'button',
        {
          type: 'button',
          disabled,
          onClick: disabled ? undefined : props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            fontFamily: SANS,
            fontSize: 12,
            fontWeight: primary ? 600 : 400,
            color: disabled ? V.sub : primary ? V.bgBase : V.text,
            background: bg,
            border: `1px solid ${disabled ? V.line1 : primary ? V.brand : V.line2}`,
            borderRadius: 6,
            padding: '5px 12px',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.6 : 1,
            transition: 'background 120ms ease',
            lineHeight: '16px',
          },
        },
        props.children,
      )
    }

    /** Tab：下划线指示，不用胶囊。 */
    function Tab(props) {
      const on = props.active
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          style: {
            fontFamily: SANS, fontSize: 12.5,
            fontWeight: on ? 600 : 400,
            color: on ? V.text : V.sub,
            background: 'transparent',
            border: 'none',
            borderBottom: `2px solid ${on ? V.brand : 'transparent'}`,
            padding: '7px 2px',
            marginRight: 20,
            cursor: 'pointer',
          },
        },
        props.children,
      )
    }

    /* ----------------------------------------------------------------- data */

    const MODES = [
      ['auto', '全自动', '探测自建服务，不通回落直连'],
      ['direct', '直连', '本机直接访问官方接口'],
      ['self', '自建服务', '直链与字幕走自己的服务器'],
      ['proxy', '第三方站', '站点池轮询（占位）'],
      ['default', '默认', '不发起任何请求'],
    ]

    const TOOLS = [
      ['bili_learn', '批量采集', '按播放量搜索 → 字幕/评论 → 落盘 markdown'],
      ['bili_study', '一键研读', '采集后派子 agent 并行读，合并成简报'],
      ['bili_watch', '单条深度', '给 BV 号直接抓字幕与评论'],
      ['bili_frames', '看画面', '抽帧 + 视觉模型，读 PPT/代码/界面'],
      ['bili_config', '配置', '读写取数方式、并发、凭据'],
    ]

    const CAPS = [
      ['元数据', 'ok', '一次 100 条，无需登录'],
      ['评论', 'ok', '需凭据才给全'],
      ['字幕', 'warn', '约 11% 命中'],
      ['音视频直链', 'ok', '无需登录'],
      ['音频转写', 'ok', '慢，但一定有'],
      ['画面理解', 'ok', '每帧一次视觉调用'],
    ]

    const CHEATS = [
      ['/bili status', '查看当前配置'],
      ['/bili mode auto', '切换取数方式'],
      ['/bili concurrency 6', '调整并发'],
      ['/bili test', '测试服务器与登录态'],
      ['/bili clearcookie', '清除登录凭证'],
      ['/bili reset', '恢复默认'],
    ]

    /* ---------------------------------------------------------------- panel */

    function Panel() {
      const [tab, setTab] = useState('config')
      const [mode, setMode] = useState('auto')
      const [conc, setConc] = useState(4)
      const [gap, setGap] = useState(1200)
      const [copied, setCopied] = useState('')

      const command = `/bili set mode=${mode} concurrency=${conc} gap=${gap}`

      const copy = async (text, key) => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text)
          } else {
            const el = document.createElement('textarea')
            el.value = text
            document.body.appendChild(el)
            el.select()
            document.execCommand('copy')
            document.body.removeChild(el)
          }
          setCopied(key)
          setTimeout(() => setCopied(''), 1600)
        } catch (err) {
          setCopied('fail')
          setTimeout(() => setCopied(''), 1600)
        }
      }

      /* -------------------------------------------------------------- config */

      const configView = h(
        'div',
        null,
        h(Section, { title: '取数方式', first: true, right: h(Tag, { tone: V.brand }, mode) }),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          MODES.map(([id, name, desc]) => {
            const on = id === mode
            return h(
              'button',
              {
                key: id,
                type: 'button',
                onClick: () => setMode(id),
                style: {
                  display: 'grid',
                  gridTemplateColumns: '18px 74px 1fr',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 12px',
                  background: on ? V.layer1 : 'transparent',
                  border: `1px solid ${on ? V.brand : V.line1}`,
                  borderRadius: 8,
                  cursor: 'pointer',
                  fontFamily: SANS,
                },
              },
              h('span', {
                style: {
                  width: 13, height: 13, borderRadius: '50%',
                  border: `1.5px solid ${on ? V.brand : V.line2}`,
                  background: on ? V.brand : 'transparent',
                  boxSizing: 'border-box',
                },
              }),
              h('span', { style: { fontSize: 12.5, fontWeight: on ? 600 : 400, color: V.text } }, name),
              h('span', {
                style: {
                  fontSize: 11.5, color: V.sub,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                },
              }, desc),
            )
          }),
        ),

        h(Section, { title: '并发与节奏' }),
        h(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 10,
            },
          },
          // 并发步进
          h(
            'div',
            {
              style: {
                background: V.layer1, border: `1px solid ${V.line1}`,
                borderRadius: 8, padding: '10px 12px',
              },
            },
            h('div', { style: { fontSize: 11.5, color: V.sub, marginBottom: 6 } }, '同时观看的视频数'),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h(Btn, { onClick: () => setConc((n) => Math.max(1, n - 1)), disabled: conc <= 1 }, '−'),
              h('span', {
                style: {
                  fontFamily: MONO, fontSize: 16, fontWeight: 600, color: V.text,
                  minWidth: 28, textAlign: 'center', fontVariantNumeric: 'tabular-nums',
                },
              }, String(conc)),
              h(Btn, { onClick: () => setConc((n) => Math.min(12, n + 1)), disabled: conc >= 12 }, '+'),
            ),
          ),
          // 间隔
          h(
            'div',
            {
              style: {
                background: V.layer1, border: `1px solid ${V.line1}`,
                borderRadius: 8, padding: '10px 12px',
              },
            },
            h('div', { style: { fontSize: 11.5, color: V.sub, marginBottom: 6 } }, '请求间隔（毫秒）'),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h(Btn, { onClick: () => setGap((g) => Math.max(300, g - 300)), disabled: gap <= 300 }, '−300'),
              h('span', {
                style: {
                  fontFamily: MONO, fontSize: 15, fontWeight: 600, color: V.text,
                  fontVariantNumeric: 'tabular-nums',
                },
              }, String(gap)),
              h(Btn, { onClick: () => setGap((g) => Math.min(5000, g + 300)), disabled: gap >= 5000 }, '+300'),
            ),
          ),
        ),

        h(Section, { title: '应用' }),
        h(
          'div',
          {
            style: {
              background: V.layer2, border: `1px solid ${V.line1}`, borderRadius: 8,
              padding: '10px 12px',
            },
          },
          h(
            'div',
            {
              style: {
                fontFamily: MONO, fontSize: 11.5, color: V.text,
                wordBreak: 'break-all', lineHeight: 1.6, marginBottom: 2,
              },
            },
            command,
          ),
          h(
            'div',
            { style: { fontSize: 11, color: V.sub, lineHeight: 1.6, marginBottom: 9 } },
            '复制这行，粘到对话框回车即可生效。浏览器侧改不了配置文件，这条命令由 Host 的命令处理器执行。',
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8 } },
            h(
              Btn,
              { primary: true, onClick: () => copy(command, 'apply') },
              copied === 'apply' ? '已复制 ✓' : '复制命令',
            ),
            h(
              Btn,
              { onClick: () => copy('/bili test', 'test') },
              copied === 'test' ? '已复制 ✓' : '测试连通性',
            ),
            h(
              Btn,
              { onClick: () => { setMode('auto'); setConc(4); setGap(1200) } },
              '重置草稿',
            ),
          ),
        ),
      )

      /* --------------------------------------------------------------- tools */

      const toolsView = h(
        'div',
        null,
        h(Section, { title: '工具', first: true, right: h(Tag, null, `${TOOLS.length} 个`) }),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          TOOLS.map(([name, label, desc]) =>
            h(
              'div',
              {
                key: name,
                style: {
                  display: 'grid', gridTemplateColumns: '34px 1fr auto',
                  alignItems: 'center', gap: 11, padding: '9px 12px',
                  background: V.layer1, border: `1px solid ${V.line1}`, borderRadius: 8,
                },
              },
              h(
                'div',
                {
                  style: {
                    width: 34, height: 34, borderRadius: 8, background: V.layer2,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: V.brand,
                  },
                },
                h(Icon, { size: 17, active: true }),
              ),
              h(
                'div',
                { style: { minWidth: 0 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
                  h('span', { style: { fontFamily: MONO, fontSize: 12.5, color: V.text } }, name),
                  h('span', { style: { fontSize: 11.5, color: V.sub } }, label),
                ),
                h('div', {
                  style: {
                    fontSize: 11.5, color: V.sub, marginTop: 1, lineHeight: 1.5,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  },
                }, desc),
              ),
              h(Btn, { onClick: () => copy(name, name) }, copied === name ? '✓' : '复制名'),
            ),
          ),
        ),
        h(Section, { title: '命令速查' }),
        h(
          'div',
          {
            style: {
              background: V.layer1, border: `1px solid ${V.line1}`,
              borderRadius: 8, overflow: 'hidden',
            },
          },
          CHEATS.map(([cmd, desc], i) =>
            h(
              'button',
              {
                key: cmd,
                type: 'button',
                onClick: () => copy(cmd, cmd),
                style: {
                  display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center',
                  gap: 10, width: '100%', textAlign: 'left',
                  padding: '8px 12px', background: 'transparent',
                  border: 'none', borderTop: i === 0 ? 'none' : `1px solid ${V.line1}`,
                  cursor: 'pointer', fontFamily: SANS,
                },
              },
              h('span', { style: { fontFamily: MONO, fontSize: 11.5, color: V.text } }, cmd),
              h('span', { style: { fontSize: 11.5, color: copied === cmd ? V.ok : V.sub } },
                copied === cmd ? '已复制 ✓' : desc),
            ),
          ),
        ),
      )

      /* -------------------------------------------------------------- status */

      const statusView = h(
        'div',
        null,
        h(Section, { title: '数据能力', first: true, right: h('span', { style: { fontSize: 11.5, color: V.sub } }, '字幕需登录态') }),
        h(
          'div',
          {
            style: {
              background: V.layer1, border: `1px solid ${V.line1}`,
              borderRadius: 8, overflow: 'hidden',
            },
          },
          CAPS.map(([name, tone, note], i) =>
            h(
              'div',
              {
                key: name,
                style: {
                  display: 'grid', gridTemplateColumns: '18px 92px 1fr',
                  alignItems: 'center', gap: 8, padding: '9px 14px',
                  borderTop: i === 0 ? 'none' : `1px solid ${V.line1}`,
                },
              },
              h('span', {
                style: {
                  display: 'inline-block',
                  width: tone === 'ok' ? 7 : 8,
                  height: tone === 'ok' ? 7 : 8,
                  borderRadius: '50%',
                  background: tone === 'ok' ? V.ok : 'transparent',
                  border: tone === 'ok' ? 'none' : `1.5px solid ${V.warn}`,
                  boxSizing: 'border-box',
                },
              }),
              h('span', { style: { fontSize: 12.5, color: V.text } }, name),
              h('span', { style: { fontFamily: MONO, fontSize: 11.5, color: V.sub } }, note),
            ),
          ),
        ),
        h(Section, { title: '产物位置' }),
        h(
          'div',
          {
            style: {
              background: V.layer2, border: `1px solid ${V.line1}`, borderRadius: 8,
              padding: '10px 12px', fontSize: 11.5, lineHeight: 1.8, color: V.sub,
            },
          },
          h('div', null, '采集产物 ', h('span', { style: { fontFamily: MONO, color: V.text } }, '~/.dsh-bili-learn/harvests/<时间>-<主题>/')),
          h('div', null, '配置文件 ', h('span', { style: { fontFamily: MONO, color: V.text } }, '~/.dsh-bili-learn/settings.json')),
          h('div', null, '抽帧脚本 ', h('span', { style: { fontFamily: MONO, color: V.text } }, '~/.dsh-bili-learn/tools/video_frames.py')),
        ),
      )

      /* ---------------------------------------------------------------- shell */

      return h(
        'div',
        {
          style: {
            height: '100%', overflowY: 'auto', background: V.bgBase, color: V.text,
            fontFamily: SANS, boxSizing: 'border-box', padding: '18px 22px 32px',
          },
        },
        h(
          'div',
          { style: { maxWidth: 820 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 } },
            h(
              'div',
              null,
              h('div', { style: { fontSize: 17.5, fontWeight: 600, color: V.text } }, 'B站学习器'),
              h('div', { style: { fontSize: 12, color: V.sub, marginTop: 3, lineHeight: 1.6 } },
                '把 B 站视频变成可读正文：字幕、评论、音频转写、画面理解。'),
            ),
            h('div', { style: { display: 'flex', gap: 6, flex: '0 0 auto', paddingTop: 3 } },
              h(Tag, { tone: V.brand }, 'v0.1'),
            ),
          ),
          // Tab 行
          h(
            'div',
            { style: { display: 'flex', borderBottom: `1px solid ${V.line1}`, marginTop: 14, marginBottom: 16 } },
            h(Tab, { active: tab === 'config', onClick: () => setTab('config') }, '配置'),
            h(Tab, { active: tab === 'tools', onClick: () => setTab('tools') }, '工具'),
            h(Tab, { active: tab === 'status', onClick: () => setTab('status') }, '状态'),
          ),
          tab === 'config' ? configView : tab === 'tools' ? toolsView : statusView,
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
