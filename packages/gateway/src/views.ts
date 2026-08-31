/**
 * 网关自带页面的 HTML 模板（配对页 / edge 登录页）。
 *
 * 全部为纯函数：入参只有页面数据（next 回跳、锁定态、请求头特征），
 * 不触碰 Store / 配置。配对页可被未认证访问，因此渲染走纯静态模板 +
 * safeNext 白名单，无任何注入面（GW-15 的 XSS 护栏也在这里）。
 *
 * 三种页面：
 * - renderDefaultPairPage / renderTokenLoginPage：深色卡片同族（F15 合并
 *   为参数化单模板 renderCardAuthPage，两者 CSS/骨架原先 ~90% 相同）；
 * - renderAndroidPairPage：Android WebView 专用 Material 风格，有意另立
 *   （有独立的品牌头/标签/浅色主题），不做合并。
 */

import type { IncomingMessage } from "node:http";
import { LOGIN_PAGE, PAIR_PAGE } from "./auth.ts";

/** Android 壳 WebView 的 UA 特征（配对页切换 Material 风格版式）。 */
export function isDshRemoteAndroid(req: IncomingMessage): boolean {
	return String(req.headers["user-agent"] ?? "").includes("DSHRemoteAndroid/1");
}

/** 从 User-Agent 推导设备显示名（Token 登录自动配对时缺省名称）。 */
export function deriveDeviceName(req: IncomingMessage): string {
	const ua = String(req.headers["user-agent"] ?? "");
	if (/iPad/i.test(ua)) return "iPad · 浏览器";
	if (/iPhone/i.test(ua)) return "iPhone · 浏览器";
	if (/Android/i.test(ua)) return "Android · 浏览器";
	if (/Macintosh/i.test(ua)) return "Mac · 浏览器";
	if (/Windows/i.test(ua)) return "Windows · 浏览器";
	return "浏览器设备";
}

/**
 * 配对页回跳地址白名单校验。
 * 只允许路径与基础 URL 字符；显式排除引号/反斜杠/尖括号等，
 * 杜绝经 `location.href='${next}'` 注入 JS 的 XSS（配对页可被未认证访问）。
 */
export function safeNext(raw: string | null): string {
	if (raw === null || raw === "") return "/";
	// GW-15：长度上限 512，拒绝超长 next（匹配成本与回跳参数都界化）
	if (raw.length > 512) return "/";
	if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
	if (!/^[A-Za-z0-9\-._~!$&()*+,;=:@%?+\/]+$/.test(raw.slice(1))) return "/";
	return raw;
}

// ---------- 深色卡片同族页面（F15 参数化合并） ----------

/** 提交脚本的可变部分：目标端点、凭据字段与失败文案（pair/login 两页仅差这三处）。 */
interface AuthSubmitSpec {
	endpoint: string;
	field: "code" | "token";
	failLabel: string;
}

/** 配对/登录共用的提交脚本：POST JSON → 成功跳 next，失败展示后端 message。 */
function authSubmitScript(next: string, locked: boolean, spec: AuthSubmitSpec): string {
	return `<script>
async function submit(){
 const err=document.getElementById('err');
 err.textContent='';
 const r=await fetch('${spec.endpoint}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({${spec.field}:document.getElementById('${spec.field}').value.trim(),name:document.getElementById('name').value})});
 if(r.ok){location.href=${JSON.stringify(next)};return;}
 const j=await r.json().catch(()=>({}));
 err.textContent= j.message ?? ('${spec.failLabel} ('+r.status+')');
}
document.getElementById('${spec.field}').addEventListener('keydown',e=>{if(e.key==='Enter')submit()});
${locked ? "document.getElementById('err').textContent='失败次数过多，请稍后再试';" : ""}
</script>`;
}

/** 深色卡片骨架的可变部分（两页仅差文案/输入框/CSS 一行）。 */
interface CardAuthPageOptions {
	title: string;
	/** 标题下的说明段（可含 <code> 等行内标记）。 */
	lead: string;
	/** 输入框元素 HTML（凭据框 + 设备名框）。 */
	inputs: string;
	buttonLabel: string;
	/** 追加到 input 规则的 CSS 片段（配对页输入大写化用）。 */
	inputExtraCss: string;
	script: string;
}

function renderCardAuthPage(options: CardAuthPageOptions): string {
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${options.title}</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#101418;color:#e8eaed;display:flex;justify-content:center;padding-top:12vh;margin:0}
 .card{background:#1a2027;border-radius:16px;padding:32px;width:min(92vw,380px)}
 h1{font-size:20px;margin:0 0 8px} p{color:#9aa4af;font-size:13px;line-height:1.6;margin:0 0 20px}
 input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #2c3641;background:#0d1115;color:#fff;font-size:16px;margin-bottom:12px${options.inputExtraCss}}
 button{width:100%;padding:12px;border:none;border-radius:10px;background:#1b66ff;color:#fff;font-size:15px;font-weight:600}
 .err{color:#ff6b6b;font-size:13px;min-height:18px;margin-bottom:8px}
</style></head><body><div class="card">
<h1>DSH Remote</h1><p>${options.lead}</p>
<div class="err" id="err"></div>
${options.inputs}
<button onclick="submit()">${options.buttonLabel}</button>
${options.script}</div></body></html>`;
}

/** 默认配对页（浏览器）：一次性配对码 + 设备名。 */
export function renderDefaultPairPage(next: string, locked: boolean): string {
	return renderCardAuthPage({
		title: "DSH Remote · 设备配对",
		lead: "新设备需要配对。在电脑终端运行 <code>dsh-remote pair</code> 获取一次性配对码，输入后本设备将被授权访问。",
		inputs: `<input id="code" placeholder="配对码（如 XK4M-P2VW）" autocomplete="off" autocapitalize="characters">
<input id="name" placeholder="设备名称（如 我的手机）">`,
		buttonLabel: "配对",
		inputExtraCss: ";text-transform:uppercase",
		script: authSubmitScript(next, locked, { endpoint: PAIR_PAGE, field: "code", failLabel: "配对失败" }),
	});
}

/**
 * edge 前置 Token 登录页。观感与默认配对页同族（深色卡片）；
 * 未认证可访问，因此渲染走纯静态模板 + safeNext 白名单，无任何注入面。
 */
export function renderTokenLoginPage(next: string, locked: boolean): string {
	return renderCardAuthPage({
		title: "DSH Remote · 访问验证",
		lead: "此入口受访问 Token 保护。输入服务器上配置的 Token，验证通过后本设备将被授权并长期保持登录。",
		inputs: `<input id="token" type="password" placeholder="访问 Token" autocomplete="off">
<input id="name" placeholder="设备名称（可选，如 我的 iPad）">`,
		buttonLabel: "验证并进入",
		inputExtraCss: "",
		script: authSubmitScript(next, locked, { endpoint: LOGIN_PAGE, field: "token", failLabel: "验证失败" }),
	});
}

/** Android WebView 配对页：Material 风格浅色版式（品牌头 + 表单标签），有意与桌面卡片版式另立。 */
export function renderAndroidPairPage(next: string, locked: boolean): string {
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>DSH Remote · 设备配对</title>
<style>
 :root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
 *{box-sizing:border-box}html,body{min-height:100%;margin:0}body{color:#111318;background:#fff}
 main{min-height:100vh;display:flex;flex-direction:column;padding:max(20px,env(safe-area-inset-top)) 24px max(28px,env(safe-area-inset-bottom))}
 header{display:flex;align-items:center;gap:10px;font-size:19px;font-weight:650;line-height:28px}header img{width:30px;height:30px}header small{display:inline-flex;align-items:center;min-height:17px;padding:1px 5px;border-radius:3px;background:#111318;color:#fff;font-size:10px;line-height:1}
 section{width:min(100%,360px);margin:auto;transform:translateY(-7vh)}h1{margin:0;font-size:24px;font-weight:650;line-height:1.35}p{margin:10px 0 26px;color:#73777f;font-size:14px;line-height:1.65}label{display:block;margin:0 0 7px;font-size:13px;font-weight:600}input{display:block;width:100%;min-height:48px;margin:0 0 17px;padding:0 12px;border:1px solid #d9dde5;border-radius:7px;background:#fff;color:#111318;font:inherit;font-size:16px;outline:none}input:focus{border-color:#111318;box-shadow:0 0 0 2px rgba(17,19,24,.12)}#code{text-transform:uppercase}.err{min-height:20px;margin:0 0 10px;color:#b33b3b;font-size:13px;line-height:20px}button{width:100%;min-height:48px;border:1px solid #111318;border-radius:7px;background:#111318;color:#fff;font:inherit;font-size:15px;font-weight:650;cursor:pointer}
</style></head><body><main><header><img src="/__dsh_remote__/brand.svg" alt=""><span>deepseek</span><small>HARNESS</small></header>
<section aria-labelledby="title"><h1 id="title">配对这台设备</h1><p>在电脑终端运行 <code>dsh-remote pair</code> 获取一次性配对码。</p>
<div class="err" id="err" role="status" aria-live="polite"></div>
<label for="code">配对码</label><input id="code" placeholder="如 XK4M-P2VW" autocomplete="off" autocapitalize="characters">
<label for="name">设备名称</label><input id="name" placeholder="如 我的手机" autocomplete="nickname">
<button type="button" onclick="submit()">配对</button>
${authSubmitScript(next, locked, { endpoint: PAIR_PAGE, field: "code", failLabel: "配对失败" })}</section></main></body></html>`;
}
