/**
 * 上游 DSH Web GUI 的浏览器会话适配（DSH 0.1.2-alpha.1 起）。
 *
 * 背景：0.1.2-alpha.1 给 Web 宿主加了"浏览器启动令牌认证"（见 DSH 仓库
 * .agents/notes/implemented/architecture/2026-08-24-browser-token-authentication）：
 *   · 每个 Host 进程生成一次性启动令牌，绝不持久化、随进程重启更换；
 *   · 只有 `GET /?token=<令牌>` 会把令牌交换为签名 cookie（HttpOnly、
 *     绑定请求 Host authority、默认 30 天）；
 *   · index、/api/*、WebSocket upgrade 一律要求有效 cookie（401），其中 /api
 *     还叠加 Host fence（403）；仅非 index 静态资产公开；
 *   · cookie 的 HMAC 签名密钥持久在 $DSH_HOME/.credentials.yaml（跨重启有效），
 *     但 authority 绑定 hostname:port —— 上游端口漂移即失效。
 *
 * 因此手机经本网关反代时，上游看到的请求必须携带一枚"为上游 authority 铸造"
 * 的会话 cookie。本模块负责：接收插件宿主半边下发（in-process 经
 * `connection.authenticatedUrl()` 取得）的启动令牌，向上游完成一次令牌交换，
 * 缓存 cookie 并在 authority 变化 / 401 时重铸。
 *
 * 安全边界：令牌与 cookie 只在本机内存中流转；交换请求只发往回环上游；
 * cookie 绝不下发给手机端（proxy.ts 在响应侧剥离 set-cookie）。
 * 旧版宿主（≤0.1.1-rc.2，无浏览器认证）下插件取不到令牌，本模块保持
 * "无令牌即不注入"的透明降级 —— 行为与旧版网关完全一致。
 */

/** 上游返回的会话 cookie 前缀（DSH client-connection/browser-auth.ts 常量）。 */
const DSH_AUTH_COOKIE_PREFIX = "dsh-auth-";

/** 上游令牌交换端点在无效令牌/未认证时返回的特征文本（browser-auth.ts writeUnauthorized）。 */
export const DSH_UNAUTHORIZED_MARKER = "dsh web authentication required";

export type SessionState = "idle" | "no-token" | "pending" | "ready" | "failed";

export interface UpstreamEndpoint {
	host: string;
	port: number;
	/** 非 TLS（即本机 DSH HTTP 回环上游）才做会话注入。 */
	tls?: boolean;
}

export interface UpstreamSessionOptions {
	/** 日志出口。 */
	log?: (line: string) => void;
	/** 交换请求超时（毫秒）。 */
	exchangeTimeoutMs?: number;
	/** 两次铸造尝试之间的最小间隔（毫秒），防令牌失效时的重铸风暴。 */
	mintThrottleMs?: number;
	/** 测试注入的 fetch 实现；缺省全局 fetch。 */
	fetchImpl?: typeof fetch;
	/** 测试注入的时钟源；缺省 Date.now。 */
	now?: () => number;
}

/** 从 Set-Cookie 值里取 `name=value` 对（丢弃属性）。 */
function cookiePairOf(setCookie: string): string | undefined {
	const pair = setCookie.split(";", 1)[0]?.trim();
	if (pair === undefined || pair.length === 0) return undefined;
	const eq = pair.indexOf("=");
	if (eq <= 0) return undefined;
	const name = pair.slice(0, eq).trim();
	const value = pair.slice(eq + 1).trim();
	if (!name.startsWith(DSH_AUTH_COOKIE_PREFIX) || value.length === 0) return undefined;
	return `${name}=${value}`;
}

/**
 * 上游浏览器会话持有者。一个网关进程一个实例；
 * 以 `host:port` 为缓存键 —— 每个 authority 一枚 cookie。
 */
export class UpstreamSession {
	private readonly log: (line: string) => void;
	private readonly exchangeTimeoutMs: number;
	private readonly mintThrottleMs: number;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;

	private launchToken?: string;
	// P2-5：内部字段曾与下方 get state() 同名互相遮蔽（TS2300 duplicate
	// identifier，tsc 全线编译失败；运行时靠原生 class field 遮蔽 prototype
	// getter 才侥幸读到活值）。字段改名收敛，公共只读走 getter。
	private sessionState: SessionState = "idle";
	/** authority → cookie 对（"name=value"）。 */
	private readonly cookies = new Map<string, string>();
	/** 单飞铸造：authority → 进行中的铸造 Promise。 */
	private readonly minting = new Map<string, Promise<string | undefined>>();
	private lastMintAt = 0;

	constructor(options: UpstreamSessionOptions = {}) {
		this.log = options.log ?? (() => {});
		this.exchangeTimeoutMs = options.exchangeTimeoutMs ?? 5_000;
		this.mintThrottleMs = options.mintThrottleMs ?? 2_000;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.now = options.now ?? Date.now;
	}

	/** 插件宿主半边下发的 DSH 进程启动令牌。重复下发同一令牌是幂等的。 */
	setLaunchToken(token: string): void {
		const trimmed = token.trim();
		if (trimmed.length === 0) return;
		if (this.launchToken === trimmed) return;
		this.launchToken = trimmed;
		this.sessionState = "pending";
		this.cookies.clear();
		// P3-9：同时清掉在途铸造表 —— 旧令牌的交换完成后不得把旧纪元 cookie
		// 写进新纪元缓存（mintOnce 内还有令牌纪元复核双保险）。
		this.minting.clear();
		this.lastMintAt = 0;
		this.log("已收到 DSH 启动令牌（0.1.2+ 浏览器会话适配生效）");
	}

	/** 当前是否持有启动令牌。 */
	get hasToken(): boolean {
		return this.launchToken !== undefined;
	}

	/** 诊断状态（admin/status 暴露用）。 */
	get state(): SessionState {
		return this.sessionState;
	}

	/**
	 * 取发往该上游的 Cookie 头值（同步读缓存；铸造是异步预热，见 ensureCookie）。
	 * TLS 上游（如隧道对端的另一台 PC 网关）不做注入 —— 对端网关自己负责它
	 * 本地 DSH 的会话。
	 */
	cookieHeaderFor(upstream: UpstreamEndpoint): string | undefined {
		if (upstream.tls === true) return undefined;
		if (this.launchToken === undefined) return undefined;
		return this.cookies.get(`${upstream.host}:${String(upstream.port)}`);
	}

	/**
	 * 预热：确保该上游有一枚有效会话 cookie（缺令牌/失效节流时静默跳过）。
	 * 返回最终是否就绪。铸造失败不改写已缓存的旧 cookie。
	 */
	async ensureCookie(upstream: UpstreamEndpoint): Promise<boolean> {
		if (upstream.tls === true) return false;
		const authority = `${upstream.host}:${String(upstream.port)}`;
		if (this.launchToken === undefined) {
			if (this.sessionState === "idle") {
				this.sessionState = "no-token";
				this.log("上游为 DSH 0.1.2+ 时需要浏览器会话；尚未收到启动令牌（等待插件宿主下发，旧版宿主无此要求）");
			}
			return false;
		}
		if (this.cookies.has(authority)) return true;
		const cookie = await this.mint(authority, upstream);
		return cookie !== undefined;
	}

	/**
	 * 上游对已注入 cookie 的请求仍回 401 时调用：丢弃缓存并强制重铸
	 * （绕过节流 —— invalidate 是"曾有效 cookie 被拒"的实证，重铸刻不容缓）。
	 */
	invalidate(upstream: UpstreamEndpoint): void {
		if (upstream.tls === true) return;
		const authority = `${upstream.host}:${String(upstream.port)}`;
		if (this.cookies.delete(authority)) {
			this.sessionState = "pending";
			this.lastMintAt = 0;
			this.log(`上游 ${authority} 的会话 cookie 已失效，稍后重铸`);
			void this.mint(authority, upstream).catch(() => {});
		}
	}

	/**
	 * 铸造一枚绑定 authority 的会话 cookie（单飞 + 节流）。
	 * 交换即 `GET http://<authority>/?token=<令牌>`：上游 303 + Set-Cookie；
	 * 401 说明令牌失效（DSH 已重启且插件尚未重发）。
	 */
	private mint(authority: string, upstream: UpstreamEndpoint): Promise<string | undefined> {
		const inflight = this.minting.get(authority);
		if (inflight !== undefined) return inflight;
		if (this.now() - this.lastMintAt < this.mintThrottleMs) {
			return Promise.resolve(this.cookies.get(authority));
		}
		const attempt = this.mintOnce(authority, upstream).finally(() => {
			this.minting.delete(authority);
		});
		this.minting.set(authority, attempt);
		this.lastMintAt = this.now();
		return attempt;
	}

	private async mintOnce(authority: string, upstream: UpstreamEndpoint): Promise<string | undefined> {
		const token = this.launchToken;
		if (token === undefined) return undefined;
		try {
			const url = `http://${authority}/?token=${encodeURIComponent(token)}`;
			const response = await this.fetchImpl(url, {
				redirect: "manual",
				headers: { host: authority, accept: "text/html" },
				signal: AbortSignal.timeout(this.exchangeTimeoutMs),
			});
			// 303（交换成功）与 200（带有效 cookie 直取，罕见）都可取 Set-Cookie
			if (response.status !== 303 && response.status !== 200) {
				// P3-9：令牌纪元复核 —— 交换期间令牌被更换（setLaunchToken 已清
				// 缓存与在途表）时，本结果属于旧纪元，不得改写新纪元的状态。
				if (this.launchToken !== token) return undefined;
				if (response.status === 401) {
					this.sessionState = "failed";
					this.log("启动令牌交换被上游拒绝（DSH 重启后令牌会更换；插件宿主会自动重发，稍候即可恢复）");
				} else {
					this.sessionState = "failed";
					this.log(`启动令牌交换得到意外状态 ${String(response.status)}`);
				}
				return undefined;
			}
			const setCookies = response.headers.getSetCookie();
			// P3-9：同上——旧纪元交换成功的 cookie 不写入新纪元缓存（新纪元自铸）
			if (this.launchToken !== token) return undefined;
			for (const raw of setCookies) {
				const pair = cookiePairOf(raw);
				if (pair !== undefined) {
					this.cookies.set(authority, pair);
					this.sessionState = "ready";
					this.log(`上游 ${authority} 会话 cookie 就绪`);
					return pair;
				}
			}
			this.sessionState = "failed";
			this.log("上游交换响应未携带会话 cookie（宿主版本可能低于 0.1.2-alpha.1，按无会话继续）");
			return undefined;
		} catch (error) {
			if (this.launchToken === token) this.sessionState = "failed";
			this.log(`上游会话交换失败：${String((error as Error).message ?? error)}`);
			return undefined;
		}
	}
}
