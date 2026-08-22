#!/usr/bin/env node
/** 对真实网关+真实 DSH 的 WS 直通探针：配对 → 升级 /api/events.mux → 期待 101。 */
import https from "node:https";
import tls from "node:tls";

const GW_HOST = "127.0.0.1";
const GW_PORT = Number(process.argv[2] ?? "18443");

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
		let data = "";
		socket.on("data", (chunk) => {
			data += chunk.toString("latin1");
			if (!data.includes("\r\n\r\n")) return;
			const statusLine = data.split("\r\n")[0];
			console.log(`${wsPath} → ${statusLine}`);
			socket.destroy();
			resolve(statusLine);
		});
		socket.on("error", reject);
		setTimeout(() => {
			socket.destroy();
			reject(new Error(`${wsPath} 握手超时`));
		}, 6000);
	});
}
