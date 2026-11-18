/**
 * Client half: sidebar icon plus the main panel.
 *
 * The panel now really saves. Two same-origin routes on the Host own the data
 * (/bili-learn/settings and /bili-learn/test), so a click is a click — no
 * copying a command, no pretending.
 *
 * Wording target: someone who has never heard of an API. No "取数方式", no
 * "元数据", no "凭证". Say「怎么获取」「标题和播放量」「登录状态」.
 *
 * Visual discipline borrowed from a UI rebuild teardown: few colours, one card
 * shape, one primary button, no decorative variants. Every colour is a theme
 * token so the panel follows light and dark on its own.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-bili-learn',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    /* ---------------------------------------------------------------- theme */

    const V = {
      bg: 'var(--dsw-alias-bg-base)',
      card: 'var(--dsw-alias-bg-layer-1)',
      sunken: 'var(--dsw-alias-bg-layer-2)',
      line: 'var(--dsw-alias-border-l1)',
      brand: 'var(--dsw-alias-brand-primary)',
      text: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-secondary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
    }

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    const SANS = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'

    /* ------------------------------------------------------------------ icon */

    function Icon(props) {
      const size = (props && props.size) || 20
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('rect', { x: 2.5, y: 4.5, width: 19, height: 12.5, rx: 3, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M9.8 8.4 L14.6 10.75 L9.8 13.1 Z', fill: 'currentColor', opacity: props && props.active ? 1 : 0.72 }),
        h('path', { d: 'M7.5 20.2 H16.5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    /* ---------------------------------------------------------------- atoms */

    function Button(props) {
      const [hover, setHover] = useState(false)
      const disabled = Boolean(props.disabled)
      const primary = Boolean(props.primary)
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
            fontSize: 13,
            fontWeight: primary ? 600 : 400,
            color: disabled ? V.sub : primary ? V.bg : V.text,
            background: disabled ? V.sunken : primary ? V.brand : hover ? V.sunken : 'transparent',
            border: `1px solid ${disabled ? V.line : primary ? V.brand : V.line}`,
            borderRadius: 6,
            padding: '7px 16px',
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.55 : 1,
            lineHeight: '18px',
          },
        },
        props.children,
      )
    }

    function Tab(props) {
      const on = props.active
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          style: {
            fontFamily: SANS, fontSize: 13.5,
            fontWeight: on ? 600 : 400,
            color: on ? V.text : V.sub,
            background: 'transparent',
            border: 'none',
            borderBottom: `2px solid ${on ? V.brand : 'transparent'}`,
            padding: '8px 2px',
            marginRight: 22,
            cursor: 'pointer',
          },
        },
        props.children,
      )
    }

    function Label(props) {
      return h(
        'div',
        { style: { fontFamily: SANS, fontSize: 12, color: V.sub, marginBottom: 7 } },
        props.children,
      )
    }

    /* ------------------------------------------------------------------ data */

    const MODES = [
      ['auto', '全自动（推荐）', '先试自己的服务器，连不上就直接连 B 站'],
      ['direct', '直接连 B 站', '最快，但连着请求太多会被 B 站短暂拦住'],
      ['self', '走自己的服务器', '把请求放在服务器上，本机不容易被拦'],
      ['proxy', '第三方网站', '备用方案，目前那几个网站都不给字幕'],
      ['default', '什么都不做', '插件完全不联网'],
    ]

    const TOOLS = [
      ['bili_learn', '找视频并抓内容', '按播放量搜一批视频，把字幕和评论存成文件'],
      ['bili_study', '一键自学', '抓完之后自动派几个 AI 分身分别读，再合成一份笔记'],
      ['bili_watch', '看单个视频', '给它一个 BV 号，直接抓字幕和评论'],
      ['bili_frames', '看画面', '抽几帧图让 AI 看，能读懂 PPT、代码和操作'],
      ['bili_config', '用对话改设置', '懒得点面板就在对话里说一句'],
    ]

    const CAPS = [
      ['标题和播放量', 'ok', '一次拿 100 条，不用登录'],
      ['评论区', 'ok', '登录后能拿全'],
      ['字幕', 'warn', '约 11% 的视频有，需登录'],
      ['视频下载地址', 'ok', '不用登录'],
      ['把声音转成文字', 'ok', '视频没字幕时用，稍慢'],
      ['看画面', 'ok', '每看一帧消耗一次'],
    ]

    /* ------------------------------------------------------------------- api */

    async function apiGet(path) {
      const r = await fetch(path, { headers: { accept: 'application/json' } })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    }

    async function apiPost(path, body) {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    }

    /* ----------------------------------------------------------------- panel */

    function Panel() {
      const [tab, setTab] = useState('settings')
      const [loaded, setLoaded] = useState(false)
      const [loadError, setLoadError] = useState('')
      const [mode, setMode] = useState('auto')
      const [conc, setConc] = useState(4)
      const [gap, setGap] = useState(1200)
      const [advanced, setAdvanced] = useState(false)
      const [status, setStatus] = useState('')   // '' | 'saving' | 'saved' | 'error'
      const [testResult, setTestResult] = useState(null)
      const [testing, setTesting] = useState(false)

      // 打开面板就读真实配置
      useEffect(() => {
        let alive = true
        apiGet('/bili-learn/settings')
          .then((d) => {
            if (!alive) return
            if (d && d.ok && d.settings) {
              setMode(d.settings.mode || 'auto')
              setConc(d.settings.concurrency || 4)
              setGap(d.settings.gapMs || 1200)
            }
            setLoaded(true)
          })
          .catch((err) => {
            if (!alive) return
            setLoadError(String(err.message || err))
            setLoaded(true)
          })
        return () => {
          alive = false
        }
      }, [])

      const save = async () => {
        setStatus('saving')
        try {
          const d = await apiPost('/bili-learn/settings', { mode, concurrency: conc, gapMs: gap })
          if (d && d.ok) {
            setStatus('saved')
            setTimeout(() => setStatus(''), 2000)
          } else {
            setStatus('error')
          }
        } catch (err) {
          setStatus('error')
        }
      }

      const runTest = async () => {
        setTesting(true)
        setTestResult(null)
        try {
          const d = await apiGet('/bili-learn/test')
          setTestResult(d)
        } catch (err) {
          setTestResult({ ok: false, error: String(err.message || err) })
        }
        setTesting(false)
      }

      /* -------------------------------------------------------------- settings */

      const settingsView = h(
        'div',
        null,
        h(Label, null, '怎么获取视频内容'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 20 } },
          MODES.map(([id, name, desc]) => {
            const on = id === mode
            return h(
              'button',
              {
                key: id,
                type: 'button',
                onClick: () => { setMode(id); setStatus('') },
                style: {
                  display: 'grid',
                  gridTemplateColumns: '16px 1fr',
                  gap: 11,
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 13px',
                  background: on ? V.card : 'transparent',
                  border: `1px solid ${on ? V.brand : V.line}`,
                  borderRadius: 8,
                  cursor: 'pointer',
                  fontFamily: SANS,
                },
              },
              h('span', {
                style: {
                  width: 14, height: 14, borderRadius: '50%', marginTop: 3,
                  border: `1.5px solid ${on ? V.brand : V.line}`,
                  background: on ? V.brand : 'transparent',
                  boxSizing: 'border-box',
                },
              }),
              h(
                'div',
                { style: { minWidth: 0 } },
                h('div', { style: { fontSize: 13.5, fontWeight: on ? 600 : 400, color: V.text } }, name),
                h('div', { style: { fontSize: 12, color: V.sub, marginTop: 1.5, lineHeight: 1.5 } }, desc),
              ),
            )
          }),
        ),

        h(Label, null, '同时看几个视频'),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 } },
          h(Button, { onClick: () => { setConc((n) => Math.max(1, n - 1)); setStatus('') }, disabled: conc <= 1 }, '−'),
          h('span', {
            style: {
              fontFamily: MONO, fontSize: 18, fontWeight: 600, color: V.text,
              minWidth: 32, textAlign: 'center', fontVariantNumeric: 'tabular-nums',
            },
          }, String(conc)),
          h(Button, { onClick: () => { setConc((n) => Math.min(12, n + 1)); setStatus('') }, disabled: conc >= 12 }, '+'),
          h('span', { style: { fontSize: 12, color: V.sub, marginLeft: 4 } }, '个（1 到 12）'),
        ),

        // 高级：默认收起，避免小白被「毫秒」吓到
        h(
          'button',
          {
            type: 'button',
            onClick: () => setAdvanced((v) => !v),
            style: {
              fontFamily: SANS, fontSize: 12, color: V.sub, background: 'transparent',
              border: 'none', padding: 0, cursor: 'pointer', marginBottom: 10,
            },
          },
          advanced ? '▾ 收起高级选项' : '▸ 高级选项',
        ),
        advanced
          ? h(
              'div',
              { style: { marginBottom: 20 } },
              h(Label, null, '每次请求之间等多久（毫秒，越大越不容易被拦）'),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                h(Button, { onClick: () => { setGap((g) => Math.max(300, g - 300)); setStatus('') }, disabled: gap <= 300 }, '−300'),
                h('span', { style: { fontFamily: MONO, fontSize: 16, fontWeight: 600, color: V.text, fontVariantNumeric: 'tabular-nums' } }, String(gap)),
                h(Button, { onClick: () => { setGap((g) => Math.min(5000, g + 300)); setStatus('') }, disabled: gap >= 5000 }, '+300'),
              ),
            )
          : null,

        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h(Button, { primary: true, onClick: save, disabled: status === 'saving' || Boolean(loadError) },
            status === 'saving' ? '保存中…' : '保存设置'),
          h(Button, { onClick: runTest, disabled: testing }, testing ? '测试中…' : '测试一下'),
          status === 'saved'
            ? h('span', { style: { fontSize: 12.5, color: V.ok } }, '已保存 ✓')
            : null,
          status === 'error'
            ? h('span', { style: { fontSize: 12.5, color: V.err } }, '保存失败，看下方说明')
            : null,
        ),

        loadError
          ? h('div', { style: { marginTop: 12, fontSize: 12, color: V.err, lineHeight: 1.7 } },
              '读不到当前设置（' + loadError + '）。可能插件需要重启一次 DSH。')
          : null,

        testResult
          ? h(
              'div',
              {
                style: {
                  marginTop: 14, padding: '11px 13px', background: V.card,
                  border: `1px solid ${V.line}`, borderRadius: 8, fontSize: 12.5, lineHeight: 1.9,
                },
              },
              h('div', { style: { color: testResult.ok ? V.text : V.err } },
                testResult.ok ? '测试结果' : ('测试失败：' + (testResult.error || ''))),
              testResult.ok && testResult.self
                ? h('div', { style: { color: testResult.self.ok ? V.ok : V.warn } },
                    testResult.self.ok ? '· 自己的服务器：在线' : '· 自己的服务器：连不上（会自动改走直连）')
                : null,
              testResult.ok && testResult.login
                ? h('div', { style: { color: testResult.login.ok ? V.ok : V.warn } },
                    testResult.login.ok
                      ? ('· B 站登录：已登录（' + (testResult.login.name || '') + '）')
                      : '· B 站登录：未登录，字幕拿不到')
                : null,
            )
          : null,
      )

      /* ----------------------------------------------------------------- tools */

      const toolsView = h(
        'div',
        null,
        h(Label, null, '它能做的五件事'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
          TOOLS.map(([name, title, desc]) =>
            h(
              'div',
              {
                key: name,
                style: {
                  display: 'grid', gridTemplateColumns: '34px 1fr', gap: 12,
                  alignItems: 'center', padding: '11px 13px',
                  background: V.card, border: `1px solid ${V.line}`, borderRadius: 8,
                },
              },
              h('div', {
                style: {
                  width: 34, height: 34, borderRadius: 8, background: V.sunken,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: V.brand,
                },
              }, h(Icon, { size: 17, active: true })),
              h(
                'div',
                { style: { minWidth: 0 } },
                h('div', { style: { fontSize: 13.5, fontWeight: 600, color: V.text } }, title),
                h('div', { style: { fontSize: 12, color: V.sub, marginTop: 1.5, lineHeight: 1.5 } },
                  desc,
                  h('span', { style: { fontFamily: MONO, fontSize: 11, color: V.sub, opacity: 0.85 } },
                    '  ·  ' + name)),
              ),
            ),
          ),
        ),
        h('div', { style: { marginTop: 16, fontSize: 12, color: V.sub, lineHeight: 1.8 } },
          '不知道用哪个？直接对 DSH 说「学习B站上××」，它会自己挑工具。'),
      )

      /* ---------------------------------------------------------------- status */

      const statusView = h(
        'div',
        null,
        h(Label, null, '分别能拿到什么'),
        h(
          'div',
          { style: { background: V.card, border: `1px solid ${V.line}`, borderRadius: 8, overflow: 'hidden' } },
          CAPS.map(([name, tone, note], i) =>
            h(
              'div',
              {
                key: name,
                style: {
                  display: 'grid', gridTemplateColumns: '16px 1fr', gap: 11,
                  alignItems: 'center', padding: '10px 13px',
                  borderTop: i === 0 ? 'none' : `1px solid ${V.line}`,
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
              h(
                'div',
                null,
                h('div', { style: { fontSize: 13, color: V.text } }, name),
                h('div', { style: { fontSize: 11.5, color: V.sub, marginTop: 1 } }, note),
              ),
            ),
          ),
        ),
        h(Label, null, '文件存在哪'),
        h(
          'div',
          {
            style: {
              background: V.card, border: `1px solid ${V.line}`, borderRadius: 8,
              padding: '11px 13px', fontSize: 12, color: V.sub, lineHeight: 2,
            },
          },
          h('div', null, '抓下来的笔记 ', h('span', { style: { fontFamily: MONO, color: V.text } }, '~/.dsh-bili-learn/harvests/')),
          h('div', null, '设置文件 ', h('span', { style: { fontFamily: MONO, color: V.text } }, '~/.dsh-bili-learn/settings.json')),
        ),
      )

      /* ----------------------------------------------------------------- shell */

      return h(
        'div',
        {
          style: {
            height: '100%', overflowY: 'auto', background: V.bg, color: V.text,
            fontFamily: SANS, boxSizing: 'border-box', padding: '20px 24px 34px',
          },
        },
        h(
          'div',
          { style: { maxWidth: 720 } },
          h('div', { style: { fontSize: 18, fontWeight: 600, color: V.text } }, 'B站学习器'),
          h('div', { style: { fontSize: 12.5, color: V.sub, marginTop: 4, lineHeight: 1.6 } },
            '把 B 站视频变成能读的笔记：字幕、评论、声音转文字、画面理解。'),
          h(
            'div',
            { style: { display: 'flex', borderBottom: `1px solid ${V.line}`, marginTop: 16, marginBottom: 18 } },
            h(Tab, { active: tab === 'settings', onClick: () => setTab('settings') }, '设置'),
            h(Tab, { active: tab === 'tools', onClick: () => setTab('tools') }, '能做什么'),
            h(Tab, { active: tab === 'status', onClick: () => setTab('status') }, '说明'),
          ),
          !loaded
            ? h('div', { style: { fontSize: 12.5, color: V.sub } }, '正在读取设置…')
            : tab === 'settings' ? settingsView : tab === 'tools' ? toolsView : statusView,
        ),
      )
    }

    /* ----------------------------------------------------------------- apply */

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
