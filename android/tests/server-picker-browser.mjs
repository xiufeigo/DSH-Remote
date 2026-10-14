// Real Chromium DOM behavior; the bridge is recorded, never mistaken for a real server connection.
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
const source = readFileSync(new URL('../app/src/main/res/raw/server_picker.js', import.meta.url), 'utf8');
const fixture = `<!doctype html><style>
body{margin:0;font:14px Arial;background:#fff;color:#222}
[data-slot=sidebar]{box-sizing:border-box;display:flex;flex-direction:column;width:300px;height:800px;padding:16px;background:#f7f8fa}
.brand{height:48px;display:flex;align-items:center;justify-content:space-between}
.brand button{border:0;background:none}.new{height:38px;border:1px solid #eee;border-radius:12px;margin:0 2px 8px;background:white}
[data-sidebar-collapsed] [data-slot=sidebar]{width:68px}
[data-sidebar-collapsed] .new{width:36px;height:36px;padding:0}
[data-sidebar-collapsed] .new span{display:none}
</style><div id="frame"><aside data-slot="sidebar"><div class="sidebar-root" style="display:flex;flex-direction:column">
<div class="brand" data-window-drag="true"><button aria-label="新会话"><svg viewBox="0 0 24 24" width="24" height="24"><path d="M2 8h20v8H2z"/></svg><b>deepseek HARNESS</b></button><button aria-label="收起侧栏">◧</button></div>
<button class="new" aria-label="新会话"><span>＋ 新会话</span></button><nav>插件<br>自动化任务</nav>
</div></aside></div><button id="outside">其他操作</button>`;
const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(fixture); });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
const portServer = createServer();
portServer.listen(0, '127.0.0.1');
await once(portServer, 'listening');
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
const profile = mkdtempSync(join(tmpdir(), 'dshr-picker-'));
const child = spawn(chrome, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new',
  '--no-first-run', '--disable-extensions', '--disable-background-networking', '--window-size=1200,900', 'about:blank'],
  { stdio: 'ignore' });
const exited = once(child, 'exit');
const deadline = setTimeout(() => { child.kill(); }, 60000);
let ws;
let sequence = 0;
const pending = new Map();
let checks = 0;
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
async function check(expression, message) {
  assert.equal(await evaluate(expression), true, message);
  checks++;
  console.log('ok ' + message);
}
const settle = 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))';
const data = { currentName: '家里', entries: [
  { kind: 'direct', id: 'A', name: '家里', detail: '直连 · home.example', enabled: true, current: true, status: 'up' },
  { kind: 'tunnel', id: 'B', name: '<img src=x onerror=alert(1)>', detail: '隧道 · vps.example', enabled: true, current: false, status: 'idle' },
  { kind: 'tunnel', id: 'C', name: '未完成配置', detail: '隧道', enabled: false, current: false, status: 'down' },
] };
const inject = (snapshot = data) => `${source}(${JSON.stringify(snapshot)},(kind,id)=>window.calls.push({kind,id}))`;
try {
  let target;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json(); break; }
    catch (error) { if (attempt === 99) throw error; await new Promise(r => setTimeout(r, 100)); }
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
  await evaluate(`new Promise(r=>{if(document.readyState==='complete')r();else addEventListener('load',r,{once:true})})`);
  await evaluate(`window.calls=[];window.brandBefore=document.querySelector('.brand').outerHTML;window.newBefore=document.querySelector('.new').outerHTML;window.brandRect=JSON.stringify(document.querySelector('.brand').getBoundingClientRect().toJSON());`);
  await evaluate(inject());
  await evaluate(settle);
  await check(`document.querySelector('.brand').outerHTML===brandBefore && document.querySelector('.new').outerHTML===newBefore && JSON.stringify(document.querySelector('.brand').getBoundingClientRect().toJSON())===brandRect`, 'official brand and new-session nodes untouched; brand geometry identical');
  await check(`document.querySelector('.new').previousElementSibling.id==='dshr-server-picker'`, 'picker inserted immediately above official new session');
  await check(`document.querySelector('#dshr-server-picker button').getBoundingClientRect().width===document.querySelector('.new').getBoundingClientRect().width && document.querySelector('#dshr-server-picker button').getBoundingClientRect().height===document.querySelector('.new').getBoundingClientRect().height`, 'picker matches official button width and height');
  await evaluate(inject());
  await evaluate(settle);
  await check(`document.querySelectorAll('#dshr-server-picker').length===1 && document.querySelectorAll('#dshr-server-menu').length===1`, 'repeated injection updates without duplication');
  await evaluate(`document.querySelector('#dshr-server-picker button').click()`);
  await check(`!document.querySelector('#dshr-server-menu').hidden && document.querySelectorAll('[role=menuitemradio]').length===3 && document.querySelectorAll('[role=menuitemradio][aria-checked=true]').length===1`, 'menu lists all servers and marks exactly the current one');
  await check(`document.querySelector('#dshr-server-picker .dshr-server-dot').dataset.status==='up' && [...document.querySelectorAll('.dshr-server-status')].map(node=>node.dataset.status).join(',')==='up,idle,down'`, 'status dots distinguish reachable, idle and unavailable servers');
  await check(`document.querySelectorAll('#dshr-server-menu img').length===0 && document.querySelectorAll('[role=menuitemradio]')[1].textContent.includes('<img')`, 'saved names rendered as text without HTML execution');
  await check(`document.querySelectorAll('[role=menuitemradio]')[2].disabled`, 'invalid configuration cannot be clicked');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`);
  await check(`document.activeElement===document.querySelectorAll('[role=menuitemradio]')[1]`, 'keyboard navigation skips disabled configurations');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await check(`document.querySelector('#dshr-server-menu').hidden && document.activeElement===document.querySelector('#dshr-server-picker button')`, 'Escape closes and returns focus');
  await evaluate(`document.querySelector('#dshr-server-picker button').click();document.querySelector('[role=menuitemradio]').click()`);
  await check(`calls.length===0 && document.querySelector('#dshr-server-menu').hidden`, 'current server closes without reconnecting');
  await evaluate(`document.querySelector('#dshr-server-picker button').click();document.querySelectorAll('[role=menuitemradio]')[1].click()`);
  await check(`calls.length===1 && calls[0].kind==='tunnel' && calls[0].id==='B' && document.querySelector('#dshr-server-picker button').disabled`, 'selection dispatches only kind and ID; prevents repeated switching');
  await evaluate(inject(Object.assign({}, data, { switching: true })));
  await check(`document.querySelector('#dshr-server-picker button').disabled && document.querySelector('.dshr-server-name').textContent==='正在切换…'`, 'snapshot keeps an in-flight switch pending');
  await evaluate(inject());
  await check(`!document.querySelector('#dshr-server-picker button').disabled && document.querySelector('.dshr-server-name').textContent==='家里'`, 'clearing the switch flag restores the trigger');
  await evaluate(inject());
  await evaluate(`document.querySelector('#dshr-server-picker button').click();document.querySelector('#outside').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
  await check(`document.querySelector('#dshr-server-menu').hidden`, 'outside pointer closes menu');
  await evaluate(`document.querySelector('#dshr-server-picker button').click()`);
  await check(`__dshRemoteServerPicker.closeIfOpen()===true && __dshRemoteServerPicker.closeIfOpen()===false`, 'native Back consumes only an open picker');
  await evaluate(`document.querySelector('#frame').setAttribute('data-sidebar-collapsed','')`);
  await evaluate(settle);
  await check(`document.querySelector('#dshr-server-picker').hidden`, 'collapsed official rail hides picker');
  await evaluate(`document.querySelector('#frame').removeAttribute('data-sidebar-collapsed')`);
  await evaluate(settle);
  await check(`!document.querySelector('#dshr-server-picker').hidden`, 'expanded rail restores picker');
  await evaluate(`window.official=document.querySelector('.sidebar-root').cloneNode(true);official.querySelector('#dshr-server-picker').remove();document.querySelector('.sidebar-root').replaceWith(official)`);
  await evaluate(settle);
  await check(`document.querySelectorAll('#dshr-server-picker').length===1 && document.querySelector('.new').previousElementSibling.id==='dshr-server-picker'`, 'React-like sidebar replacement remounts exactly once');
  await evaluate(`window.edits=[];__dshRemoteServerPicker.update(${JSON.stringify(data)},(kind,id)=>window.calls.push({kind,id}),(op,payload)=>{window.edits.push(op);if(op==='load')return JSON.stringify({ok:true,kind:payload.kind,id:payload.id,name:'家里',host:'1.2.3.4',port:'7000',tunnel:'dsh-remote',token:'secret',sk:'secret',strategy:'p2p',p2pEnabled:true,relayEnabled:true});if(op==='save'&&!payload.host)return JSON.stringify({ok:false,error:'请填写完整'});return JSON.stringify({ok:true,connect:false});})`);
  await evaluate(`document.querySelector('#dshr-server-picker button').click()`);
  await check(`!!document.querySelector('.dshr-server-add') && document.querySelectorAll('[role=menuitemradio]').length===3`, 'editor adds a row without changing the server list');
  await evaluate(`document.querySelectorAll('.dshr-server-edit')[1].click()`);
  await check(`document.querySelector('#dshr-server-menu').textContent.includes('编辑服务器') && [...document.querySelectorAll('#dshr-server-menu input')].some(input=>input.value==='secret') && !document.querySelector('#dshr-server-menu').textContent.includes('secret')`, 'edit stays in the floating menu and fills the fields without printing the secret as text');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await check(`document.querySelector('#dshr-server-menu').textContent.includes('切换服务器') && !document.querySelector('#dshr-server-menu').hidden`, 'Escape from the form returns to the list');
  await evaluate(`document.querySelector('.dshr-server-add').click();document.querySelector('.dshr-server-save').click()`);
  await check(`document.querySelector('.dshr-server-error').textContent==='请填写完整'`, 'incomplete save stays on the form and shows the reason');
  await evaluate(`__dshRemoteServerPicker.destroy()`);
  await check(`!document.querySelector('[id^="dshr-server-"]') && !window.__dshRemoteServerPicker`, 'phone transition removes all picker DOM, styles and API');
  await evaluate(`document.querySelector('.sidebar-root').remove();`);
  await evaluate(inject({ currentName: 'home.example', entries: [] }));
  await evaluate(settle);
  await check(`!document.querySelector('#dshr-server-picker')`, 'no sidebar leaves official page untouched');
  await evaluate(`document.querySelector('[data-slot=sidebar]').appendChild(official)`);
  await evaluate(settle);
  await check(`document.querySelector('#dshr-server-picker')!==null`, 'late sidebar mount is observed without polling');
  await evaluate(`document.querySelector('#dshr-server-picker button').click()`);
  await check(`document.querySelector('#dshr-server-menu').textContent==='尚未保存服务器'`, 'empty saved list has an explicit state');
  console.log(`Server picker browser tests passed: ${checks}`);
} finally {
  clearTimeout(deadline);
  if (ws?.readyState === WebSocket.OPEN) { await call('Browser.close'); ws.close(); }
  else child.kill();
  await exited;
  await new Promise(resolve => server.close(resolve));
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
