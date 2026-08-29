#!/usr/bin/env node
/** 对真实网关+真实 DSH 的 WS 直通探针：配对 → 升级 /api/events.mux → 期待 101。 */
import https from "node:https";
import tls from "node:tls";

// CLI-05：缺参数打印用法而非带栈崩溃（原先缺省 18443 直连，网关未运行时 ECONNREFUSED 未捕获）
const portArg = process.argv[2];
if (portArg === undefined) {
	console.log(`用法：node scripts/probe-ws.mjs <网关端口>
示例：node scripts/probe-ws.mjs 18443
对运行中的网关执行：配对获取设备 Cookie → 对 /api/events.mux 与 /api/events.host 发起 WS 升级，期待 101。`);
	process.exit(1);
}
const GW_HOST = "127.0.0.1";
const GW_PORT = Number(portArg);
if (!Number.isInteger(GW_PORT) || GW_PORT <= 0 || GW_PORT > 65535) {
	console.error(`非法端口：${portArg}`);
	process.exit(1);
}

function request(path, { method = "GET", headers = {}, body } = {}) {
	return new Promise((resolve, reject) => {
		const req = https.request(
			{ host: GW_HOST, port: GW_PORT, path, method, headers, rejectUnauthorized: false },
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => resolve({
					status: res.statusCode,
					headers: res.headers,
					body: Buffer.concat(chunks).toString("utf8"),
				}));
			},
		);
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

try {
	// ① 配对
	const pairResp = await request("/__dsh_remote__/admin/pair-code", { method: "POST" });
	const code = JSON.parse(pairResp.body).code;
	const submit = await request("/__dsh_remote__/pair", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code, name: "ws-probe" }),
	});
	if (submit.status !== 200) throw new Error(`配对失败：${String(submit.status)} ${submit.body}`);
	const cookie = /dr_device=[^;]+/.exec(submit.headers["set-cookie"]?.join("; ") ?? "")?.[0];
	if (cookie === undefined) throw new Error("未拿到设备 Cookie");
	console.log("配对成功，Cookie 就绪");

	for (const wsPath of ["/api/events.mux", "/api/events.host"]) {
		await new Promise((resolve, reject) => {
			const socket = tls.connect({ host: GW_HOST, port: GW_PORT, rejectUnauthorized: false }, () => {
				socket.write([
					`GET ${wsPath} HTTP/1.1`,
					`host: ${GW_HOST}:${String(GW_PORT)}`,
					"upgrade: websocket",
					"connection: Upgrade",
					"sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==",
					"sec-websocket-version: 13",
					`cookie: ${cookie}`,
					"\r\n",
				].join("\r\n"));
			});
			// CLI-05：完成/出错路径都要 clearTimeout，探针结束后不再残留 6s 定时器挂住事件循环
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error(`${wsPath} 握手超时`));
			}, 6000);
			let data = "";
			socket.on("data", (chunk) => {
				data += chunk.toString("latin1");
				if (!data.includes("\r\n\r\n")) return;
				const statusLine = data.split("\r\n")[0];
				console.log(`${wsPath} → ${statusLine}`);
				clearTimeout(timer);
				socket.destroy();
				resolve(statusLine);
			});
			socket.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
	}
} catch (error) {
	console.error(`探测失败：${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
