/**
 * DSH-Remote —— 浏览器半边：设置 → 插件 里的配置卡片。
 *
 * 与 dsh-explorer 同一套接入方式：slots.inject("settings.plugin.item") 注册卡片；
 * 数据不走 localStorage（那些值必须落在 PC 的 config.json），而是通过插件宿主
 * 半边注册在 DSH webServer 上的 /dsh-remote/config 路由读写，保存后宿主会
 * 自动重启网关子进程生效。
 */

import { useCallback, useEffect, useState } from 'react'

interface SlotsLike {
  inject(name: string, callback: () => unknown): void
  register(options: Record<string, unknown>, component: unknown): unknown
}

interface ClientContext {
  slots: SlotsLike
}

async function fetchJson(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  return await response.json()
}

// ── 轻量内联样式（避免引入 CSS 构建管线） ──────────────────────────

const styles = {
  card: { listStyle: 'none' as const },
  head: {
    display: 'flex', alignItems: 'center', gap: 12, width: '100%',
    background: 'transparent', border: 'none', cursor: 'pointer',
    padding: '12px 4px', textAlign: 'left' as const, color: 'inherit',
  },
  name: { fontWeight: 600, fontSize: 14 },
  desc: { fontSize: 12, opacity: 0.65, marginTop: 2 },
  chevron: (open: boolean) => ({
    marginLeft: 'auto', transition: 'transform .15s',
    transform: open ? 'rotate(90deg)' : 'rotate(0deg)', fontSize: 12, opacity: 0.6,
  }),
  body: { padding: '4px 8px 16px', borderTop: '1px solid rgba(128,128,128,.25)' },
  sectionTitle: { fontSize: 12, fontWeight: 700, opacity: 0.7, margin: '14px 0 6px' },
  field: { display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0' },
  label: { minWidth: 110, fontSize: 13 },
  hint: { fontSize: 11, opacity: 0.55 },
  input: {
    flex: 1, maxWidth: 220, padding: '5px 8px', borderRadius: 6,
    border: '1px solid rgba(128,128,128,.4)', background: 'rgba(127,127,127,.08)',
    color: 'inherit', fontSize: 13,
  },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '10px 0' },
  statusDot: (ok: boolean) => ({
    display: 'inline-block', width: 8, height: 8, borderRadius: 4,
    marginRight: 6, background: ok ? '#22c55e' : '#9ca3af',
  }),
  button: (primary: boolean) => ({
    padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
    border: primary ? 'none' : '1px solid rgba(128,128,128,.45)',
    background: primary ? '#1b66ff' : 'rgba(127,127,127,.15)',
    color: primary ? '#fff' : 'inherit',
  }),
  codeBox: {
    marginTop: 8, padding: 10, borderRadius: 8, fontSize: 13,
    background: 'rgba(27,102,255,.1)', border: '1px solid rgba(27,102,255,.35)',
  },
  error: { color: '#ef4444', fontSize: 12, marginTop: 6 },
} as const

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => { onChange(!checked) }}
      style={{
        width: 40, height: 22, borderRadius: 11, position: 'relative', cursor: 'pointer',
        border: 'none', background: checked ? '#1b66ff' : 'rgba(127,127,127,.4)',
        transition: 'background .15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 3, left: checked ? 21 : 3,
        width: 16, height: 16, borderRadius: 8, background: '#fff',
        transition: 'left .15s',
      }} />
    </button>
  )
}

function NumberField({ label, value, onChange, hint }: {
  label: string; value: number; onChange: (v: number) => void; hint?: string
}) {
  return (
    <div style={styles.field}>
      <span style={styles.label}>{label}</span>
      <input
        style={styles.input}
        type="number"
        value={Number.isFinite(value) ? value : ''}
        onChange={event => { onChange(Number(event.target.value)) }}
      />
      {hint !== undefined ? <span style={styles.hint}>{hint}</span> : null}
    </div>
  )
}

/** 设置 → 插件 页的 DSH Remote 卡片。 */
export function DshRemoteSettingsCard() {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<any>(null)
  const [status, setStatus] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null)

  const refreshStatus = useCallback(() => {
    fetchJson('/dsh-remote/status').then(setStatus).catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    fetchJson('/dsh-remote/config')
      .then((payload) => {
        // 文件里可能只有部分键；用展示默认值补齐，避免受控组件抖动
        const merged = {
          ...{
            autoStart: true, listenHost: '127.0.0.1', listenPort: 18443,
            upstreamPort: 52392, autoFixUpstreamPort: true,
            frp: { enabled: false, serverAddr: '', serverPort: 7000, remotePort: 8443 },
          },
          ...payload.config,
          frp: { enabled: false, serverAddr: '', serverPort: 7000, remotePort: 8443, ...payload.config?.frp },
        }
        setForm(merged)
      })
      .catch(() => setMessage({ kind: 'err', text: '读取配置失败（插件路由不可达）' }))
    refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    if (!open) return undefined
    const timer = setInterval(refreshStatus, 5000)
    return () => { clearInterval(timer) }
  }, [open, refreshStatus])

  const patchForm = (patch: any): void => {
    setForm((current: any) => ({ ...current, ...patch }))
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setMessage(null)
    try {
      const payload = {
        autoStart: form.autoStart,
        listenHost: form.listenHost,
        listenPort: form.listenPort,
        upstreamPort: form.upstreamPort,
        autoFixUpstreamPort: form.autoFixUpstreamPort,
        frp: {
          enabled: form.frp.enabled,
          serverAddr: String(form.frp.serverAddr ?? '').trim(),
          serverPort: form.frp.serverPort,
          remotePort: form.frp.remotePort,
        },
      }
      const result = await fetchJson('/dsh-remote/config', { method: 'POST', body: JSON.stringify(payload) })
      if (result.ok === true) {
        setMessage({ kind: 'ok', text: '已保存并重启网关（几秒后生效）' })
        setTimeout(refreshStatus, 2500)
      } else {
        setMessage({ kind: 'err', text: Array.isArray(result.errors) ? result.errors.join('；') : '保存失败' })
      }
    } catch (error) {
      setMessage({ kind: 'err', text: `保存失败：${String(error)}` })
    } finally {
      setSaving(false)
    }
  }

  const mintPairCode = async (): Promise<void> => {
    setMessage(null)
    try {
      const result = await fetchJson('/dsh-remote/pair-code', { method: 'POST' })
      if (result.ok === true) setPairing({ code: result.code, expiresAt: result.expiresAt })
      else setMessage({ kind: 'err', text: result.error ?? '生成失败' })
    } catch (error) {
      setMessage({ kind: 'err', text: `生成失败：${String(error)}` })
    }
  }

  const restartGateway = async (): Promise<void> => {
    setMessage(null)
    try {
      await fetchJson('/dsh-remote/restart', { method: 'POST' })
      setMessage({ kind: 'ok', text: '重启指令已发出' })
      setTimeout(refreshStatus, 3000)
    } catch (error) {
      setMessage({ kind: 'err', text: `重启失败：${String(error)}` })
    }
  }

  const gatewayRunning = status?.gatewayRunning === true

  return (
    <li style={styles.card}>
      <button type="button" style={styles.head} aria-expanded={open} onClick={() => { setOpen(v => !v) }}>
        <span>
          <div style={styles.name}>DSH Remote</div>
          <div style={styles.desc}>
            手机远程访问本机 DSH：设备配对、frp 隧道、局域网模式。
            {status !== undefined && status !== null
              ? (
                <span style={{ marginLeft: 8 }}>
                  <span style={styles.statusDot(gatewayRunning)} />
                  {gatewayRunning ? `运行中 · ${String(status.deviceCount ?? '?')} 台设备` : '网关未运行'}
                </span>
              )
              : null}
          </div>
        </span>
        <span style={styles.chevron(open)}>▶</span>
      </button>

      {open && form !== null
        ? (
          <div style={styles.body}>
            <div style={styles.sectionTitle}>常规</div>
            <div style={styles.row}>
              <span style={styles.label}>DSH 启动时自动拉起网关</span>
              <Toggle checked={form.autoStart} onChange={v => { patchForm({ autoStart: v }) }} />
            </div>

            <div style={styles.sectionTitle}>frp 远程隧道</div>
            <div style={styles.row}>
              <div>
                <div style={styles.label}>启用 frp 隧道</div>
                <div style={styles.hint}>需要 VPS 上已部署 frps（见项目 docs/）</div>
              </div>
              <Toggle checked={form.frp.enabled} onChange={v => { patchForm({ frp: { ...form.frp, enabled: v } }) }} />
            </div>
            {form.frp.enabled
              ? (
                <>
                  <div style={styles.field}>
                    <span style={styles.label}>VPS 地址</span>
                    <input
                      style={styles.input}
                      placeholder="例如 1.2.3.4"
                      value={form.frp.serverAddr}
                      onChange={event => { patchForm({ frp: { ...form.frp, serverAddr: event.target.value } }) }}
                    />
                  </div>
                  <NumberField
                    label="控制端口"
                    value={form.frp.serverPort}
                    onChange={v => { patchForm({ frp: { ...form.frp, serverPort: v } }) }}
                    hint="frps bindPort"
                  />
                  <NumberField
                    label="入口端口"
                    value={form.frp.remotePort}
                    onChange={v => { patchForm({ frp: { ...form.frp, remotePort: v } }) }}
                    hint="手机访问的端口"
                  />
                  <div style={styles.hint}>
                    共享密钥在 PC 的 state/secrets.json 与 VPS 的 frps.toml，两端一致即可（安全起见不在面板展示）。
                  </div>
                </>
              )
              : null}

            <div style={styles.sectionTitle}>网络</div>
            <div style={styles.field}>
              <span style={styles.label}>监听面</span>
              <select
                style={styles.input}
                value={form.listenHost}
                onChange={event => { patchForm({ listenHost: event.target.value }) }}
              >
                <option value="127.0.0.1">仅本机（推荐，经 frp 出外网）</option>
                <option value="0.0.0.0">局域网（家庭可信网络直连）</option>
              </select>
            </div>
            <NumberField
              label="上游端口"
              value={form.upstreamPort}
              onChange={v => { patchForm({ upstreamPort: v }) }}
              hint="DSH Web GUI 端口"
            />
            <div style={styles.row}>
              <div>
                <div style={styles.label}>自动跟随端口漂移</div>
                <div style={styles.hint}>DSH 重启换端口时自动探测并回写</div>
              </div>
              <Toggle
                checked={form.autoFixUpstreamPort}
                onChange={v => { patchForm({ autoFixUpstreamPort: v }) }}
              />
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button type="button" style={styles.button(true)} disabled={saving} onClick={() => { void save() }}>
                {saving ? '保存中…' : '保存并重启网关'}
              </button>
              <button type="button" style={styles.button(false)} onClick={() => { void mintPairCode() }}>
                生成配对码
              </button>
              <button type="button" style={styles.button(false)} onClick={() => { void restartGateway() }}>
                重启网关
              </button>
            </div>

            {pairing !== null
              ? (
                <div style={styles.codeBox}>
                  配对码：<b>{pairing.code}</b>（10 分钟有效）
                  <div style={styles.hint}>手机打开网关地址后输入此码完成配对</div>
                </div>
              )
              : null}
            {message !== null ? <div style={styles.error}>{message.text}</div> : null}
          </div>
        )
        : null}
    </li>
  )
}

/** 必需服务：槽位注册器。 */
export const inject = ['slots']
export const name = 'dsh-remote-plugin'

export function apply(ctx: ClientContext): void {
  try {
    ctx.slots.inject('settings.plugin.item', () => {
      try {
        return ctx.slots.register(
          { name: 'settings.plugin.item', id: 'dsh-remote-plugin', key: 'dsh-remote-plugin', order: 40 },
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
}
