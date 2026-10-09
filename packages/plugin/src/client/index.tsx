/**
 * DSH-Remote —— 浏览器半边：设置 → 插件 里的配置卡片。
 *
 * 与 dsh-explorer 同一套接入方式：slots.inject("settings.plugin.item") 注册卡片；
 * 0.2.0+ 宿主该卡片槽改版为 settings.plugins.tab 列表槽，这里双槽位注册、
 * 两代宿主各取所需（详见 apply() 内注释）。
 * 数据不走 localStorage（那些值必须落在 PC 的 config.json），而是通过插件宿主
 * 半边注册在 DSH webServer 上的 /dsh-remote/config 路由读写，保存后宿主会
 * 自动重启网关子进程生效。
 *
 * 移动端（Android App）的页面适配不在本插件：App 会在页面加载完成后注入
 * res/raw/mobile.js，对任何官方 DSH Web（装或不装本插件）完成 rail 隐藏、
 * 鲸鱼侧栏入口、设置底部 sheet 和系统栏避让。这里只保留桌面设置卡片。
 *
 * 视觉与原生插件卡对齐（同 dsh-explorer 的做法）：官方 PluginCard 所在包不在
 * 模块表上、无法 require，因此自绘同款结构并注入样式表；类名全局前缀 dshr-*，
 * 颜色全部走 --dsw-alias-* 主题变量，深浅色自适应。
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'

interface SlotsLike {
  inject(name: string, callback: () => unknown): void
  register(options: Record<string, unknown>, component: unknown): unknown
}

interface ClientContext {
  slots: SlotsLike
  /** cordis 生命周期钩子：setup 在 apply 时执行，返回的清理函数随 ctx dispose 运行。 */
  effect?: (setup: () => void | (() => void), label?: string) => () => void
}

async function fetchJson(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  return await response.json()
}

/** fetch 被 AbortController 中止时的拒绝原因；这类失败不应向用户报错。 */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

/**
 * WEB-03：请求级 AbortController —— 发起新请求前先 abort 同一链路里的旧请求
 * （慢响应不得覆盖新输入），返回新请求的 signal；组件卸载时同样 abort。
 */
function beginRequest(ref: { current: AbortController | null }): AbortSignal {
  ref.current?.abort()
  const controller = new AbortController()
  ref.current = controller
  return controller.signal
}

// ── 卡片样式表（对齐原生 PluginCard 观感） ──────────────────────────

const CARD_CSS = `
.dshr-card {
  list-style: none;
  border: 1px solid var(--dsw-alias-border-l2, rgba(20, 20, 30, 0.18));
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3, #fff);
  color: var(--dsw-alias-label-primary, #1b1b1f);
  transition: border-color .16s, background .16s;
}
.dshr-card:hover { border-color: var(--dsw-alias-label-dimmed, #9a9aa3); }
.dshr-card.open {
  background: var(--dsw-alias-bg-layer-2, #ececee);
  border-color: var(--dsw-alias-label-dimmed, #9a9aa3);
}
.dshr-head {
  width: 100%; appearance: none; border: 0; background: none; font: inherit;
  color: inherit; text-align: left; cursor: pointer; border-radius: 12px;
  display: flex; align-items: center; gap: 12px; padding: 14px 16px;
}
.dshr-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dshr-name { font-size: 15px; font-weight: 600; line-height: 1.4; }
.dshr-desc { font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, #8b8b93); }
.dshr-desc-inline { display: inline-flex; align-items: center; gap: 6px; margin-left: 8px; }
.dshr-dot {
  width: 8px; height: 8px; border-radius: 50%; display: inline-block;
  background: var(--dsw-alias-label-tertiary, #8b8b93);
}
.dshr-dot.ok { background: var(--dsw-alias-state-success-primary, #2e9e5b); }
.dshr-chevron {
  flex: none; width: 8px; height: 8px; margin-right: 4px;
  border-right: 1.5px solid var(--dsw-alias-label-tertiary, #8b8b93);
  border-bottom: 1.5px solid var(--dsw-alias-label-tertiary, #8b8b93);
  transform: rotate(45deg); transition: transform .16s;
}
.dshr-card.open .dshr-chevron { transform: rotate(225deg); }
.dshr-body {
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(20, 20, 30, 0.18));
  margin: 0 16px; padding-bottom: 12px;
}
.dshr-section {
  font-size: 13px; font-weight: 600; line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #62626b);
  padding: 12px 0 4px; border-top: 1px solid rgba(20, 20, 30, 0.12);
}
.dshr-body > .dshr-section:first-child { border-top: none; padding-top: 8px; }
.dshr-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 10px 0;
}
.dshr-row-info { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dshr-label { font-size: 13px; font-weight: 500; line-height: 1.5; }
.dshr-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, #8b8b93); }
.dshr-input {
  height: 34px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(20, 20, 30, 0.18));
  border-radius: 8px; background: var(--dsw-alias-bg-layer-3, #fff);
  font: inherit; font-size: 13px; color: inherit;
}
select.dshr-input { width: 220px; max-width: 100%; }
input.dshr-input[type="number"] { width: 130px; }
.dshr-field { display: flex; flex-direction: column; gap: 4px; padding: 10px 0; }
.dshr-field .dshr-input { width: 100%; max-width: 360px; height: 34px; }
.dshr-input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary, #3f6df5); }
.dshr-toggle {
  flex: none; position: relative; width: 40px; height: 22px; border-radius: 11px;
  border: none; padding: 2px; cursor: pointer;
  background: var(--dsw-alias-border-l2, rgba(20, 20, 30, 0.18));
  transition: background .16s;
}
.dshr-toggle.on { background: var(--dsw-alias-brand-primary, #3f6df5); }
.dshr-toggle-thumb {
  display: block; width: 18px; height: 18px; border-radius: 50%; background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18); transition: transform .16s;
}
.dshr-toggle.on .dshr-toggle-thumb { transform: translateX(18px); }
.dshr-actions { display: flex; gap: 8px; padding: 8px 0 4px; flex-wrap: wrap; }
.dshr-btn {
  appearance: none; border: 1px solid var(--dsw-alias-border-l2, rgba(20, 20, 30, 0.18));
  border-radius: 8px; padding: 6px 14px; font: inherit; font-size: 13px;
  background: none; color: var(--dsw-alias-label-secondary, #62626b); cursor: pointer;
}
.dshr-btn:hover:not(:disabled) { color: inherit; border-color: var(--dsw-alias-label-dimmed, #9a9aa3); }
.dshr-btn:disabled { opacity: 0.4; cursor: default; }
.dshr-btn.primary {
  background: var(--dsw-alias-brand-primary, #3f6df5);
  border-color: var(--dsw-alias-brand-primary, #3f6df5); color: #fff;
}
.dshr-code {
  margin-top: 8px; padding: 10px 12px; border-radius: 8px; font-size: 13px;
  background: var(--dsw-alias-bg-layer-1, #f6f6f7);
  border: 1px solid var(--dsw-alias-border-l2, rgba(20, 20, 30, 0.18));
}
.dshr-tunnel {
  margin: 8px 0 4px; padding: 10px 12px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, #f6f6f7);
  border: 1px solid var(--dsw-alias-border-l2, rgba(20, 20, 30, 0.18));
}
.dshr-proxy {
  margin: 6px 0 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px; line-height: 1.65; white-space: pre-wrap; word-break: break-all;
}
.dshr-note { color: var(--dsw-alias-state-error-primary, #d5433e); font-size: 12px; margin-top: 6px; }
.dshr-note.ok { color: var(--dsw-alias-state-success-primary, #2e9e5b); }
`

/**
 * 工厂物化时安装一次；loader dispose 时会一并清理插件样式标签。
 * PLG-07：另给固定 DOM id，apply() 里按 id 在 ctx dispose 时兜底移除，
 * 防 HMR 重载/插件卸载路径下重复注入。
 */
const STYLE_TAG_ID = 'dsh-remote-plugin/card.css'
const STYLE_TAG_DOM_ID = 'dsh-remote-styles'
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) === null) {
  const tag = document.createElement('style')
  tag.id = STYLE_TAG_DOM_ID
  tag.dataset.plugin = 'dsh-remote-plugin'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = CARD_CSS
  document.head.appendChild(tag)
}

// ── 基础控件 ────────────────────────────────────────────────────────

/** WEB-06：role="switch" 语义 + 空格/回车键盘切换 + 可选无障碍名称。 */
function Toggle({ checked, onChange, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; ariaLabel?: string }) {
  const toggle = (): void => { onChange(!checked) }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`dshr-toggle${checked ? ' on' : ''}`}
      onClick={toggle}
      onKeyDown={(event) => {
        // 显式键盘切换；preventDefault 抑制按钮原生激活，避免一次按键触发两下
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault()
          toggle()
        }
      }}
    >
      <span className="dshr-toggle-thumb" />
    </button>
  )
}

/** WEB-06：label 用 htmlFor 与输入框关联，hint 走 aria-describedby。 */
function TextField({ label, value, onChange, hint, placeholder, password }: {
  label: string; value: string; onChange: (v: string) => void; hint?: string; placeholder?: string; password?: boolean
}) {
  const id = useId()
  const hintId = hint !== undefined ? `${id}-hint` : undefined
  return (
    <div className="dshr-field">
      <label className="dshr-label" htmlFor={id}>{label}</label>
      <input
        id={id}
        className="dshr-input"
        type={password === true ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        aria-describedby={hintId}
        onChange={event => { onChange(event.target.value) }}
      />
      {hint !== undefined ? <span className="dshr-hint" id={hintId}>{hint}</span> : null}
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="dshr-row">
      <div className="dshr-row-info">
        <span className="dshr-label">{label}</span>
        {hint !== undefined ? <span className="dshr-hint">{hint}</span> : null}
      </div>
      {children}
    </div>
  )
}

/** 设置 → 插件 页的 DSH Remote 卡片。 */
/**
 * 设置卡本体。`as` 参数化根元素：0.1.x 宿主的 settings.plugin.item 列表槽
 * 渲染在 <ul> 里（语义根 <li>），0.2.x 的 settings.plugins.tab 渲染在
 * div.panel 里（语义根 <div>）——见 apply() 的双槽位注册。
 */
export function DshRemoteSettingsCard({ as = 'li' }: { as?: 'li' | 'div' } = {}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<any>(null)
  const [status, setStatus] = useState<any>(null)
  // WEB-03：统一忙碌锁，覆盖全部操作按钮（保存 与 重启网关）；
  // 值为在途操作类别，用于按钮文案与禁用判定。
  const [busy, setBusy] = useState<'save' | 'restart' | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [authToken, setAuthToken] = useState('')
  const [visitorKey, setVisitorKey] = useState('')

  // WEB-03：两条请求链路各持一个 AbortController——
  // opAbortRef：配置读取 + 保存/重启（互斥操作）；
  // statusAbortRef：状态轮询。新请求发起时 abort 本链路旧请求；卸载时全断。
  const opAbortRef = useRef<AbortController | null>(null)
  const statusAbortRef = useRef<AbortController | null>(null)

  useEffect(() => () => {
    opAbortRef.current?.abort()
    statusAbortRef.current?.abort()
  }, [])

  const refreshStatus = useCallback(() => {
    const signal = beginRequest(statusAbortRef)
    fetchJson('/dsh-remote/status', { signal })
      .then(setStatus)
      .catch((error: unknown) => { if (!isAbortError(error)) setStatus(null) })
  }, [])

  useEffect(() => {
    const signal = beginRequest(opAbortRef)
    fetchJson('/dsh-remote/config', { signal })
      .then((payload) => {
        // 文件里可能只有部分键；用展示默认值补齐，避免受控组件抖动
        const merged = {
          ...{
            autoStart: true, listenHost: '127.0.0.1', listenPort: 18443,
            upstreamPort: 52392, autoFixUpstreamPort: true,
          },
          ...payload.config,
          frp: { ...payload.defaults.frp, serverAddr: '', ...payload.config?.frp },
        }
        setForm(merged)
        setAuthToken(typeof payload.secrets?.authToken === 'string' ? payload.secrets.authToken : '')
        setVisitorKey(typeof payload.secrets?.visitorKey === 'string' ? payload.secrets.visitorKey : '')
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) setMessage({ kind: 'err', text: '读取配置失败（插件路由不可达）' })
      })
    refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    // 忙碌期间暂停轮询：既避免轮询请求打断在途保存/重启，
    // 也避免重启过程中拿到的过渡态状态刷屏。
    if (!open || busy !== null) return undefined
    const timer = setInterval(refreshStatus, 5000)
    return () => { clearInterval(timer) }
  }, [open, busy, refreshStatus])

  const patchForm = (patch: any): void => {
    setForm((current: any) => ({ ...current, ...patch }))
  }

  const save = async (): Promise<void> => {
    if (busy !== null) return
    setMessage(null)
    if (form.frp.enabled) {
      if (!authToken.trim() || !visitorKey.trim() || !String(form.frp.serverAddr ?? '').trim()) {
        setMessage({ kind: 'err', text: '请填写 VPS 地址、登录密钥和访客密钥' })
        return
      }
    }
    setBusy('save')
    const signal = beginRequest(opAbortRef)
    try {
      const payload: Record<string, unknown> = {
        autoStart: form.autoStart,
        autoFixUpstreamPort: true,
        listenHost: '127.0.0.1',
        listenPort: 18443,
        frp: {
          enabled: form.frp.enabled,
          serverAddr: String(form.frp.serverAddr ?? '').trim(),
          serverPort: form.frp.serverPort,
          mode: form.frp.mode,
          entryEnabled: form.frp.entryEnabled,
          remotePort: form.frp.remotePort,
          name: String(form.frp.name ?? '').trim() || 'dsh-remote',
        },
      }
      if (form.frp.enabled) {
        payload.authToken = authToken.trim()
        payload.visitorKey = visitorKey.trim()
      }
      const result = await fetchJson('/dsh-remote/config', { method: 'POST', body: JSON.stringify(payload), signal })
      if (result.ok === true) {
        setMessage({ kind: 'ok', text: '已保存并重启网关（几秒后生效）' })
        setTimeout(refreshStatus, 2500)
      } else {
        setMessage({ kind: 'err', text: Array.isArray(result.errors) ? result.errors.join('；') : '保存失败' })
      }
    } catch (error) {
      if (!isAbortError(error)) setMessage({ kind: 'err', text: `保存失败：${String(error)}` })
    } finally {
      setBusy(null)
    }
  }

  const restartGateway = async (): Promise<void> => {
    if (busy !== null) return
    setMessage(null)
    setBusy('restart')
    const signal = beginRequest(opAbortRef)
    try {
      await fetchJson('/dsh-remote/restart', { method: 'POST', signal })
      setMessage({ kind: 'ok', text: '重启指令已发出' })
      setTimeout(refreshStatus, 3000)
    } catch (error) {
      if (!isAbortError(error)) setMessage({ kind: 'err', text: `重启失败：${String(error)}` })
    } finally {
      setBusy(null)
    }
  }

  const gatewayRunning = status?.gatewayRunning === true
  const tunnel = status?.tunnel ?? null
  const formAddr = String(form?.frp?.serverAddr ?? '').trim()
  const formPort = Number(form?.frp?.serverPort ?? 0)
  const formName = String(form?.frp?.name ?? '').trim() || 'dsh-remote'
  const proxies: Array<{ name: string; type: string; remotePort?: number }> = tunnel?.proxies ?? []
  const liveName = proxies.find(proxy => proxy.type === 'xtcp')?.name ?? proxies[0]?.name
  const entryProxy = proxies.find(proxy => proxy.type === 'tcp')
  const publicUrl = entryProxy && status?.config?.frp?.enabled === true && status?.gateway?.frp?.running === true
    ? `https://${String(tunnel.serverAddr)}:${String(entryProxy.remotePort)}/` : null
  const expectsEntry = form?.frp?.mode === 'entry' || form?.frp?.entryEnabled === true
  const tunnelMismatch = tunnel !== null
    && (formAddr !== String(tunnel.serverAddr ?? '')
      || formPort !== Number(tunnel.serverPort ?? 0)
      || (typeof liveName === 'string' && liveName.length > 0 && liveName !== formName)
      || !proxies.some(proxy => proxy.name === formName && proxy.type === (form.frp.mode === 'entry' ? 'tcp' : form.frp.mode))
      || (form.frp.mode === 'xtcp' && !proxies.some(proxy => proxy.name === `${formName}-stcp` && proxy.type === 'stcp'))
      || expectsEntry !== (entryProxy !== undefined)
      || (expectsEntry && form.frp.remotePort !== entryProxy?.remotePort))

  const Root = as
  return (
    <Root className={`dshr-card${open ? ' open' : ''}`}>
      <button type="button" className="dshr-head" aria-expanded={open} onClick={() => { setOpen(v => !v) }}>
        <span className="dshr-copy">
          <span className="dshr-name">DSH Remote</span>
          <span className="dshr-desc">
            手机远程访问本机 DSH：支持 xtcp + stcp 访客通道，并可同时启用指定公网端口供浏览器访问。
            {status !== undefined && status !== null
              ? (
                <span className="dshr-desc-inline">
                  <span className={`dshr-dot${gatewayRunning ? ' ok' : ''}`} />
                  {gatewayRunning ? `运行中 · ${String(status.deviceCount ?? '?')} 台设备` : '网关未运行'}
                </span>
              )
              : null}
          </span>
        </span>
        <span className="dshr-chevron" aria-hidden="true" />
      </button>

      {open && form !== null
        ? (
          <div className="dshr-body">
            <div className="dshr-section">常规</div>
            <Row label="DSH 启动时自动拉起网关">
              <Toggle checked={form.autoStart} ariaLabel="DSH 启动时自动拉起网关" onChange={v => { patchForm({ autoStart: v }) }} />
            </Row>

            <div className="dshr-section">远程隧道</div>
            <Row label="启用 frp 隧道" hint="需要 VPS 上已部署 frps；手机凭访客密钥连入，无需扫码">
              <Toggle checked={form.frp.enabled} ariaLabel="启用 frp 隧道" onChange={v => { patchForm({ frp: { ...form.frp, enabled: v } }) }} />
            </Row>
            {form.frp.enabled
              ? (
                <>
                  <TextField
                    label="VPS 地址"
                    placeholder="例如 1.2.3.4"
                    value={form.frp.serverAddr}
                    onChange={v => { patchForm({ frp: { ...form.frp, serverAddr: v } }) }}
                  />
                  <TextField
                    label="控制端口"
                    placeholder="7000"
                    value={String(form.frp.serverPort ?? '')}
                    onChange={v => {
                      const n = Number(v)
                      patchForm({ frp: { ...form.frp, serverPort: Number.isFinite(n) ? n : 0 } })
                    }}
                    hint="必须与 VPS frps.toml 的 bindPort 完全一致，不是默认 7000"
                  />
                  <TextField
                    label="隧道名"
                    placeholder="dsh-remote"
                    value={form.frp.name ?? ''}
                    onChange={v => { patchForm({ frp: { ...form.frp, name: v } }) }}
                    hint="写进 frps 的 proxy 名。多人共用一台 VPS 时必须互不相同；手机填同一名字（扫码会自动带上）。仅字母开头，字母数字和 - _，最多 32 位。留空则用 dsh-remote。"
                  />
                  <Row label="隧道模式">
                    <select className="dshr-input" aria-label="隧道模式" value={form.frp.mode}
                      onChange={event => { patchForm({ frp: { ...form.frp, mode: event.target.value } }) }}>
                      <option value="xtcp">打洞优先，失败中转</option>
                      <option value="stcp">访客中转</option>
                      <option value="entry">仅公网入口</option>
                    </select>
                  </Row>
                  {form.frp.mode !== 'entry'
                    ? <Row label="同时启用公网端口映射" hint="保留访客通道；浏览器访问公网入口时输入同一访客密钥">
                        <Toggle checked={form.frp.entryEnabled} ariaLabel="同时启用公网端口映射"
                          onChange={v => { patchForm({ frp: { ...form.frp, entryEnabled: v } }) }} />
                      </Row>
                    : null}
                  {expectsEntry
                    ? <TextField label="公网入口端口" placeholder="8443" value={String(form.frp.remotePort ?? '')}
                        onChange={v => { patchForm({ frp: { ...form.frp, remotePort: Number(v) } }) }}
                        hint="frps 必须允许该端口，防火墙和云安全组也需放行；默认自签证书会提示浏览器告警" />
                    : null}
                  <TextField
                    label="登录密钥"
                    password
                    value={authToken}
                    onChange={setAuthToken}
                    hint="与 VPS frps.toml 的 auth.token 一致"
                  />
                  <TextField
                    label="访客密钥"
                    password
                    value={visitorKey}
                    onChange={setVisitorKey}
                    hint="可自定义，建议使用较长的随机密钥。Android 和公网网页使用同一密钥；修改并保存后，浏览器需重新验证，Android 也需更新密钥。"
                  />
                  {tunnel !== null
                    ? (
                      <div className="dshr-tunnel">
                        <span className="dshr-label">网关生成的隧道配置</span>
                        <p className="dshr-hint">
                          保存并重启后生效。手机的 VPS、控制端口和访客隧道名应与这里一致。
                        </p>
                        <div className="dshr-proxy">
                          {`${String(tunnel.serverAddr)}:${String(tunnel.serverPort)}`}
                          {"\n"}
                          {Array.isArray(tunnel.proxies) && tunnel.proxies.length > 0
                            ? proxies.map(proxy => `${proxy.name} · ${proxy.type}${proxy.remotePort ? ` · 公网端口 ${proxy.remotePort}` : ''}`).join("\n")
                            : "尚未解析到 [[proxies]]"}
                          {"\n"}
                          {tunnel.dualProxy === true ? "已配置 xtcp 打洞 + stcp 降级" : ""}
                        </div>
                        {tunnelMismatch
                          ? <div className="dshr-note">输入框和网关生成的配置不一致。请点保存并重启网关；只点「重启网关」不会保存输入框里的改动。</div>
                          : null}
                      </div>
                    )
                    : <p className="dshr-hint">尚未生成 frpc.toml。保存并重启网关后会出现 xtcp + stcp 两条代理。</p>}
                </>
              )
              : null}

            <div className="dshr-actions">
              <button type="button" className="dshr-btn primary" disabled={busy !== null} onClick={() => { void save() }}>
                {busy === 'save' ? '保存中…' : '保存并重启网关'}
              </button>
              <button type="button" className="dshr-btn" disabled={busy !== null} onClick={() => { void restartGateway() }}>
                {busy === 'restart' ? '重启中…' : '重启网关'}
              </button>
            </div>

            {publicUrl !== null ? <div className="dshr-code">公网访问：<a href={publicUrl} target="_blank" rel="noreferrer">{publicUrl}</a><p className="dshr-hint">在网页中输入上方设置的访客密钥即可进入。</p></div> : null}

            {message !== null ? <div className={`dshr-note${message.kind === 'ok' ? ' ok' : ''}`}>{message.text}</div> : null}
          </div>
        )
        : null}
    </Root>
  )
}

/** 0.2.x 设置页 tab 容器：渲染在 div.panel 里，避免 <li> 裸根。 */
function DshRemoteSettingsTab() {
  return <DshRemoteSettingsCard as="div" />
}

/** 必需服务：槽位注册器。移动端适配由 Android App 注入完成（见 android 壳），插件不再参与。 */
export const inject = ['slots']
export const name = 'dsh-remote-plugin'

export function apply(ctx: ClientContext): void {
  // PLG-07：ctx dispose（HMR 重载/插件卸载）时移除本插件注入的卡片样式，
  // 防重复注入。loader 侧对 data-plugin 标签已有清理，按 id 移除幂等兜底。
  ctx.effect?.(() => () => {
    if (typeof document !== 'undefined') document.getElementById(STYLE_TAG_DOM_ID)?.remove()
  }, 'dsh-remote-plugin: card styles')
  try {
    ctx.slots.inject('settings.plugin.item', () => {
      try {
        // key 必须等于宿主半边 settings.register 的命名空间（dsh-remote）：
        // 设置页只渲染 describe() 返回命名空间里能对上 key 的卡片。
        return ctx.slots.register(
          { name: 'settings.plugin.item', id: 'dsh-remote', key: 'dsh-remote', order: 40 },
          DshRemoteSettingsCard as never,
        )
      } catch (error) {
        console.error('dsh-remote: settings card register failed', error)
        return () => {}
      }
    })
  } catch (error) {
    console.error('dsh-remote: settings card inject failed', error)
  }
  // 0.2.0+ 宿主：插件设置页改版——卡片槽 settings.plugin.item 被 tab 列表槽
  // settings.plugins.tab 取代（tab 需要显式 label；单一贡献时整页直显，见
  // ui-settings-plugins 的 PluginsSettingsSection）。旧槽位在 0.2.x 不再被
  // 渲染、新槽位在 0.1.x 不存在，双注册互不干扰，两代宿主各取所需。
  try {
    ctx.slots.inject('settings.plugins.tab', () => {
      try {
        return ctx.slots.register(
          { name: 'settings.plugins.tab', id: 'dsh-remote', order: 40, label: 'DSH Remote' },
          DshRemoteSettingsTab as never,
        )
      } catch (error) {
        console.error('dsh-remote: settings tab register failed', error)
        return () => {}
      }
    })
  } catch (error) {
    console.error('dsh-remote: settings tab inject failed', error)
  }
}
