/**
 * WebSocket 帧层的最小工具（T31-2）。
 *
 * 存在的唯一理由：**在不解析、不改写 mux 数据的前提下**，判断"现在能不能安全地往
 * 字节流里插一个 PING 控制帧"。为此需要知道上游此刻是不是正处在一帧的中间。
 *
 * 三条硬约束（否则宁可不做保活，也不能弄坏数据面）：
 * 1. 绝不修改透传的字节：本模块只读、只数长度，输出仍是原始 buffer；
 * 2. 只要出现无法按 RFC6455 解释的字节（RSV 位、分片的控制帧、长度不自洽），
 *    立刻把自己标成 `invalid`，调用方**永久退回纯字节管道**；
 * 3. 头部长度上限 14 字节，解析状态与 chunk 边界无关（可跨 TCP 分片推进）。
 */

const EMPTY = Buffer.alloc(0);
/** 帧头最大字节数：2 基础 + 8 扩展长度 + 4 掩码键。 */
const MAX_HEADER_BYTES = 14;

/** opcode */
export const OPCODE_CONTINUATION = 0x0;
export const OPCODE_TEXT = 0x1;
export const OPCODE_BINARY = 0x2;
export const OPCODE_CLOSE = 0x8;
export const OPCODE_PING = 0x9;
export const OPCODE_PONG = 0xa;

/**
 * 编码一个 **服务端 → 客户端** 的 PING 控制帧。
 *
 * 服务端发出的帧 **不得掩码**（RFC6455 §5.1），所以掩码位恒为 0。
 * 载荷必须 ≤125 字节（控制帧硬约束）。空载荷是最省的选择：整帧 2 字节。
 */
export function encodePingFrame(payload: Buffer = EMPTY): Buffer {
	if (payload.length > 125) {
		throw new RangeError(`PING 载荷不得超过 125 字节（控制帧约束），收到 ${String(payload.length)}`);
	}
	if (payload.length === 0) return Buffer.from([0x80 | OPCODE_PING, 0x00]);
	const head = Buffer.alloc(2);
	head[0] = 0x80 | OPCODE_PING;
	head[1] = payload.length; // 最高位=0 ⇒ 未掩码
	return Buffer.concat([head, payload]);
}

/**
 * 找到 HTTP 响应头结束位置（`\r\n\r\n`）之后的第一字节下标；找不到返回 -1。
 * 用于把上游的 101 响应头与随后的 WS 帧流切开。
 */
export function findHttpHeadEnd(buffer: Buffer): number {
	return buffer.indexOf("\r\n\r\n");
}

/** 帧头解析结果：undefined = 还差字节；null = 不是合法的 WS 帧。 */
interface ParsedHeader {
	/** 帧头本身占用的字节数（2 / 4 / 10，含掩码键时再加 4）。 */
	headerBytes: number;
	/** 掩码键 + 载荷在内的总字节数。 */
	frameBytes: number;
}

/**
 * 解析帧头前缀。`buf` 是从帧起始处取到的 1..14 字节。
 * 返回 `undefined` 表示字节不足、返回 `null` 表示非法（调用方应永久退化）。
 */
function parseHeader(buf: Buffer): ParsedHeader | undefined | null {
	if (buf.length < 2) return undefined;
	const b0 = buf[0];
	const b1 = buf[1];
	const fin = (b0 & 0x80) !== 0;
	const rsv = b0 & 0x70;
	const opcode = b0 & 0x0f;
	const masked = (b1 & 0x80) !== 0;
	const len7 = b1 & 0x7f;

	// 握手未协商任何扩展（代理不转发 Sec-WebSocket-Extensions），RSV 必须全 0
	if (rsv !== 0) return null;
	// 控制帧：必须 FIN=1、载荷 ≤125、不得分片
	if ((opcode & 0x8) !== 0) {
		if (!fin || len7 > 125) return null;
	}
	const maskBytes = masked ? 4 : 0;

	if (len7 < 126) return { headerBytes: 2 + maskBytes, frameBytes: 2 + maskBytes + len7 };
	if (len7 === 126) {
		if (buf.length < 4) return undefined;
		return { headerBytes: 4 + maskBytes, frameBytes: 4 + maskBytes + buf.readUInt16BE(2) };
	}
	if (buf.length < 10) return undefined;
	const big = buf.readBigUInt64BE(2);
	// 超过 JS 安全整数：无法用 number 精确表达，直接判非法（真实 mux 帧不可能这么大）
	if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
	return { headerBytes: 10 + maskBytes, frameBytes: 10 + maskBytes + Number(big) };
}

/**
 * 单向帧边界跟踪器（喂"上游 → 浏览器"方向的字节）。
 *
 * 用法：握手完成后把上游字节持续 `push` 进来；`atBoundary` 为 true 时，
 * 此刻往浏览器 socket 写 PING 一定落在两帧之间。
 *
 * 实现要点：帧头**逐字节**喂进一个定长 14 字节的暂存区（不做整块拷贝），
 * 解析成功后再按 `frameBytes - headerBytes` 精确跳过载荷。
 * 早期版本把整个 chunk 塞进帧头缓冲，载荷字节没被扣掉，导致边界判定恒为 false。
 */
export class WsFrameBoundaryTracker {
	private readonly header = Buffer.alloc(MAX_HEADER_BYTES);
	private headerLen = 0;
	private state: "boundary" | "header" | "payload" = "boundary";
	private remaining = 0;
	private invalidFlag = false;

	/** 一旦为 true 就不要再信任本跟踪器（字节已无法解释）。 */
	get invalid(): boolean {
		return this.invalidFlag;
	}

	/** 当前是否正处在两帧之间（可以安全插入控制帧）。 */
	get atBoundary(): boolean {
		return !this.invalidFlag && this.state === "boundary";
	}

	/** 已确认完整消费掉的帧数（诊断用）。 */
	frames = 0;

	push(chunk: Buffer): void {
		if (this.invalidFlag || chunk.length === 0) return;
		let i = 0;
		while (i < chunk.length) {
			if (this.state === "boundary") this.state = "header";
			if (this.state === "header") {
				// 逐字节喂帧头：最多 10 次迭代即可定长，避免任何"多拿了载荷"的记账错误
				if (this.headerLen >= MAX_HEADER_BYTES) {
					this.invalidFlag = true;
					return;
				}
				this.header[this.headerLen] = chunk[i];
				this.headerLen += 1;
				i += 1;
				const parsed = parseHeader(this.header.subarray(0, this.headerLen));
				if (parsed === undefined) continue; // 字节不足，等下一块
				if (parsed === null) {
					this.invalidFlag = true;
					return;
				}
				this.frames += 1;
				this.remaining = parsed.frameBytes - this.headerLen; // 用"实际已消费字节数"扣减
				this.headerLen = 0;
				this.state = this.remaining === 0 ? "boundary" : "payload";
				continue;
			}
			// 载荷：按剩余字节数跳过（只数长度，不碰内容）
			const take = Math.min(this.remaining, chunk.length - i);
			this.remaining -= take;
			i += take;
			if (this.remaining === 0) this.state = "boundary";
		}
	}
}

/**
 * 解析一条**客户端 → 服务端**方向的 WS 字节流（用于测试与诊断）。
 * 与跟踪器不同：这里要真正读出载荷与 opcode。
 */
export interface DecodedFrame {
	fin: boolean;
	opcode: number;
	masked: boolean;
	payload: Buffer;
	/** 掩码前的原始载荷 */
	raw: Buffer;
}

export type DecodeResult =
	| { ok: true; frames: DecodedFrame[]; rest: Buffer }
	| { ok: false; error: string; rest: Buffer };

/** 从任意位置开始逐帧解码；尾部不完整的部分放进 `rest` 返回。 */
export function decodeFrames(buffer: Buffer): DecodeResult {
	const frames: DecodedFrame[] = [];
	let i = 0;
	while (i < buffer.length) {
		if (buffer.length - i < 2) return { ok: true, frames, rest: buffer.subarray(i) };
		const probe = buffer.subarray(i, Math.min(i + MAX_HEADER_BYTES, buffer.length));
		const parsed = parseHeader(probe);
		if (parsed === null) return { ok: false, error: `非法帧头 @${String(i)}`, rest: buffer.subarray(i) };
		if (parsed === undefined) return { ok: true, frames, rest: buffer.subarray(i) };
		if (buffer.length - i < parsed.frameBytes) return { ok: true, frames, rest: buffer.subarray(i) };
		const b0 = buffer[i];
		const b1 = buffer[i + 1];
		const len7 = b1 & 0x7f;
		const maskBytes = (b1 & 0x80) !== 0 ? 4 : 0;
		const lenOffset = len7 < 126 ? 2 : len7 === 126 ? 4 : 10;
		const payloadOffset = i + lenOffset + maskBytes;
		const raw = Buffer.from(buffer.subarray(payloadOffset, i + parsed.frameBytes));
		let payload = raw;
		if (maskBytes === 4) {
			const key = buffer.subarray(i + lenOffset, i + lenOffset + 4);
			payload = Buffer.from(raw);
			for (let k = 0; k < payload.length; k++) payload[k] ^= key[k % 4];
		}
		frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, masked: maskBytes === 4, payload, raw });
		i += parsed.frameBytes;
	}
	return { ok: true, frames, rest: EMPTY };
}

/**
 * 编码一个**客户端 → 服务端**方向的数据帧（测试用）：客户端帧必须掩码。
 * 这是 RFC6455 §5.3 的标准客户端掩码算法。
 */
export function encodeClientFrame(opcode: number, payload: Buffer, maskKey?: Buffer): Buffer {
	const len = payload.length;
	const offset = len < 126 ? 2 : len < 65536 ? 4 : 10;
	const key = maskKey ?? Buffer.from([0x12, 0x34, 0x56, 0x78]);
	const masked = Buffer.from(payload);
	for (let i = 0; i < masked.length; i++) masked[i] ^= key[i % 4];
	const head = Buffer.alloc(offset);
	head[0] = 0x80 | (opcode & 0x0f);
	if (len < 126) head[1] = 0x80 | len;
	else if (len < 65536) {
		head[1] = 0x80 | 126;
		head.writeUInt16BE(len, 2);
	} else {
		head[1] = 0x80 | 127;
		head.writeBigUInt64BE(BigInt(len), 2);
	}
	return Buffer.concat([head, key, masked]);
}
