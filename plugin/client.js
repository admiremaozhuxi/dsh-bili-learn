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
  id: 'dsh-bili-learn',
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

    /* ---------------------------------------------------------------- shell */
    // 面板外壳的样式。只用 CSS 变量，不依赖 JS 令牌，方便注入一次全站生效。
    // 动效节奏取自两条公开资料：界面动画的常用区间是 200-600ms；hover 这类
    // 状态反馈要更快（约 100ms），否则会觉得迟钝。这里定成：hover 100ms、
    // 内容淡入 220ms、按钮按下 90ms，全部 ease-out，并且尊重 prefers-reduced-motion。
    const SHELL_CSS = [
      '.bl-shell{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-sizing:border-box}',
      '.bl-titlebar{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
      '.bl-body{flex:1;display:flex;min-height:0}',
      '.bl-rail{width:132px;flex:0 0 132px;border-right:1px solid var(--dsw-alias-border-l1);padding:8px 0;background:var(--dsw-alias-bg-base)}',
      '.bl-railitem{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1;padding:9px 14px;cursor:pointer;border-left:2px solid transparent;transition:background 100ms ease,color 100ms ease,border-color 100ms ease}',
      '.bl-railitem:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.bl-railitem[data-on]{color:var(--dsw-alias-label-primary);font-weight:600;border-left-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.bl-content{flex:1;min-width:0;overflow-y:auto;padding:14px 16px 22px}',
      '.bl-view{animation:bl-fade 220ms cubic-bezier(.2,.8,.2,1) both}',
      '.bl-statusbar{display:flex;align-items:center;gap:14px;padding:6px 14px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:11.5px;line-height:1.5;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-secondary)}',
      '.bl-btn{transition:background 100ms ease,transform 90ms ease;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1;padding:6px 12px;cursor:pointer}',
      '.bl-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.bl-btn:active{transform:scale(.97)}',
      '.bl-btn[disabled]{opacity:.5;cursor:default}',
      '@keyframes bl-fade{from{opacity:0}to{opacity:1}}',
      '@media (prefers-reduced-motion: reduce){.bl-view{animation:none}.bl-btn:active{transform:none}.bl-railitem{transition:none}}',
    ].join('')

    let shellCssReady = false
    function injectShellCss() {
      if (shellCssReady) return
      try {
        if (typeof document === 'undefined' || !document.head) return
        if (typeof document.querySelector === 'function' && document.querySelector('style[data-bl-shell]')) {
          shellCssReady = true
          return
        }
        const el = document.createElement('style')
        el.setAttribute('data-bl-shell', '')
        el.textContent = SHELL_CSS
        document.head.appendChild(el)
        shellCssReady = true
      } catch {
        /* 注入失败不影响功能，只是少了外壳样式与动效 */
      }
    }

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

    /** 输入框：与主题一致，聚焦时描边变品牌色。 */
    function TextInput(props) {
      return h('input', {
        type: 'text',
        value: props.value,
        placeholder: props.placeholder,
        onChange: (e) => props.onChange(e.target.value),
        spellCheck: false,
        style: {
          width: '100%',
          boxSizing: 'border-box',
          fontFamily: props.mono ? MONO : SANS,
          fontSize: 12.5,
          color: V.text,
          background: V.sunken,
          border: `1px solid ${V.line}`,
          borderRadius: 6,
          padding: '7px 10px',
          outline: 'none',
        },
      })
    }

    /* ------------------------------------------------------------------ data */

    const MODES = [
      ['auto', '全自动（推荐）', '先试自己的服务器；连不上就同时试两条直连，谁先成功用谁'],
      ['direct', '直接连 B 站', '两条直连同时跑，拿得快，但连着请求太多会被短暂拦住'],
      ['self', '只走自己的服务器', '取视频文件的请求全放在服务器上，本机不出网'],
      ['proxy', '第三方网站', '这些网站要人工点验证码，只有打不开时才当备选'],
      ['default', '不取视频文件', '搜索、字幕、评论照常；只是不下载视频、不看画面'],
    ]

    const TOOLS = [
      ['bili_learn', '找视频并抓内容', '按播放量搜一批视频，把字幕和评论存成文件'],
      ['bili_study', '一键自学', '抓完之后自动派几个 AI 分身分别读，再合成一份笔记'],
      ['bili_watch', '看单个视频', '给 BV 号抓字幕和评论，多集课程可指定第几集'],
      ['bili_series', '看整个系列', '网课/系列课的全部分P清单、UP主资料、哪几集有字幕'],
      ['bili_frames', '看画面', '抽几帧图让 AI 看，能读懂 PPT、代码和操作'],
      ['bili_transcribe', '声音转文字', '视频没字幕时用，把口播转成文字，不用登录'],
      ['bili_sources', '查来源', '现在哪些来源能用、多快，决定怎么采'],
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
      injectShellCss()
      const [tab, setTab] = useState('settings')
      const [loaded, setLoaded] = useState(false)
      const [loadError, setLoadError] = useState('')
      const [mode, setMode] = useState('auto')
      const [conc, setConc] = useState(3)
      const [aMin, setAMin] = useState(2)
      const [aMax, setAMax] = useState(4)
      const [aTotal, setATotal] = useState(12)
      const [attempts, setAttempts] = useState(30)
      const [fillAsr, setFillAsr] = useState(false)
      const [asrCap, setAsrCap] = useState(3)
      const [fillFrames, setFillFrames] = useState(false)
      const [framesCap, setFramesCap] = useState(2)
      const [framesPer, setFramesPer] = useState(3)
      const [gap, setGap] = useState(1200)
      const [advanced, setAdvanced] = useState(false)
      const [status, setStatus] = useState('')   // '' | 'saving' | 'saved' | 'error'
      const [saveError, setSaveError] = useState('')
      const [testResult, setTestResult] = useState(null)
      const [testing, setTesting] = useState(false)
      const [copied, setCopied] = useState('')
      const [sources, setSources] = useState(null)
      const [probing, setProbing] = useState(false)
      const [qr, setQr] = useState(null) // { key, img }
      const [qrPhase, setQrPhase] = useState('idle') // idle|waiting|scanned|success|expired|error
      const [qrMsg, setQrMsg] = useState('')
      const [login, setLogin] = useState(null) // { ok, name }
      const [endpoint, setEndpoint] = useState('')
      const [disabled, setDisabled] = useState([])
      const [custom, setCustom] = useState([])
      const [newName, setNewName] = useState('')
      const [newUrl, setNewUrl] = useState('')

      const refreshLogin = async () => {
        try {
          const d = await apiGet('/bili-learn/test')
          if (d && d.ok && d.login) setLogin(d.login)
        } catch (err) {
          /* 查不到就保持未知 */
        }
      }

      const beginQr = async () => {
        if (qrPhase === 'waiting' || qrPhase === 'scanned') return
        setQrPhase('waiting')
        setQrMsg('正在生成二维码…')
        setQr(null)
        try {
          const d = await apiGet('/bili-learn/qr')
          if (!d.ok) {
            setQrPhase('error')
            setQrMsg(d.error || '生成二维码失败')
            return
          }
          setQr({ key: d.key, img: d.img })
          setQrMsg('用 B 站 App 扫上面这张码')
          const key = d.key
          let tries = 0
          const tick = async () => {
            tries += 1
            if (tries > 90) {
              setQrPhase('expired')
              setQrMsg('等了太久，二维码可能已失效，点「换一张」重来')
              return
            }
            try {
              const p = await apiGet('/bili-learn/qr/poll?key=' + encodeURIComponent(key))
              if (p.state === 'success') {
                setQr(null)
                setQrPhase('success')
                setQrMsg('登录成功 ✓ 不用再扫了')
                setLogin({ ok: true, name: '' })
                refreshLogin()
                return
              }
              if (p.state === 'scanned') {
                setQrPhase('scanned')
                setQrMsg('已扫码，请在手机上点「确认登录」')
              } else if (p.state === 'expired') {
                setQrPhase('expired')
                setQrMsg('二维码过期了，点「换一张」重来')
                return
              } else if (p.state === 'error') {
                setQrPhase('error')
                setQrMsg(p.message || '出错了')
                return
              } else {
                setQrMsg('用 B 站 App 扫上面这张码')
              }
            } catch (err) {
              /* 单次失败继续试 */
            }
            setTimeout(tick, 2000)
          }
          setTimeout(tick, 1500)
        } catch (err) {
          setQrPhase('error')
          setQrMsg(String(err.message || err))
        }
      }

      // 请求节流（风控）状态：看当前间隔 / 安静期 / 冷却，并能一键重置
      const [throttleInfo, setThrottleInfo] = useState(null)

      const loadThrottle = async () => {
        try {
          const d = await apiGet('/bili-learn/throttle')
          if (d && d.ok) setThrottleInfo(d.state)
        } catch {
          /* 接口不可用不影响面板其它部分 */
        }
      }

      const actThrottle = async (action) => {
        try {
          const d = await apiPost('/bili-learn/throttle', { action })
          if (d && d.state) setThrottleInfo(d.state)
        } catch {
          /* 同上 */
        }
      }

      const loadSources = async (refresh) => {
        setProbing(true)
        try {
          const d = await apiGet('/bili-learn/sources' + (refresh ? '?refresh=1' : ''))
          if (d && d.ok) setSources(d)
          else setSources({ ok: false, error: (d && d.error) || '未知错误' })
        } catch (err) {
          setSources({ ok: false, error: String(err.message || err) })
        }
        setProbing(false)
      }

      // 仅在本地接口不可用时使用：把同样的改动做成一条命令
      const copyCommand = async (text) => {
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
          setCopied('ok')
        } catch (err) {
          setCopied('fail')
        }
        setTimeout(() => setCopied(''), 1600)
      }

      // 打开面板就读真实配置
      useEffect(() => {
        let alive = true
        loadThrottle()
        apiGet('/bili-learn/settings')
          .then((d) => {
            if (!alive) return
            if (d && d.ok && d.settings) {
              setMode(d.settings.mode || 'auto')
              setConc(d.settings.videoConcurrency ?? 3)
              setAMin(d.settings.agentsPerVideoMin ?? 2)
              setAMax(d.settings.agentsPerVideoMax ?? 4)
              setATotal(d.settings.maxTotalAgents ?? 12)
              setAttempts(d.settings.maxAttempts ?? 30)
              setFillAsr(Boolean(d.settings.fillByTranscribe))
              setAsrCap(d.settings.transcribeCap ?? 3)
              setFillFrames(Boolean(d.settings.fillByFrames))
              setFramesCap(d.settings.framesCap ?? 2)
              setFramesPer(d.settings.framesPerVideo ?? 3)
              setGap(d.settings.gapMs || 1200)
              setEndpoint(d.settings.endpoint || '')
              setDisabled(d.settings.disabledSources || [])
              setCustom(d.settings.customSources || [])
            }
            setLoaded(true)
          })
          .catch((err) => {
            if (!alive) return
            setLoadError(String(err.message || err))
            setLoaded(true)
          })
        // 源状态与登录态用缓存/轻查询，不阻塞首屏
        apiGet('/bili-learn/sources')
          .then((d) => {
            if (!alive) return
            if (d && d.ok) {
              setSources(d)
              // 启动自检要等 6 秒；赶在它之前打开面板时补一次，免得列表是空的
              if (!d.items || d.items.length === 0) loadSources(true)
            }
          })
          .catch(() => {})
        refreshLogin()
        return () => {
          alive = false
        }
      }, [])

      const save = async () => {
        setStatus('saving')
        setSaveError('')
        try {
          const d = await apiPost('/bili-learn/settings', {
            mode,
            videoConcurrency: conc,
            agentsPerVideoMin: aMin,
            agentsPerVideoMax: aMax,
            maxTotalAgents: aTotal,
            maxAttempts: attempts,
            fillByTranscribe: fillAsr,
            transcribeCap: asrCap,
            fillByFrames: fillFrames,
            framesCap: framesCap,
            framesPerVideo: framesPer,
            gapMs: gap,
            endpoint,
            disabledSources: disabled,
            customSources: custom,
          })
          if (d && d.ok) {
            setStatus('saved')
            setTimeout(() => setStatus(''), 2000)
          } else {
            setStatus('error')
            setSaveError((d && d.error) || '服务端拒绝了，没给原因')
          }
        } catch (err) {
          setStatus('error')
          setSaveError(String((err && err.message) || err))
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

      const toggleSource = (id) => {
        setStatus('')
        setDisabled((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
      }

      const addCustom = () => {
        const url = newUrl.trim()
        if (!/^https?:\/\//i.test(url)) {
          setStatus('error')
          return
        }
        let host = url
        try {
          host = new URL(url).host
        } catch {
          /* 用原串 */
        }
        const id = 'custom:' + url.replace(/[^a-zA-Z0-9]/g, '').slice(0, 44)
        if (custom.some((s) => s.id === id)) return
        setCustom([...custom, { id, name: newName.trim() || host, url }])
        setNewName('')
        setNewUrl('')
        setStatus('')
      }

      const removeCustom = (id) => {
        setCustom(custom.filter((s) => s.id !== id))
        setDisabled(disabled.filter((x) => x !== id))
        setStatus('')
      }

      /* -------------------------------------------------------------- settings */

      const settingsView = h(
        'div',
        null,
        h(Label, null, 'B 站登录'),
        h(
          'div',
          {
            style: {
              background: V.card, border: `1px solid ${V.line}`, borderRadius: 4,
              padding: '12px 14px', marginBottom: 20,
            },
          },
          // 当前状态一行，扫完转眼就能看到
          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: '8px 1fr', gap: 9, alignItems: 'center', marginBottom: qr ? 12 : 10 } },
            h('span', {
              style: {
                width: 7, height: 7, borderRadius: '50%',
                background: login && login.ok ? V.ok : V.line,
              },
            }),
            h('span', { style: { fontSize: 12.5, color: V.text } },
              login === null
                ? '登录状态查询中…'
                : login.ok
                  ? ('已登录' + (login.name ? '（' + login.name + '）' : '') + '，字幕和完整评论可用')
                  : '未登录，字幕拿不到（其他功能不受影响）'),
          ),
          qr
            ? h(
                'div',
                { style: { display: 'flex', gap: 16, alignItems: 'flex-start' } },
                h('div', {
                  style: { background: '#fff', padding: 6, borderRadius: 6, lineHeight: 0, flex: '0 0 auto' },
                }, h('img', { src: qr.img, width: 200, height: 200, alt: 'B站登录二维码' })),
                h(
                  'div',
                  { style: { flex: 1, minWidth: 0 } },
                  h('div', {
                    style: {
                      fontSize: 12.5, lineHeight: 1.75,
                      color: qrPhase === 'scanned' ? V.ok : V.sub,
                      marginBottom: 8,
                    },
                  }, qrMsg),
                  h(Button, { onClick: beginQr, disabled: qrPhase === 'scanned' }, '换一张'),
                ),
              )
            : h(
                'div',
                null,
                h('div', { style: { fontSize: 12, color: V.sub, lineHeight: 1.7, marginBottom: 9 } },
                  '扫码即可，不用输密码，也不用开开发者工具。'),
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                  h(Button, { primary: !(login && login.ok), onClick: beginQr },
                    login && login.ok ? '换账号登录' : '扫码登录 B 站'),
                  qrMsg
                    ? h('span', {
                        style: {
                          fontSize: 12,
                          color: qrPhase === 'success' ? V.ok : qrPhase === 'error' || qrPhase === 'expired' ? V.warn : V.sub,
                        },
                      }, qrMsg)
                    : null,
                ),
              ),
        ),

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
                  borderRadius: 4,
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
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 } },
          h(Button, { onClick: () => { setConc((n) => Math.max(1, n - 1)); setStatus('') }, disabled: conc <= 1 }, '−'),
          h('span', {
            style: {
              fontFamily: MONO, fontSize: 18, fontWeight: 600, color: V.text,
              minWidth: 32, textAlign: 'center', fontVariantNumeric: 'tabular-nums',
            },
          }, String(conc)),
          h(Button, { onClick: () => { setConc((n) => Math.min(12, n + 1)); setStatus('') }, disabled: conc >= 12 }, '+'),
          h('span', { style: { fontSize: 12, color: V.sub, marginLeft: 4 } }, '个'),
        ),
        h('div', { style: { fontSize: 11.5, color: V.sub, lineHeight: 1.6, marginBottom: 20 } },
          '同时读几个视频，避免只看到一个说法而片面。建议 3 个以上。'),

        h(Label, null, '每个视频分配几个 AI'),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h(Button, {
            onClick: () => { setAMin((n) => Math.max(1, Math.min(n - 1, aMax))); setStatus('') },
            disabled: aMin <= 1,
          }, '−'),
          h('span', {
            style: { fontFamily: MONO, fontSize: 17, fontWeight: 600, color: V.text, minWidth: 26, textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
          }, String(aMin)),
          h(Button, {
            onClick: () => { setAMin((n) => Math.min(n + 1, aMax)); setStatus('') },
            disabled: aMin >= aMax,
          }, '+'),
          h('span', { style: { fontSize: 12, color: V.sub, margin: '0 4px' } }, '到'),
          h(Button, {
            onClick: () => { setAMax((n) => Math.max(n - 1, aMin)); setStatus('') },
            disabled: aMax <= aMin,
          }, '−'),
          h('span', {
            style: { fontFamily: MONO, fontSize: 17, fontWeight: 600, color: V.text, minWidth: 26, textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
          }, String(aMax)),
          h(Button, {
            onClick: () => { setAMax((n) => Math.min(8, n + 1)); setStatus('') },
            disabled: aMax >= 8,
          }, '+'),
          h('span', { style: { fontSize: 12, color: V.sub, marginLeft: 4 } }, '个'),
        ),
        h('div', { style: { fontSize: 11.5, color: V.sub, lineHeight: 1.6, marginBottom: 20 } },
          '内容越长分配越多（按字幕长度估算），短片取下限。'),

        h(Label, null, 'AI 总数上限'),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 } },
          h(Button, { onClick: () => { setATotal((n) => Math.max(1, n - 1)); setStatus('') }, disabled: aTotal <= 1 }, '−'),
          h('span', {
            style: { fontFamily: MONO, fontSize: 18, fontWeight: 600, color: V.text, minWidth: 32, textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
          }, String(aTotal)),
          h(Button, { onClick: () => { setATotal((n) => Math.min(24, n + 1)); setStatus('') }, disabled: aTotal >= 24 }, '+'),
          h('span', { style: { fontSize: 12, color: V.sub, marginLeft: 4 } }, '个'),
        ),
        h('div', { style: { fontSize: 11.5, color: V.sub, lineHeight: 1.7, marginBottom: 20 } },
          '短片的 AI 跑完会自动转去帮长片，所以单个视频实际动用的 AI 可能超过上面的区间上限 —— 但同时在跑的总数不会超过这里。'),

        h(Label, null, '最多尝试几个视频'),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 } },
          h(Button, { onClick: () => { setAttempts((n) => Math.max(1, n - 1)); setStatus('') }, disabled: attempts <= 1 }, '−'),
          h('span', {
            style: { fontFamily: MONO, fontSize: 18, fontWeight: 600, color: V.text, minWidth: 32, textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
          }, String(attempts)),
          h(Button, { onClick: () => { setAttempts((n) => Math.min(60, n + 1)); setStatus('') }, disabled: attempts >= 60 }, '+'),
          h('span', { style: { fontSize: 12, color: V.sub, marginLeft: 4 } }, '个'),
        ),
        h('div', { style: { fontSize: 11.5, color: V.sub, lineHeight: 1.7, marginBottom: 20 } },
          '抓到没有字幕的视频会自动跳过、继续找下一个，不会白占名额。这个值是硬上限，防止一路试到搜索结果的尽头。'),

        h(Label, null, '没字幕时转写补齐'),
        h(
          'div',
          {
            style: {
              background: V.card, border: `1px solid ${V.line}`, borderRadius: 4,
              padding: '12px 14px', marginBottom: 20,
            },
          },
          h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: fillAsr,
              onChange: () => { setFillAsr((v) => !v); setStatus('') },
              style: { accentColor: V.brand, margin: 0 },
            }),
            h('span', { style: { fontSize: 12.5, color: V.text } }, '没有字幕轨时，改用音频转写拿正文'),
          ),
          h('div', { style: { fontSize: 11.5, color: V.sub, lineHeight: 1.7, marginTop: 8 } },
            '转写耗时约等于音频长度，所以默认关。开启后一次最多补 ',
            h('span', { style: { fontFamily: MONO, color: V.text } }, String(asrCap)),
            ' 条：',
            h(Button, { onClick: () => { setAsrCap((n) => Math.max(0, n - 1)); setStatus('') }, disabled: asrCap <= 0 }, '−'),
            ' ',
            h(Button, { onClick: () => { setAsrCap((n) => Math.min(10, n + 1)); setStatus('') }, disabled: asrCap >= 10 }, '+'),
          ),
          h('div', { style: { fontSize: 11.5, color: V.sub, lineHeight: 1.7, marginTop: 6 } },
            '不想等也可以关掉，事后对具体某条视频单独用 bili_transcribe 或 bili_frames。'),
        ),

        h(Label, null, '没字幕时抽帧看画面'),
        h(
          'div',
          {
            style: {
              background: V.card, border: `1px solid ${V.line}`, borderRadius: 4,
              padding: '12px 14px', marginBottom: 20,
            },
          },
          h(
            'label',
            { style: { display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: fillFrames,
              onChange: () => { setFillFrames((v) => !v); setStatus('') },
              style: { accentColor: V.brand, margin: 0 },
            }),
            h('span', { style: { fontSize: 12.5, color: V.text } }, '没有字幕轨时，抽几帧让 AI 看画面'),
          ),
          h('div', { style: { fontSize: 11.5, color: V.sub, lineHeight: 1.7, marginTop: 8 } },
            '比转写贵得多：每帧一次视觉调用，还要先下载视频。所以默认关。'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 11.5, color: V.sub } }, '最多补'),
            h(Button, { onClick: () => { setFramesCap((n) => Math.max(0, n - 1)); setStatus('') }, disabled: framesCap <= 0 }, '−'),
            h('span', { style: { fontFamily: MONO, fontSize: 12.5, color: V.text, minWidth: 18, textAlign: 'center' } }, String(framesCap)),
            h(Button, { onClick: () => { setFramesCap((n) => Math.min(10, n + 1)); setStatus('') }, disabled: framesCap >= 10 }, '+'),
            h('span', { style: { fontSize: 11.5, color: V.sub, marginLeft: 4 } }, '条，每条'),
            h(Button, { onClick: () => { setFramesPer((n) => Math.max(1, n - 1)); setStatus('') }, disabled: framesPer <= 1 }, '−'),
            h('span', { style: { fontFamily: MONO, fontSize: 12.5, color: V.text, minWidth: 18, textAlign: 'center' } }, String(framesPer)),
            h(Button, { onClick: () => { setFramesPer((n) => Math.min(8, n + 1)); setStatus('') }, disabled: framesPer >= 8 }, '+'),
            h('span', { style: { fontSize: 11.5, color: V.sub, marginLeft: 4 } }, '帧'),
          ),
          h('div', { style: { fontSize: 11.5, color: V.sub, lineHeight: 1.7, marginTop: 6 } },
            '画面里没有口播时（写代码、操作演示、PPT 讲解），这条比转写更划算。'),
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

        // ── 自己的服务器 ──
        h(Label, null, '自己的服务器（可选）'),
        h(
          'div',
          {
            style: {
              background: V.card, border: `1px solid ${V.line}`, borderRadius: 4,
              padding: '12px 14px', marginBottom: 20,
            },
          },
          h('div', { style: { fontSize: 12, color: V.sub, lineHeight: 1.7, marginBottom: 9 } },
            '有服务器就填地址，取视频的请求会走它，本机不消耗配额。没有就留空，不影响其他功能。'),
          h(TextInput, {
            value: endpoint,
            onChange: (v) => { setEndpoint(v); setStatus('') },
            placeholder: 'http://你的地址:8848（留空则不用）',
            mono: true,
          }),
          endpoint
            ? h('div', { style: { fontSize: 11.5, color: V.sub, marginTop: 7 } },
                '填好后选「走自己的服务器」或让「全自动」优先用它。服务器上跑 ',
                h('span', { style: { fontFamily: MONO, color: V.text } }, 'tools/parse_svc.py'),
                ' 即可。')
            : null,
        ),

        // ── 第三方网站 ──
        h(Label, null, '第三方网站'),
        h(
          'div',
          {
            style: {
              background: V.card, border: `1px solid ${V.line}`, borderRadius: 4,
              padding: '12px 14px', marginBottom: 20,
            },
          },
          h('div', { style: { fontSize: 12, color: V.sub, lineHeight: 1.7, marginBottom: 10 } },
            '这些站有各自的出口 IP，被限流时可以派子 agent 用浏览器走它们。打勾表示启用。'),
          (sources && sources.all ? sources.all.filter((s) => s.kind === 'web') : []).map((s, i, arr) =>
            h(
              'label',
              {
                key: s.id,
                style: {
                  display: 'grid', gridTemplateColumns: '16px 1fr auto', gap: 9,
                  alignItems: 'center', padding: '6px 0',
                  borderBottom: i === arr.length - 1 ? 'none' : `1px solid ${V.line}`,
                  cursor: 'pointer',
                },
              },
              h('input', {
                type: 'checkbox',
                checked: !disabled.includes(s.id),
                onChange: () => toggleSource(s.id),
                style: { accentColor: V.brand, margin: 0 },
              }),
              h('div', { style: { minWidth: 0 } },
                h('div', { style: { fontSize: 12.5, color: disabled.includes(s.id) ? V.sub : V.text } }, s.name),
                h('div', { style: { fontSize: 11, color: V.sub, marginTop: 1 } }, s.note || ''),
              ),
              h('span', { style: { fontFamily: MONO, fontSize: 10.5, color: V.sub } },
                disabled.includes(s.id) ? '已停用' : '启用'),
            ),
          ),
          // 自定义站点
          custom.length
            ? h('div', { style: { marginTop: 4 } },
                custom.map((s) =>
                  h(
                    'div',
                    {
                      key: s.id,
                      style: {
                        display: 'grid', gridTemplateColumns: '16px 1fr auto', gap: 9,
                        alignItems: 'center', padding: '6px 0', borderTop: `1px solid ${V.line}`,
                      },
                    },
                    h('span', {
                      style: {
                        width: 7, height: 7, borderRadius: '50%', justifySelf: 'center',
                        background: V.brand,
                      },
                    }),
                    h('div', { style: { minWidth: 0 } },
                      h('div', { style: { fontSize: 12.5, color: V.text } }, s.name),
                      h('div', {
                        style: {
                          fontFamily: MONO, fontSize: 10.5, color: V.sub,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        },
                      }, s.url),
                    ),
                    h(Button, { onClick: () => removeCustom(s.id) }, '删除'),
                  ),
                ),
              )
            : null,
          // 添加
          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: '1fr 1.6fr auto', gap: 8, marginTop: 10 } },
            h(TextInput, { value: newName, onChange: setNewName, placeholder: '名称（可留空）' }),
            h(TextInput, { value: newUrl, onChange: setNewUrl, placeholder: 'https://...', mono: true }),
            h(Button, { onClick: addCustom, disabled: !/^https?:\/\//i.test(newUrl.trim()) }, '添加'),
          ),
        ),

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
            ? h('span', { style: { fontSize: 12.5, color: V.err, wordBreak: 'break-all' } },
                '保存失败：' + (saveError || '未知原因'))
            : null,
        ),

        loadError
          ? h(
              'div',
              {
                style: {
                  marginTop: 14, padding: '9px 11px', background: V.card,
                  border: `1px solid ${V.line}`, borderRadius: 4, fontSize: 12.5, lineHeight: 1.9,
                },
              },
              h('div', { style: { color: V.warn, marginBottom: 4 } }, '面板连不上设置接口（' + loadError + '）'),
              h('div', { style: { color: V.sub } },
                '可能是这个版本没开放本地接口。可以直接用命令改，效果一样：'),
              h('div', {
                style: {
                  margin: '8px 0', padding: '8px 10px', background: V.sunken,
                  borderRadius: 6, fontFamily: MONO, fontSize: 11.5,
                  color: V.text, wordBreak: 'break-all',
                },
              }, `/bili set mode=${mode} videos=${conc} agents=${aMin}-${aMax} total=${aTotal} attempts=${attempts} gapMs=${gap}`),
              h(
                Button,
                { onClick: () => copyCommand(`/bili set mode=${mode} videos=${conc} agents=${aMin}-${aMax} total=${aTotal} attempts=${attempts} gapMs=${gap}`) },
                '复制这条命令',
              ),
              h('div', { style: { color: V.sub, marginTop: 6, fontSize: 11.5 } },
                '粘到对话框回车即可。'),
            )
          : null,

        testResult
          ? h(
              'div',
              {
                style: {
                  marginTop: 14, padding: '9px 11px', background: V.card,
                  border: `1px solid ${V.line}`, borderRadius: 4, fontSize: 12.5, lineHeight: 1.9,
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
                  alignItems: 'center', padding: '9px 11px',
                  background: V.card, border: `1px solid ${V.line}`, borderRadius: 4,
                },
              },
              h('div', {
                style: {
                  width: 34, height: 34, borderRadius: 4, background: V.sunken,
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

      const tRow = (k, v) =>
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '112px 1fr', gap: 10, padding: '3px 0', fontSize: 12.5 } },
          h('span', { style: { color: V.sub } }, k),
          h('span', { style: { color: V.text, fontFamily: MONO, fontSize: 11.5 } }, v),
        )

      const statusView = h(
        'div',
        null,
        h(Label, null, '可用来源（插件启动时会自动测一遍）'),
        h(
          'div',
          { style: { background: V.card, border: `1px solid ${V.line}`, borderRadius: 4, padding: '9px 11px', marginBottom: 6 } },
          !sources
            ? h('div', { style: { fontSize: 12.5, color: V.sub } }, probing ? '检测中…' : '还没测过')
            : !sources.ok
              ? h('div', { style: { fontSize: 12.5, color: V.warn } }, '测不了：' + (sources.error || ''))
              : h(
                  'div',
                  null,
                  h(
                    'div',
                    { style: { fontSize: 11.5, color: V.sub, marginBottom: 6 } },
                    '接口类（能自动用）',
                  ),
                  (sources.items || []).filter((r) => {
                    const a = (sources.all || []).find((x) => x.id === r.id)
                    return a && (a.kind === 'api' || a.kind === 'self')
                  }).map((r) =>
                    h(
                      'div',
                      { key: r.id, style: { display: 'grid', gridTemplateColumns: '8px 1fr auto', gap: 9, alignItems: 'center', padding: '3px 0', fontSize: 12.5 } },
                      h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: r.ok ? V.ok : V.err } }),
                      h('span', { style: { color: r.ok ? V.text : V.sub } }, r.name),
                      h('span', { style: { fontFamily: MONO, fontSize: 11, color: V.sub } },
                        r.ok ? r.ms + 'ms' : (r.note || '不可用')),
                    ),
                  ),
                  h('div', { style: { fontSize: 11.5, color: V.sub, margin: '10px 0 8px' } },
                    '网页类（有自己的出口 IP，需要时派子 agent 用浏览器打开）'),
                  (sources.items || []).filter((r) => {
                    const a = (sources.all || []).find((x) => x.id === r.id)
                    return a && a.kind === 'web'
                  }).map((r) =>
                    h(
                      'div',
                      { key: r.id, style: { display: 'grid', gridTemplateColumns: '8px 1fr auto', gap: 9, alignItems: 'center', padding: '3px 0', fontSize: 12.5 } },
                      h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: r.ok ? V.ok : V.line } }),
                      h('span', { style: { color: r.ok ? V.text : V.sub } }, r.name),
                      h('span', { style: { fontFamily: MONO, fontSize: 11, color: V.sub } },
                        r.ok ? r.ms + 'ms' : '打不开'),
                    ),
                  ),
                ),
        ),
        h('div', { style: { marginBottom: 18 } },
          h(Button, { onClick: () => loadSources(true), disabled: probing },
            probing ? '检测中…' : '重新检测所有来源')),

        h(Label, null, '分别能拿到什么'),
        h(
          'div',
          { style: { background: V.card, border: `1px solid ${V.line}`, borderRadius: 4, overflow: 'hidden' } },
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
              background: V.card, border: `1px solid ${V.line}`, borderRadius: 4,
              padding: '9px 11px', fontSize: 12, color: V.sub, lineHeight: 2,
            },
          },
          h('div', null, '抓下来的笔记 ', h('span', { style: { fontFamily: MONO, color: V.text } }, '~/.dsh-bili-learn/harvests/')),
          h('div', null, '设置文件 ', h('span', { style: { fontFamily: MONO, color: V.text } }, '~/.dsh-bili-learn/settings.json')),
        ),
      )

      /* ----------------------------------------------------------------- shell */

      // 顶部常驻：不管当前哪个 tab，打开面板第一眼就能看到节流状态
      const throttleBlock = h(
        'div',
        { style: { marginBottom: 4 } },
        h(Label, null, '请求节流（风控相关）'),
        h(
          'div',
          { style: { background: V.card, border: `1px solid ${V.line}`, borderRadius: 4, padding: '9px 11px', marginBottom: 6 } },
          !throttleInfo
            ? h('div', { style: { fontSize: 12.5, color: V.sub } }, '读取中…')
            : h(
                'div',
                null,
                tRow('当前生效间隔', throttleInfo.effectiveMs + 'ms'),
                tRow(
                  '构成',
                  '基础 ' + throttleInfo.baseMs + 'ms · 学习 ' + (throttleInfo.learnedMs || 0) + 'ms（撞一次翻倍、连续顺利回落）',
                ),
                tRow(
                  '安静期',
                  throttleInfo.quietSeconds > 0
                    ? '还剩 ' + throttleInfo.quietSeconds + ' 秒（' + (throttleInfo.quietReason || '') + '）'
                    : '无',
                ),
                tRow(
                  '冷却',
                  throttleInfo.cooldownSeconds > 0
                    ? '还剩 ' + Math.ceil(throttleInfo.cooldownSeconds / 60) + ' 分钟（' + (throttleInfo.cooldownReason || '') + '）'
                    : '无',
                ),
                throttleInfo.neighbourQuietSeconds > 0
                  ? tRow('邻居约定的安静期', '还剩 ' + throttleInfo.neighbourQuietSeconds + ' 秒')
                  : null,
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
                  h(Button, { onClick: () => actThrottle('reset-gap') }, '重置学习值'),
                  h(
                    Button,
                    { onClick: () => actThrottle('clear-cooldown'), disabled: !(throttleInfo.cooldownSeconds > 0) },
                    '清除冷却',
                  ),
                  h(
                    Button,
                    { onClick: () => actThrottle('clear-quiet'), disabled: !(throttleInfo.quietSeconds > 0) },
                    '清除安静期',
                  ),
                ),
                h('div', { style: { fontSize: 11, color: V.sub, marginTop: 8 } }, '状态文件 ' + throttleInfo.file),
              ),
        ),
      )

      return h(
        'div',
        { className: 'bl-shell' },
        h(
          'div',
          { className: 'bl-titlebar' },
          h('span', {
            style: {
              width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto',
              background: throttleInfo && throttleInfo.cooldownSeconds > 0 ? V.err : V.ok,
            },
          }),
          h('div', { style: { fontSize: 13.5, fontWeight: 600 } }, 'B站视频小工具'),
          h(
            'div',
            { style: { marginLeft: 'auto', fontSize: 11.5, color: V.sub, fontFamily: MONO } },
            throttleInfo ? '请求间隔 ' + throttleInfo.effectiveMs + 'ms' : '',
          ),
        ),
        h(
          'div',
          { className: 'bl-body' },
          h(
            'nav',
            { className: 'bl-rail' },
            [
              ['settings', '设置'],
              ['tools', '能做什么'],
              ['status', '状态'],
            ].map(([key, label]) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  className: 'bl-railitem',
                  'data-on': tab === key ? '' : undefined,
                  onClick: () => setTab(key),
                },
                label,
              ),
            ),
          ),
          h(
            'main',
            { className: 'bl-content' },
            throttleBlock,
            h(
              'div',
              { key: tab, className: 'bl-view' },
              !loaded
                ? h('div', { style: { fontSize: 12.5, color: V.sub } }, '正在读取设置…')
                : tab === 'settings' ? settingsView : tab === 'tools' ? toolsView : statusView,
            ),
          ),
        ),
        h(
          'div',
          { className: 'bl-statusbar' },
          h('span', null, loaded ? '已载入' : '读取中'),
          h('span', null, throttleInfo ? '节流 ' + throttleInfo.effectiveMs + 'ms' : '节流 —'),
          throttleInfo && throttleInfo.quietSeconds > 0 ? h('span', null, '安静 ' + throttleInfo.quietSeconds + 's') : null,
          throttleInfo && throttleInfo.cooldownSeconds > 0
            ? h('span', { style: { color: V.warn } }, '冷却 ' + Math.ceil(throttleInfo.cooldownSeconds / 60) + 'm')
            : null,
          h(
            'span',
            { style: { marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            throttleInfo ? throttleInfo.file : '',
          ),
        ),
      )
    }

    /* ----------------------------------------------------------------- apply */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            // 侧边栏空间紧，用简称；插件名和面板标题仍是「B站视频小工具」
            { name: 'sidebar.panellist', id: 'bili-learn', order: 25, label: 'B站小工具' },
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
