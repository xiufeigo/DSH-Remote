/**
 * 请求体读取与解析（配对/登录/管理端点共用）。
 *
 * SEC-02 + GW-11：把两类失败区分开，调用方按 oversized 标志回 413 或 400，
 * 不再裸 destroy 让客户端只吃 RST、也不再让非法 JSON 抛成 500。
 * 代理转发另有业务上限（见 proxy.ts），这里的 64KB 只约束内部端点。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** GW-11：请求体超限专用错误——调用方先回标准 413 再关流，不再裸 destroy 让客户端只吃 RST。 */
class BodyTooLargeError extends Error {
	constructor() {
		super("body too large");
	}
}

/** 配对/登录/管理类端点的请求体上限（代理转发另有业务上限，见 proxy.ts）。 */
const BODY_LIMIT_BYTES = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		req.on("data", (chunk: Buffer) => {
			if (settled) return; // 超限/出错后停止累积，避免继续吃内存
			size += chunk.length;
			if (size > BODY_LIMIT_BYTES) {
				settled = true;
				reject(new BodyTooLargeError());
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!settled) {
				settled = true;
				resolve(Buffer.concat(chunks).toString("utf8"));
			}
		});
		req.on("error", (error) => {
			if (!settled) {
				settled = true;
				reject(error);
			}
		});
	});
}

export type ParsedBody<T> = { ok: true; value: T } | { ok: false; oversized?: boolean };

/**
 * 读取并解析 JSON 请求体，把两类失败区分开：
 * - 超 64KB → `{ ok: false, oversized: true }`（调用方回 413 后关流）；
 * - 非法 JSON / 非对象 → `{ ok: false }`（调用方回 400，不再抛成 500）。
 */
export async function readJsonBody<T>(req: IncomingMessage): Promise<ParsedBody<T>> {
	let text: string;
	try {
		text = await readBody(req);
	} catch (error) {
		return { ok: false, oversized: error instanceof BodyTooLargeError };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null) return { ok: true, value: parsed as T };
	} catch {
		// 非法 JSON 与下面的非对象值同样按 400 处理
	}
	return { ok: false };
}

/** SEC-02 / GW-11 的统一拒绝响应。 */
export function respondInvalidBody(req: IncomingMessage, res: ServerResponse, oversized: boolean): void {
	if (oversized) {
		// 先写完标准 413（并声明关闭连接），刷出后再销毁请求流
		res.writeHead(413, { "content-type": "application/json", connection: "close" });
		res.end(JSON.stringify({ message: "请求体过大" }), () => req.destroy());
		return;
	}
	res.writeHead(400, { "content-type": "application/json" });
	res.end(JSON.stringify({ message: "请求体不是合法 JSON" }));
}
