package top.d1studio.dshremote;

/**
 * T96：原生侧「卡住自救」——连接卡在「正在重连」时的**分级**自救状态机。
 *
 * <p><b>它修的是什么（真机 + 隔离台实测，见 scratch/t96/report.md §1/§2）</b>：
 * rc.2.7 的整套自愈（包装 {@code window.WebSocket} 观测 + 1s 断开巡检 + nudge）都在
 * {@code mobile-web.js} 的 hook 里，而**平板档 hook 是硬契约严格关闭的**
 * （{@code installWsStateWatch()} 第一行 {@code if (wsWatchInjectedTablet()) return false;}
 * ⇒ 不装观测、不换构造器）。平板档剩下的唯一信号是**只读 DOM 探针**
 * （{@link ReconnectBanner#PROBE_JS} 的层 1：官方 {@code [data-phase="connecting"]} 按钮），
 * 而那个探针**没有任何东西去消费它**：
 * <ul>
 *   <li>{@code probeResumeRecovery()} 只有三个入口：{@code visibilitychange→visible}、
 *       {@code pageshow(persisted)}、WS 观测翻转通知。平板档没有第三个（观测没装），</li>
 *   <li>而那条 1s 断开巡检（{@code ensureResumeDownTick}）只有在**第一次**
 *       {@code probeResumeRecovery()} 已经判定为「断」之后才装得上 —— 没有第一脚就没有巡检。</li>
 * </ul>
 * ⇒ 实测（emulator-5700，平板档 2560×1600@320，sw=800）：把网关进程硬杀再拉起来，
 * 页面卡在官方「Reconnecting...」**100s+ 不自愈**，而同刻页面内
 * {@code fetch('/__dsh_remote__/health')} 返回 **200 / 64ms**（网络路径健康）⇒
 * 不是网络问题，是**没人去踹它**。手机档另有 hook 的那套在跑，但平板档没有任何 nudge 来源。
 *
 * <p><b>分级（真值决定的分工，不是拍脑袋）</b>：
 * <ol>
 *   <li><b>温和层（{@link Action#NUDGE}）</b>：派发 {@code offline}→{@code online} 瞬态对
 *       （{@link #NUDGE_JS}）。依据是上游 {@code watchBrowserNetwork()} →
 *       {@code controller.setNetworkAvailable(true→false→true)} 会 {@code attempt=0} 并
 *       {@code abort()} 掉正在睡的那一跳退避 —— 这是"睡在退避里"的卡法最便宜的解药。
 *       它**不写 DOM、不换全局、不导航**（派发前后 DOM 逐字节相同的真值见 report §5）。</li>
 *   <li><b>升级层（{@link Action#RELOAD}）</b>：仍卡住 N 秒后走**受控重载**
 *       （{@code WebView.reload()}）。依据是**实测**：温和层对"半死 socket"那一类卡法
 *       **无效**（实测派发后 40s 仍卡），而重载 **1.6s 恢复**
 *       （scratch/t96/tablet-reload.json：{@code recoveredMs=1625}），且
 *       {@code localStorage["dsh.sessions.current"]} 原样保留 ⇒ **回到同一会话**、
 *       不落 workspace chooser（同一份真值：重载前后 sessionId 逐字相同）。</li>
 * </ol>
 *
 * <p><b>回前台首次不等长间隔</b>：{@link Decider#onForeground(long)} 把「新观测起点」置位，
 * 于是回前台后**第一次**读到「正在重连」就立刻允许温和层动作（不必等 {@link #TIER1_AFTER_MS}）。
 *
 * <p><b>防风暴</b>：温和层单次断开最多 {@link #MAX_NUDGES} 次、间隔 ≥
 * {@link #NUDGE_MIN_INTERVAL_MS}；升级层单次进程生命周期最多 {@link #MAX_RELOADS} 次、
 * 间隔 ≥ {@link #RELOAD_MIN_INTERVAL_MS}。到顶后**不再有任何动作**（只观测），
 * 直到读到健康再复位 —— 健康态与到顶态都是**零动作**。
 *
 * <p><b>与手机档 hook 自愈不打架</b>：手机档 hook 是活的（{@code isTabletClass()==false}），
 * 那套自己会在 400ms 二次确认后推 nudge、并跑 1s 巡检；原生侧于是**让位**：
 * 温和层整层跳过（不重复推进），升级层阈值从 {@link #TIER2_AFTER_MS} 抬到
 * {@link #TIER2_AFTER_HOOK_MS}（给 hook 的确认+巡检留出整段时间）。
 * 平板档（{@code hookLive==false}）不欠人情，两层都由原生负责。
 *
 * <p><b>零开销</b>：不新装任何定时器/回调，只挂在**既有的 500ms 只读探针**
 * （{@code MainActivity.reconnectPollTick}）后面，吃它已经算出来的观测值；
 * 健康态下 {@link Decider#observe} 只做一次比较就返回 {@link Action#NONE}。
 *
 * <p>本类**纯 Java、不碰 Android 运行时**（{@code Action}/{@code Observed}/{@code Decider}），
 * 由 {@code android/tests/StuckRescueTest.java} 在 JVM 上直接喂序列验证（含边界与反例）。
 */
public final class StuckRescue {

	private StuckRescue() {
	}

	/** 一次观测（复用横幅那套三态语义，避免第二套判据）。 */
	public enum Observed {
		OK,
		RECONNECTING,
		UNKNOWN
	}

	/** 要执行的动作。 */
	public enum Action {
		/** 什么都不做（健康 / 读不到页面 / 已到顶）。 */
		NONE,
		/** 温和层：派发 offline→online 瞬态对，不写 DOM。 */
		NUDGE,
		/** 升级层：受控重载当前文档（等价用户手动重开，保留会话）。 */
		RELOAD
	}

	/** 温和层最短生效时间：首次判定后仍卡住这么久就催一次。 */
	public static final int TIER1_AFTER_MS = 1500;
	/** 升级层阈值（平板档 / hook 不在场）：温和层催过之后仍卡这么久 ⇒ 受控重载。 */
	public static final int TIER2_AFTER_MS = 12000;
	/** 升级层阈值（手机档 / hook 在场）：给 hook 的二次确认 + 1s 巡检留足时间，原生不抢跑。 */
	public static final int TIER2_AFTER_HOOK_MS = 25000;
	/** 温和层两次之间的最小间隔。 */
	public static final int NUDGE_MIN_INTERVAL_MS = 8000;
	/** 温和层单次断开的上限。两次都推过、仍卡到 {@link #TIER2_AFTER_MS} ⇒ 升级（不再空催）。 */
	public static final int MAX_NUDGES = 2;
	/** 两次受控重载之间的最小间隔。 */
	public static final int RELOAD_MIN_INTERVAL_MS = 60000;
	/** 单次进程生命周期的受控重载上限（到了就只观测，不再动）。 */
	public static final int MAX_RELOADS = 2;

	/**
	 * 温和层脚本：**只派发一对事件**给 window，不碰 DOM / 不换构造器 / 不导航。
	 *
	 * <p>为什么是 {@code offline}→{@code online} 而不是单独 {@code online}：
	 * 上游 {@code setNetworkAvailable(available)} 第一行是
	 * {@code if (this.networkAvailable === available) return;} —— 页面健康时
	 * {@code networkAvailable} 本来就是 {@code true}，单独派发 {@code online} 会命中这行
	 * 短路、等于空操作；{@code offline}→{@code online} 是一次真实的
	 * {@code true→false→true} 翻转，两行短路都不成立。
	 *
	 * <p>⚠️ 常量里不许有注释（与 {@code ReconnectBanner.PROBE_JS} 同一条纪律，
	 * 便于宿主测试按 token 抽取后真跑）。
	 */
	public static final String NUDGE_JS =
		"(function(){try{"
		+ "if(typeof window.dispatchEvent!=='function')return 'no-dispatch';"
		+ "window.dispatchEvent(new Event('offline'));"
		+ "window.dispatchEvent(new Event('online'));"
		+ "return 'network-transition';"
		+ "}catch(e){return 'error';}})()";

	/**
	 * 卡住自救判定器。**纯状态机**：喂观测、给动作，不执行任何副作用。
	 *
	 * <p>线程约束：只在主线程（探针回调 + onResume）被调用，因此不需要同步。
	 */
	public static final class Decider {

		private long downSince;
		private long nudgedAt;
		private int nudges;
		private long lastReloadAt;
		private int reloads;
		private boolean fresh;
		private boolean reloadedSinceDown;
		/**
		 * T118：<b>回前台快速升级许可</b>——一次性。
		 *
		 * <p><b>为什么要有</b>：平板档的温和层（nudge）在"半死 socket"这一类卡法上
		 * <b>实测无效</b>（scratch/t96/report.md §1.2：派发后 40s 仍 {@code phase=[connecting]}；
		 * 真机时间线 §4.2 也是 nudge 0s/+8.6s 两次都无效，12s 后才升级）。
		 * 换句话说，那 12 秒的升级门槛等的是<b>一个已经被证明无效的动作</b>。
		 * 实测（scratch/t118，见本类 §T118 段）：回前台 → 整页重载 ≈ <b>17.3s</b>，
		 * 期间页面一直卡死、<b>零提示</b> ⇒ 用户观感是"莫名其妙闪一下，滚动位置也没了"。
		 *
		 * <p><b>语义</b>：回前台后，若探针读到「正在重连」，且温和层<b>已经试过一次</b>
		 * （即页面已拿到那次廉价机会、且没自愈），就<b>不再等满 12s</b>，直接升级。
		 * ⇒ 平板档的时序从「0s nudge → 8s nudge → 12s 重载」缩到
		 * 「0s nudge → 约 0.5s 重载」，回前台后很快就有确定结果，不再是"悬着"。
		 *
		 * <p><b>为什么只给平板档</b>：手机档 hook 在场，它有自己的一整套自愈
		 * （二次确认 400ms + 1s 巡检 + nudge），手机档升级阈值 25s 正是
		 * <b>刻意抬给 hook 让路</b>的（T96 §3.3）。抢掉 hook 的活 = 治好了平板、
		 * 弄坏了手机。故本许可只在 {@code !hookLive}（平板）生效。
		 *
		 * <p><b>为什么不会误伤健康页</b>：健康页在回前台后第一拍探针读 <b>OK</b>
		 * ⇒ 本许可当场作废（见 {@link #observe} 的 OK 分支）。
		 * 只有"第一拍就明确读到正在重连"才会用掉它；而升级动作本身仍有四道门
		 * （会话页 / 主框架未失败 / uiState==WEB / 链路探针 200）与配额闸。
		 */
		private boolean foregroundFastPath;

		/**
		 * 回前台（或从后台恢复）：断开 episode 重开，下一次判定是"新起点"。
		 *
		 * <p>**温和层的配额一起重开**（{@code nudges}/{@code nudgedAt} 清零）：退后台那段时间
		 * 上一个 episode 的温和层配额可能已经用满，若不清零，回前台第一拍会因为"配额到顶"
		 * 直接落到**升级层**（或干脆等到 12s 才重载）—— 那就违背了"回前台首次立刻动"。
		 * 跨文档的**重载配额**（{@code reloads}/{@code lastReloadAt}）**不**清零：
		 * 那是防风暴的硬闸，不能靠切前台刷掉。
		 */
		public void onForeground() {
			fresh = true;
			downSince = 0;
			nudgedAt = 0;
			nudges = 0;
			reloadedSinceDown = false;
			// 注意：**这里不发**快速升级许可。发许可的时机由调用方决定
			// （必须确认"确实退过后台足够久"），见 {@link #armForegroundFastPath()}。
		}

		/**
		 * T118：开一次"回前台快速升级许可"（一次性）。
		 *
		 * <p><b>为什么不在 {@link #onForeground()} 里无条件开</b>：冷启动也会走 onResume，
		 * 而冷启动时页面正在建 WS ⇒ 官方那条指示器本来就在显示「正在重连」⇒
		 * 探针第一拍读到的就是 RECONNECTING。若此时许可已武装，
		 * **App 会在冷启后约 1s 内把自己重载一遍**（那才是真·自造故障）。
		 * 故许可必须由调用方在确认"确实退过后台足够久"之后单独开。
		 *
		 * <p>许可是一次性的：健康页第一拍读 OK 即作废（见 {@link #observe}），
		 * 用掉一次升级后也作废（见 {@link #observe} 的 RELOAD 分支）。
		 */
		public void armForegroundFastPath() {
			foregroundFastPath = true;
		}

		/** 快速升级许可当前是否还armed（只读，供接线自检/诊断用）。 */
		public boolean foregroundFastPathArmed() {
			return foregroundFastPath;
		}

		/** 新文档（受控重载之后 / 页面导航）：断开episode 全部重开，但**重载配额跨文档保留**。 */
		public void onDocumentChanged() {
			downSince = 0;
			nudgedAt = 0;
			nudges = 0;
			reloadedSinceDown = false;
			fresh = true;
			// T118：换文档 = 新 episode ⇒ 快速升级许可作废（否则会连着重载）。
			foregroundFastPath = false;
		}

		/**
		 * 喂一次观测并取动作。
		 *
		 * @param o        探针的**原始**结论（⚠️ 不能用"官方那条已可见 ⇒ 抑制横幅"之后的
		 *                 映射值：被判抑制时页面的真相仍然是"正在重连"，拿抑制后的值
		 *                 会让自救永不触发 —— 这正是平板档实测里 {@code probe=OK SUPPRESS|…}
		 *                 与页面 {@code data-phase=connecting} 同时出现的那个坑）
		 * @param now      墙上时钟（ms）
		 * @param hookLive 手机档（hook 自愈在场）为 true；平板档严格 OFF 为 false
		 * @return 本次要执行的动作
		 */
		public Action observe(Observed o, long now, boolean hookLive) {
			if (o == Observed.UNKNOWN) return Action.NONE;
			if (o == Observed.OK) {
				downSince = 0;
				nudgedAt = 0;
				nudges = 0;
				fresh = false;
				reloadedSinceDown = false;
				// T118：页面已恢复 ⇒ 回前台的快速升级许可当场作废（健康页永不会用它）。
				foregroundFastPath = false;
				return Action.NONE;
			}
			if (downSince == 0) downSince = now;
			long stuck = now - downSince;
			// ── 温和层：手机档让位给 hook（hook 自己会推 nudge + 跑 1s 巡检）──
			if (!hookLive && nudges < MAX_NUDGES) {
				boolean intervalOk = nudgedAt == 0 || now - nudgedAt >= NUDGE_MIN_INTERVAL_MS;
				boolean due = fresh || nudgedAt == 0 || stuck >= TIER1_AFTER_MS;
				if (intervalOk && due) {
					nudgedAt = now;
					nudges += 1;
					fresh = false;
					reloadedSinceDown = false;
					return Action.NUDGE;
				}
			}
			// ── 升级层：温和层已试过（或手机档让位给 hook）仍卡住 ⇒ 受控重载 ──
			// 时间基准用 **downSince（断开 episode 起点）**而不是"距上次 nudge"：
			// 否则连续 nudge 会把起点一路推后，升级被无限推迟（实测口径：12s 就是十几秒）。
			long tier2 = hookLive ? TIER2_AFTER_HOOK_MS : TIER2_AFTER_MS;
			boolean triedGentle = hookLive || nudges > 0;
			// T118：回前台快速升级（**仅平板档**）。
			//   条件：① 本次是回前台后开的许可；② 平板档（hookLive=false）——
			//         手机档刻意抬到 25s 让 hook 先干活，抢它 = 治好了平板弄坏了手机；
			//         ③ 温和层**已经试过一次**（nudges>0）——页面已拿到那次廉价机会且没自愈。
			// 满足时不再等满 12s，直接升级（真机实测 17.3s → 约 0.5s）。
			boolean fastUpgrade = foregroundFastPath && !hookLive && nudges > 0;
			boolean tier2Due = fastUpgrade || (now - downSince) >= tier2;
			if (reloads < MAX_RELOADS
				&& (now - lastReloadAt) >= RELOAD_MIN_INTERVAL_MS
				&& triedGentle
				&& tier2Due) {
				reloads += 1;
				lastReloadAt = now;
				reloadedSinceDown = true;
				downSince = now;
				nudgedAt = 0;
				nudges = 0;
				fresh = false;
				// T118：快速升级许可一次性，用掉即作废（后续重载回到 12s 常规门槛）。
				foregroundFastPath = false;
				return Action.RELOAD;
			}
			return Action.NONE;
		}

		/** 已推的温和层次数（本次断开）。 */
		public int nudges() {
			return nudges;
		}

		/** 已用的受控重载次数（本次进程生命周期）。 */
		public int reloads() {
			return reloads;
		}

		/** 是否已经没有自救手段（温和层到顶且重载配额用尽）。 */
		public boolean exhausted() {
			return nudges >= MAX_NUDGES && reloads >= MAX_RELOADS;
		}

		/** 本次断开已持续多久（0 = 未断开）。 */
		public long stuckForMs(long now) {
			return downSince == 0 ? 0 : now - downSince;
		}

		/** 刚发生过重载（供日志/横幅决策）。 */
		public boolean reloadedSinceDown() {
			return reloadedSinceDown;
		}

		/**
		 * T96：**撤回**一次重载意图（链路探针说不通时用）。
		 *
		 * <p>为什么必须能撤回（真机实测定下来的）：网关还断着就把文档重载掉，主框架会直接
		 * {@code net::ERR_CONNECTION_CLOSED} ⇒ 页面被打成**浏览器错误页**
		 * （scratch/t96/tablet-rescue-fg-v1.json：tier2 在 +12.2s 触发，同刻
		 * {@code mainFrame error code=-6}、{@code href=chrome-error://chromewebdata/}）。
		 * 那比"卡在重新连接中"更糟（把 DSH 界面整页打没了）。所以重载前先查一次链路，
		 * 不通就撤回：配额与间隔回滚、episode 归零，链路一回来第一拍就能重新动手。
		 */
		public void abortReload() {
			if (!reloadedSinceDown) return;
			reloads = reloads > 0 ? reloads - 1 : 0;
			lastReloadAt = 0;
			reloadedSinceDown = false;
			downSince = 0;
			nudgedAt = 0;
			nudges = 0;
			fresh = true;
		}
	}
}
