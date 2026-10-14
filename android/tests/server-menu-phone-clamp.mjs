// Phone drawer: the mobile float clamp must not pull the server menu up over its trigger.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chrome = process.env.CHROME_PATH || [
  join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(existsSync);
assert(chrome, 'Chrome required; set CHROME_PATH');
const picker = readFileSync(new URL('../app/src/main/res/raw/server_picker.js', import.meta.url), 'utf8');
const hook = readFileSync(new URL('../../packages/gateway/assets/mobile-web.js', import.meta.url), 'utf8');
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">
<div id="frame" style="display:grid;grid-template-columns:280px minmax(0,1fr);height:100vh;width:390px;position:relative;overflow:hidden">
  <div id="side" style="overflow:hidden">
    <aside data-slot="sidebar" style="display:flex;flex-direction:column;height:100%;padding:12px;box-sizing:border-box">
      <div class="brand" data-window-drag="true" style="height:48px;display:flex;align-items:center">
        <button aria-label="新会话" style="height:40px">deepseek</button>
        <button aria-label="收起侧栏" style="height:32px">收起</button>
      </div>
      <button class="new" aria-label="新会话" style="height:40px;margin:0 0 8px">新会话</button>
      <nav>会话列表</nav>
    </aside>
  </div>
  <div id="main" style="display:flex;flex-direction:column;min-height:100vh">
    <div style="height:220px"></div>
    <div data-composer-card="true" style="height:120px;margin:12px">输入</div>
  </div>
</div>
<div id="official-menu" role="menu" style="position:fixed;left:16px;top:120px;width:200px;height:420px;background:#fff">官方菜单</div>
</body></html>`;
const server = createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(fixture); });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/`;
const portServer = createServer();
portServer.listen(0, '127.0.0.1');
await once(portServer, 'listening');
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
const profile = mkdtempSync(join(tmpdir(), 'dshr-clamp-'));
const child = spawn(chrome, [
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new',
  '--no-first-run', '--disable-extensions', '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' });
const exited = once(child, 'exit');
const deadline = setTimeout(() => child.kill(), 45000);
let ws;
let sequence = 0;
const pending = new Map();
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const data = { currentName: '铭凡', entries: [
  { kind: 'tunnel', id: 'A', name: '铭凡', detail: '隧道 · 8.138.19.15', enabled: true, current: true },
  { kind: 'tunnel', id: 'B', name: '机械君', detail: '隧道 · 8.138.19.15', enabled: true, current: false },
  { kind: 'direct', id: 'C', name: 'DSH 服务器', detail: '直连 · deepseek-harness.xiufeigo.xyz', enabled: true, current: false },
] };
const measure = `(()=>{
  const t=document.querySelector('#dshr-server-picker button').getBoundingClientRect();
  const m=document.querySelector('#dshr-server-menu');
  const b=m.getBoundingClientRect();
  const official=document.querySelector('#official-menu');
  return JSON.stringify({
    overlap: b.top < t.bottom - 1,
    gap: Math.round(b.top - t.bottom),
    tBottom: Math.round(t.bottom),
    mTop: Math.round(b.top),
    mBottom: Math.round(b.bottom),
    widthMatch: Math.abs(b.width - t.width) <= 1,
    leftMatch: Math.abs(b.left - t.left) <= 1,
    marked: m.hasAttribute('data-dshr-float'),
    officialMarked: official.hasAttribute('data-dshr-float'),
    officialTop: Math.round(official.getBoundingClientRect().top)
  });
})()`;
try {
  let target;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json(); break; }
    catch (error) { if (attempt === 79) throw error; await new Promise(r => setTimeout(r, 100)); }
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, 'open');
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  });
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate(`new Promise(r=>{if(document.readyState==='complete')r();else addEventListener('load',r,{once:true})})`);
  await evaluate(`window.__DSHR_MOBILE__={device:'phone',breakpoint:1024};`);
  await evaluate(hook);
  await evaluate(`new Promise(r=>setTimeout(r,300))`);
  assert.equal(await evaluate(`document.documentElement.classList.contains('dshr-mobile')`), true, 'phone hook enabled');
  await evaluate(`${picker}(${JSON.stringify(data)},function(){})`);
  await evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  await evaluate(`document.querySelector('#dshr-server-picker button').click()`);
  const immediate = JSON.parse(await evaluate(measure));
  assert.equal(immediate.overlap, false, 'menu must not cover the trigger on the first frame: ' + JSON.stringify(immediate));
  await evaluate(`new Promise(r=>setTimeout(r,600))`);
  const later = JSON.parse(await evaluate(measure));
  console.log(JSON.stringify(later));
  assert.equal(later.overlap, false, 'menu must stay under the trigger after the float clamp runs: ' + JSON.stringify(later));
  assert.equal(later.marked, false, 'server menu must not be rewritten by the float clamp');
  assert.ok(later.gap >= 4 && later.gap <= 10, 'menu stays one small gap under the trigger: ' + JSON.stringify(later));
  assert.equal(later.widthMatch, true, 'menu width still matches the trigger');
  assert.equal(later.leftMatch, true, 'menu left edge still matches the trigger');
  assert.equal(later.officialMarked, true, 'official menus are still clamped');
  assert.ok(later.officialTop < 120, 'official menu was actually moved, not merely marked: ' + JSON.stringify(later));
  console.log('server menu stays under the trigger after the phone float clamp');
} finally {
  clearTimeout(deadline);
  if (ws && ws.readyState === WebSocket.OPEN) { try { await call('Browser.close'); } catch { /* already closed */ } ws.close(); }
  else child.kill();
  await exited;
  await new Promise(resolve => server.close(resolve));
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
}
