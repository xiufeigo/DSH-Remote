/** 真实 frps/frpc 双通道测试；只使用隔离目录和回环端口。缺少二进制时明确失败。 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../packages/gateway/src/config.ts";
import { FrpSupervisor, renderFrpsToml, renderVisitorToml } from "../packages/gateway/src/frp.ts";
import { GatewayServer } from "../packages/gateway/src/server.ts";
import { Store } from "../packages/gateway/src/store.ts";
import { makeTempHome, requestTls, startFakeUpstream, waitFor, wsConnect } from "./test-harness.mjs";

const vendor = join(process.env.USERPROFILE ?? process.env.HOME, ".dsh-remote", "vendor", "frp");
const binary = name => join(vendor, process.platform === "win32" ? `${name}.exe` : name);
await Promise.all([access(binary("frpc")), access(binary("frps"))]);

async function freePort() {
	const probe = net.createServer();
	await new Promise((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", resolve);
	});
	const port = probe.address().port;
	await new Promise(resolve => probe.close(resolve));
	return port;
}

async function assertUpgrade(port, cookie, status) {
	const connection = wsConnect(`wss://127.0.0.1:${port}/ws`, { headers: cookie ? { cookie } : {} });
	try { assert.match(await connection.headersText, new RegExp(`^HTTP/1.1 ${status}`)); }
	finally { connection.close(); }
}

async function checkMode(mode) {
	const home = await makeTempHome(`dshr-dual-${mode}-`);
	const controlPort = await freePort();
	const remotePort = await freePort();
	const visitorPort = await freePort();
	const token = "isolated-frp-auth-token";
	const secretKey = "isolated-frp-visitor-key";
	const name = `dual-${mode}`;
	const logs = [];
	const log = line => logs.push(line);
	const upstream = await startFakeUpstream();
	const store = await Store.open(home);
	await mkdir(join(home, "state"), { recursive: true });
	await writeFile(join(home, "state", "secrets.json"), JSON.stringify({ frpAuthToken: token, frpVisitorKey: secretKey }));
	const frpsPath = join(home, "frps.toml");
	await writeFile(frpsPath, renderFrpsToml({ bindAddr: "127.0.0.1", bindPort: controlPort, authToken: token,
		allowPorts: [{ start: remotePort, end: remotePort }] }));
	const frps = new FrpSupervisor(binary("frps"), frpsPath, log);
	const gateway = new GatewayServer({ store, log, env: {}, config: {
		...structuredClone(DEFAULT_CONFIG), listenPort: 0, upstreamPort: upstream.port, autoFixUpstreamPort: false,
		frp: { ...DEFAULT_CONFIG.frp, enabled: true, mode, entryEnabled: true, remotePort,
			serverAddr: "127.0.0.1", serverPort: controlPort, name, binaryPath: binary("frpc") },
	} });
	const visitorPath = join(home, "visitor.toml");
	await writeFile(visitorPath, renderVisitorToml({ serverAddr: "127.0.0.1", serverPort: controlPort,
		authToken: token, secretKey, serverName: name, mode, bindPort: visitorPort }));
	const visitor = new FrpSupervisor(binary("frpc"), visitorPath, log);
	try {
		frps.start();
		await gateway.start();
		const pcPath = join(home, "frp", "frpc.toml");
		const verify = spawnSync(binary("frpc"), ["verify", "-c", pcPath], { encoding: "utf8", windowsHide: true });
		assert.equal(verify.status, 0, verify.stderr || verify.stdout);
		const proxies = (await readFile(pcPath, "utf8")).split("[[proxies]]").slice(1);
		const entryBlock = proxies.find(block => block.includes('type = "tcp"'));
		const entryLocalPort = Number(/localPort = (\d+)/.exec(entryBlock)[1]);
		assert.notEqual(entryLocalPort, gateway.actualPort);
		visitor.start();
		const publicCall = (path, options) => requestTls(`https://127.0.0.1:${remotePort}${path}`, { timeoutMs: 3000, ...options });
		await waitFor(`${mode} 公网入口`, async () => (await publicCall("/__dsh_remote__/health")).status === 200);
		await waitFor(`${mode} 访客链路`, async () => {
			const res = await requestTls(`https://127.0.0.1:${visitorPort}/`, { timeoutMs: 4000 });
			return res.status === 200 && res.body.includes("__dsh_boot__");
		}, 25000);
		await assertUpgrade(visitorPort, undefined, 101);
		const redirect = await publicCall("/", { headers: { accept: "text/html" } });
		assert.equal(redirect.status, 302);
		assert.match(redirect.headers.location, /^\/__dsh_remote__\/login/);
		const loginPage = await publicCall(redirect.headers.location);
		assert.match(loginPage.body, /aria-label="访客密钥"/);
		assert.ok(!loginPage.body.includes(secretKey));
		assert.equal((await publicCall("/api/test", { headers: { "x-forwarded-for": "127.0.0.1", "x-dshr-public-entry": "false" } })).status, 401);
		assert.equal((await publicCall("/__dsh_remote__/admin/pair-code", { method: "POST" })).status, 403);
		await assertUpgrade(remotePort, undefined, 401);
		const login = token => publicCall("/__dsh_remote__/login", { method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ token, name: "双通道浏览器" }) });
		assert.equal((await login("wrong-visitor-key")).status, 403);
		const loggedIn = await login(secretKey);
		assert.equal(loggedIn.status, 200);
		const cookie = loggedIn.setCookie.split(";")[0];
		assert.match((await publicCall("/", { headers: { cookie } })).body, /__dsh_boot__/);
		await assertUpgrade(remotePort, cookie, 101);
		const [device] = await store.listDevices();
		await store.revokeDevice(device.id);
		assert.equal((await publicCall("/", { headers: { cookie } })).status, 401);
		await assertUpgrade(remotePort, cookie, 401);
		assert.equal((await requestTls(`https://127.0.0.1:${visitorPort}/`, { timeoutMs: 4000 })).status, 200);
		await visitor.stop();
		await gateway.stop();
		await gateway.stop();
		assert.equal(await new Promise(resolve => {
			const socket = net.connect({ host: "127.0.0.1", port: entryLocalPort });
			socket.once("connect", () => { socket.destroy(); resolve(true); });
			socket.once("error", () => resolve(false));
		}), false, "停止网关必须释放附加监听口");
		console.log(`✓ ${mode} + 公网 TCP：真实双通道、访客密钥网页登录、HTTP/WS 与吊销、监听清理通过`);
	} catch (error) {
		console.error(logs.join("\n"));
		throw error;
	} finally {
		await visitor.stop();
		await gateway.stop();
		await frps.stop();
		await upstream.close();
		await rm(home, { recursive: true, force: true });
	}
}

for (const mode of ["stcp", "xtcp"]) await checkMode(mode);
