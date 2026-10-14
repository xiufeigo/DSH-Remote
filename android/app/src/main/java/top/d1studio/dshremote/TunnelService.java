package top.d1studio.dshremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * 隧道前台服务：保活 frpc visitor（stcp/xtcp）。
 * 配置从 SharedPreferences 读取；MainActivity 负责写入并 startForegroundService。
 * 启停 frpc 放在后台线程，避免主线程等进程退出导致 ANR。
 *
 * FGS 类型：specialUse（AND-02）。dataSync 在 Android 14+ 有累计时长限制、
 * 系统可随时杀，不适合长时隧道代理；用途在 Manifest 的 property 里声明。
 *
 * 通知：只有智能体正在跑时才显示，内容是会话标题和当前这条会话。
 * 没有会话时不留通知。startForegroundService 的 5 秒契约仍要先兑现一次，
 * 兑现后立刻撤掉，避免空闲时在通知栏留下「DSH Remote」。
 * 会话通知带「断开」操作（AND-02），不进 App 即可停隧道；另有「连接设置」操作（D6 ②），
 * 给平板档（hook 关闭、页面上没有长按鲸鱼入口）补一个运行中进连接设置页的入口。
 */
public class TunnelService extends Service {

	/** 通知「断开」操作（AND-02）。 */
	public static final String ACTION_STOP = "top.d1studio.dshremote.action.STOP_TUNNEL";
	/** 会话内切隧道：新访客已经画好，停掉旧进程并接管备用进程。 */
	public static final String ACTION_COMMIT_OVERLAP = "top.d1studio.dshremote.action.COMMIT_OVERLAP";
	/** 会话内切隧道失败：停掉备用进程，正在服务当前页的那条不动。 */
	public static final String ACTION_ABORT_OVERLAP = "top.d1studio.dshremote.action.ABORT_OVERLAP";
	/** 按已保存的配置组重写 frpc：同一台 frps 上的访客进同一个进程。 */
	public static final String ACTION_SYNC = "top.d1studio.dshremote.action.SYNC_FLEET";
	public static final String EXTRA_FLEET_SCOPE = "dshr_fleet_scope";
	public static final String SCOPE_FULL = "full";
	public static final String SCOPE_ACTIVE = "active";
	/** 当前这台，加上同一台 frps 上的其他服务器。 */
	public static final String SCOPE_SAME_FRPS = "same-frps";
	/** MainActivity 传入协商后的本地绑定端口（AND-07）；缺省时服务侧自行协商。 */
	public static final String EXTRA_BIND_PORT = "dshr_bind_port";
	/** 为 true 时另起一个 frpc，不停当前这条。当前页继续用旧端口，直到交接。 */
	public static final String EXTRA_OVERLAP = "dshr_overlap";
	private static final String TAG = "dshr-svc";

	private static final String CHANNEL_SESSION = "session_progress";
	private static final String CHANNEL_KEEP = "tunnel_keep";
	private static final int NOTIFICATION_ID = 1;

	private static volatile TunnelService instance;
	private static volatile boolean sessionRunning;
	/** 当前是否正处于前台服务。空闲时为 false，通知也已撤掉。 */
	private boolean holdingForeground;
	private static volatile String sessionTitle = "";
	private static volatile String sessionText = "";

	private final Object frpcLock = new Object();
	private final Handler mainHandler = new Handler(Looper.getMainLooper());
	private FrpcManager frpc;
	/** 会话内切隧道时先并行拉起的访客。交接前当前页仍走 {@link #frpc}。 */
	private FrpcManager pendingFrpc;
	private VisitorConfig pendingCfg;
	private volatile boolean overlapStarting;
	private volatile boolean pendingShouldPromote;
	private volatile boolean pendingShouldDiscard;
	/** 粘性回落改写 cfg.strategy 之前的用户档位。交接落盘用它，避免把「暂时中转」写成用户选择。 */
	private String pendingUserStrategy;

	/** T113：隧道环境巡检（网络变化清零 + 粘性挂载，见 {@link #watchTunnelEnvironment}）。 */
	private Runnable stickyWatch;
	/** T113：本次 frpc 启动实际用的配置对象（巡检要它能改到下一次重启写出的 toml）。 */
	private volatile VisitorConfig runningCfg;
	/** 同一台 frps 一个进程。key 是地址、端口和登录密钥。 */
	private final Map<String, FrpcManager> fleet = new LinkedHashMap<>();
	private int fleetGeneration;

	public static boolean isRunning() {
		return instance != null;
	}

	public static void updateSessionNotice(Context ctx, String title, String text, boolean running) {
		sessionTitle = title == null ? "" : title.trim();
		sessionText = text == null ? "" : text.trim();
		sessionRunning = running;
		TunnelService svc = instance;
		if (svc == null || ctx == null) return;
		svc.publishForeground();
	}

	@Override
	public void onCreate() {
		super.onCreate();
		instance = this;
		NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
		if (nm != null && Build.VERSION.SDK_INT >= 26) {
			NotificationChannel session = new NotificationChannel(
				CHANNEL_SESSION, "会话进度", NotificationManager.IMPORTANCE_LOW);
			session.setDescription("智能体正在工作时显示当前会话");
			session.setShowBadge(false);
			session.enableLights(false);
			session.enableVibration(false);
			session.setSound(null, null);
			nm.createNotificationChannel(session);

			NotificationChannel keep = new NotificationChannel(
				CHANNEL_KEEP, "后台保活", NotificationManager.IMPORTANCE_MIN);
			keep.setDescription("仅用于满足系统的前台服务契约，没有会话时会立刻撤掉");
			keep.setShowBadge(false);
			keep.enableLights(false);
			keep.enableVibration(false);
			keep.setSound(null, null);
			keep.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
			nm.createNotificationChannel(keep);
		}
	}

	@Override
	public int onStartCommand(Intent intent, int flags, int startId) {
		// AND-02：通知「断开」操作，不进 App 直接停隧道。
		// 早停同样走 stopSelfHonoringForegroundContract，覆盖尚未
		// publishForeground 的启动时序（见该方法注释）。
		if (intent != null && ACTION_STOP.equals(intent.getAction())) {
			Log.i(TAG, "收到通知断开操作，停止隧道");
			stopSelfHonoringForegroundContract();
			return START_NOT_STICKY;
		}
		if (intent != null && ACTION_COMMIT_OVERLAP.equals(intent.getAction())) {
			if (frpc == null && pendingFrpc == null && !overlapStarting) {
				stopSelf();
				return START_NOT_STICKY;
			}
			commitOverlap();
			return START_STICKY;
		}
		if (intent != null && ACTION_ABORT_OVERLAP.equals(intent.getAction())) {
			abortOverlap();
			if (frpc == null && pendingFrpc == null && !overlapStarting) {
				stopSelf();
				return START_NOT_STICKY;
			}
			return START_STICKY;
		}
		SharedPreferences prefs = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
		ProfileStore.migrateLegacy(prefs);
		String scope;
		if (intent != null && ACTION_SYNC.equals(intent.getAction())) {
			scope = intent.getStringExtra(EXTRA_FLEET_SCOPE);
		} else if (intent == null) {
			scope = prefs.getString(ProfileStore.KEY_FLEET_SCOPE, SCOPE_SAME_FRPS);
		} else {
			scope = SCOPE_SAME_FRPS;
		}
		syncFleet(canonicalScope(scope, prefs));
		return START_STICKY;
	}

	/** 旧的「全部中转」在这个开关打开时收成同一台 frps，关掉时只留当前这台。 */
	private static String canonicalScope(String scope, SharedPreferences prefs) {
		if (SCOPE_ACTIVE.equals(scope)) return SCOPE_ACTIVE;
		if (SCOPE_SAME_FRPS.equals(scope)) return SCOPE_SAME_FRPS;
		return ProfileStore.preconnectSameFrps(prefs) ? SCOPE_SAME_FRPS : SCOPE_ACTIVE;
	}

	/**
	 * 把已保存的隧道收成若干 frpc 进程：同一台 frps 的访客写进同一份 toml。
	 * 文本没变并且进程还活着时不重启，避免切服务器时把当前页的连接掐掉。
	 */
	private void syncFleet(final String scope) {
		publishForeground();
		final int generation = ++fleetGeneration;
		getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE).edit()
			.putString(ProfileStore.KEY_FLEET_SCOPE, scope).apply();
		noteStickyOnSync();
		new Thread(() -> {
			synchronized (frpcLock) {
				if (generation != fleetGeneration || instance != TunnelService.this) return;
				SharedPreferences prefs = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
				List<ProfileStore.Profile> profiles = ProfileStore.list(prefs);
				String activeId = ProfileStore.getActiveId(prefs);
				int preferred = activeId.equals(prefs.getString(ProfileStore.KEY_TUNNEL_PROFILE, ""))
					? prefs.getInt(ProfileStore.KEY_BOUND_PORT, 0) : 0;
				if (VisitorFleet.assignPorts(profiles, activeId, preferred)) {
					ProfileStore.saveAll(prefs, profiles);
				}
				ProfileStore.Profile active = null;
				for (ProfileStore.Profile profile : profiles) {
					if (profile.id.equals(activeId)) active = profile;
				}
				if (active != null && active.bindPort > 0) {
					runningCfg = active.toVisitorConfig();
					prefs.edit()
						.putInt(ProfileStore.KEY_BOUND_PORT, active.bindPort)
						.putString(ProfileStore.KEY_TUNNEL_PROFILE, active.id)
						.putString(ProfileStore.KEY_TUNNEL_STRATEGY, ProfileStore.effectiveStrategy(active))
						.apply();
				}
				List<VisitorFleet.Group> groups = groupsFor(profiles, activeId, scope);
				Log.i(TAG, "访客集 " + scope + "：" + groups.size() + " 个 frpc 进程");
				if (groups.isEmpty()) {
					stopFleetLocked();
					mainHandler.post(() -> {
						if (generation == fleetGeneration && instance == TunnelService.this) {
							stopSelfHonoringForegroundContract();
						}
					});
					return;
				}
				if (frpc != null) {
					frpc.stop();
					frpc = null;
				}
				if (pendingFrpc != null) {
					pendingFrpc.stop();
					pendingFrpc = null;
				}
				List<String> keep = new ArrayList<>();
				for (VisitorFleet.Group group : groups) {
					keep.add(group.key);
					FrpcManager existing = fleet.get(group.key);
					if (existing != null && existing.matchesRunning(group.toml)) continue;
					if (existing != null) existing.stop();
					FrpcManager manager = new FrpcManager(TunnelService.this, group.fileName);
					final String key = group.key;
					manager.startManaged(new FrpcManager.TomlSource() {
						@Override public String toml() { return tomlFor(key); }
						@Override public String strategy() { return strategyFor(key); }
					});
					fleet.put(group.key, manager);
				}
				Iterator<Map.Entry<String, FrpcManager>> it = fleet.entrySet().iterator();
				while (it.hasNext()) {
					Map.Entry<String, FrpcManager> entry = it.next();
					if (keep.contains(entry.getKey())) continue;
					entry.getValue().stop();
					it.remove();
				}
			}
		}, "frpc-fleet").start();
		watchTunnelEnvironment();
	}

	/** 粘性作用域在写 toml 之前先对一次，换网络后这次同步会重新试打洞。 */
	private void noteStickyOnSync() {
		try {
			String netId = networkId();
			String ctx = stickyContext(netId);
			boolean ctxChanged = TunnelPath.noteStickyContext(ctx);
			Log.i(TAG, "T113 网络身份=" + netId + " 粘性作用域=" + ctx
				+ (ctxChanged ? "（上下文变化 ⇒ 已清零：" + TunnelPath.stickyResetReason() + "）" : "（未变化）")
				+ " 连续打洞失败=" + TunnelPath.holeFailStreak() + " 粘住中转=" + TunnelPath.stickyRelay());
		} catch (Exception e) {
			Log.w(TAG, "T113 粘性判定失败（按用户档位原样启动）：" + e);
		}
	}

	private String tomlFor(String key) {
		VisitorFleet.Group group = groupFor(key);
		return group == null ? "" : group.toml;
	}

	private String strategyFor(String key) {
		VisitorFleet.Group group = groupFor(key);
		return group == null ? VisitorConfig.STRATEGY_P2P : group.strategy;
	}

	private VisitorFleet.Group groupFor(String key) {
		SharedPreferences prefs = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
		String scope = canonicalScope(prefs.getString(ProfileStore.KEY_FLEET_SCOPE, SCOPE_SAME_FRPS), prefs);
		for (VisitorFleet.Group group : groupsFor(
			ProfileStore.list(prefs), ProfileStore.getActiveId(prefs), scope)) {
			if (group.key.equals(key)) return group;
		}
		return null;
	}

	private static List<VisitorFleet.Group> groupsFor(List<ProfileStore.Profile> profiles, String activeId, String scope) {
		if (SCOPE_ACTIVE.equals(scope)) {
			if (activeId == null || activeId.length() == 0) return new ArrayList<>();
			return VisitorFleet.build(profiles, activeId, TunnelPath.stickyRelay());
		}
		if (SCOPE_SAME_FRPS.equals(scope)) {
			return VisitorFleet.buildSameFrps(profiles, activeId, TunnelPath.stickyRelay());
		}
		return VisitorFleet.build(profiles, "", TunnelPath.stickyRelay());
	}

	private void stopFleetLocked() {
		for (FrpcManager manager : fleet.values()) manager.stop();
		fleet.clear();
		if (frpc != null) {
			frpc.stop();
			frpc = null;
		}
		if (pendingFrpc != null) {
			pendingFrpc.stop();
			pendingFrpc = null;
		}
	}

	/** 备用访客。当前 frpc 继续跑，直到 {@link #commitOverlap()}。 */
	private void startOverlapped(final VisitorConfig cfg, final String userStrategy) {
		synchronized (frpcLock) {
			pendingShouldPromote = false;
			pendingShouldDiscard = false;
			overlapStarting = true;
			pendingCfg = cfg;
			pendingUserStrategy = userStrategy;
		}
		Log.i(TAG, "重叠切换：备用隧道端口 " + cfg.bindPort + "，当前隧道保持");
		new Thread(() -> {
			FrpcManager next = new FrpcManager(TunnelService.this, "frpc-visitor-pending.toml");
			next.start(cfg);
			synchronized (frpcLock) {
				overlapStarting = false;
				if (pendingShouldDiscard) {
					next.stop();
					pendingFrpc = null;
					pendingCfg = null;
					pendingUserStrategy = null;
					pendingShouldDiscard = false;
					Log.i(TAG, "重叠切换已取消，备用隧道已停");
					return;
				}
				if (pendingFrpc != null && pendingFrpc != next) pendingFrpc.stop();
				pendingFrpc = next;
				if (pendingShouldPromote) {
					promoteLocked();
					pendingShouldPromote = false;
				}
			}
		}, "frpc-overlap").start();
	}

	private void commitOverlap() {
		new Thread(() -> {
			synchronized (frpcLock) {
				pendingShouldDiscard = false;
				if (pendingFrpc != null) {
					pendingShouldPromote = false;
					promoteLocked();
				} else {
					// 进程还在启动：等它把自己放进 pendingFrpc 后再交接，避免先停掉当前隧道。
					pendingShouldPromote = true;
				}
			}
		}, "frpc-promote").start();
	}

	private void abortOverlap() {
		new Thread(() -> {
			synchronized (frpcLock) {
				pendingShouldPromote = false;
				if (pendingFrpc != null) {
					pendingFrpc.stop();
					pendingFrpc = null;
					pendingCfg = null;
					pendingUserStrategy = null;
					pendingShouldDiscard = false;
					Log.i(TAG, "重叠切换已取消，备用隧道已停");
				} else {
					pendingShouldDiscard = true;
				}
			}
		}, "frpc-overlap-abort").start();
	}

	/** 调用方持有 {@link #frpcLock}。停旧进程可能要等它退出，不要在主线程调用。 */
	private void promoteLocked() {
		FrpcManager old = frpc;
		if (pendingFrpc != null) {
			frpc = pendingFrpc;
			pendingFrpc = null;
		}
		if (pendingCfg != null) {
			runningCfg = pendingCfg;
			persistRunningTunnel();
			pendingCfg = null;
		}
		Log.i(TAG, "重叠切换交接：当前隧道改为端口 "
			+ (runningCfg == null ? "?" : runningCfg.bindPort));
		if (old != null && old != frpc) old.stop();
	}

	private void persistRunningTunnel() {
		VisitorConfig cfg = runningCfg;
		if (cfg == null) return;
		SharedPreferences prefs = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
		ProfileStore.Profile active = ProfileStore.getActive(prefs);
		String id = active == null || active.id == null ? "" : active.id;
		String strategy = pendingUserStrategy != null && !pendingUserStrategy.isEmpty()
			? pendingUserStrategy : cfg.effectiveStrategy();
		pendingUserStrategy = null;
		prefs.edit()
			.putInt(ProfileStore.KEY_BOUND_PORT, cfg.bindPort)
			.putString(ProfileStore.KEY_TUNNEL_PROFILE, id)
			.putString(ProfileStore.KEY_TUNNEL_STRATEGY, strategy)
			.apply();
	}

	/**
	 * T113：隧道环境巡检（每 3 秒一次，随服务生命周期结束而撤销）。两件事：
	 *
	 * <ol>
	 *   <li><b>网络变化清零</b>：重算网络身份，与 {@link TunnelPath} 记的作用域比对；变了就清零粘性
	 *       （新网络重新试打洞）。这是本 App **真正生效**的联网变化判据 —— 没有
	 *       ACCESS_NETWORK_STATE 权限时 {@code registerDefaultNetworkCallback} 注册会抛异常，
	 *       只剩"定期比对网卡快照"这条无权限路径（见 {@link #networkId()}）。</li>
	 *   <li><b>粘性挂载</b>：一旦判定粘住，把当前配置对象改成 relay —— FrpcManager 的**任何一次**
	 *       重启都会写出纯中转 toml。**绝不主动重启 frpc**：那会掐断在途连接（页面加载、
	 *       WS 复用通道），用户看到的是白屏/断线横幅，那是回归不是优化。</li>
	 * </ol>
	 */
	private void watchTunnelEnvironment() {
		if (stickyWatch != null) mainHandler.removeCallbacks(stickyWatch);
		stickyWatch = new Runnable() {
			@Override public void run() {
				if (instance != TunnelService.this) return;
				try {
					String netId = networkId();
					if (TunnelPath.noteStickyContext(stickyContext(netId))) {
						Log.i(TAG, "T113 网络变化（网卡快照比对）⇒ 粘性回落清零，新网络身份=" + netId
							+ "（下次 frpc 启动重新试打洞）");
					}
					VisitorConfig cfg = runningCfg;
					if (cfg != null && VisitorConfig.STRATEGY_P2P.equals(cfg.strategy) && TunnelPath.stickyRelay()) {
						cfg.strategy = VisitorConfig.STRATEGY_RELAY;
						TunnelPath.noteStickyApplied();
						Log.i(TAG, "T113 粘性回落已挂到当前配置：后续 frpc 若重启将直接用纯中转 toml（不打断在途连接）");
					}
				} catch (Exception e) {
					Log.w(TAG, "T113 环境巡检失败：" + e);
				}
				mainHandler.postDelayed(this, 3000);
			}
		};
		mainHandler.postDelayed(stickyWatch, 3000);
	}

	/**
	 * T113：“网络身份”字符串 —— 粘性回落的作用域判据之一。
	 *
	 * <p><b>为什么不用 ConnectivityManager 做主判据</b>：本 App 的 Manifest **没有**
	 * {@code ACCESS_NETWORK_STATE}（T113 不在产品侧加新权限），`getActiveNetwork()` /
	 * `registerDefaultNetworkCallback()` 在设备上直接抛 SecurityException（装置日志有原文）。
	 * 因此主判据走**网卡快照**：{@code NetworkInterface.getNetworkInterfaces()} 的
	 * 「接口名 + 该接口上的地址」集合（排除回环、未启用的接口），Java 侧无需任何权限。
	 *
	 * <p>能测到的"换网络"：Wi-Fi↔流量（wlan0 出现/消失、rmnet_* 出现）、飞行模式（全部消失 ⇒ none）、
	 * 换 Wi-Fi/换 AP（wlan0 的 IP 变）、VPN 起停（tun0 出现/消失）。
	 * **测不到的**：同一接口上 IP 不变而公网出口变化的场景（如运营商侧 NAT 重排）——如实标注。
	 */
	private String networkId() {
		try {
			java.util.TreeMap<String, String> ifaces = new java.util.TreeMap<>();
			java.util.Enumeration<NetworkInterface> en = NetworkInterface.getNetworkInterfaces();
			if (en != null) {
				while (en.hasMoreElements()) {
					NetworkInterface ni = en.nextElement();
					if (ni == null || ni.isLoopback()) continue;
					boolean up;
					try {
						up = ni.isUp();
					} catch (Exception e) {
						up = true;
					}
					if (!up) continue;
					StringBuilder addrs = new StringBuilder();
					java.util.List<InterfaceAddress> list = ni.getInterfaceAddresses();
					java.util.TreeSet<String> sorted = new java.util.TreeSet<>();
					if (list != null) {
						for (InterfaceAddress ia : list) {
							if (ia == null || ia.getAddress() == null) continue;
							String host = ia.getAddress().getHostAddress();
							if (host == null) continue;
							// 链路本地/回环一律不参与身份（jitter 会让"网络没变"看起来变了）。
							String bare = host.split("%", 2)[0];
							if (bare.startsWith("127.") || bare.startsWith("169.254.") || bare.equals("::1") || bare.startsWith("fe80:")) continue;
							sorted.add(bare + "/" + ia.getNetworkPrefixLength());
						}
					}
					ifaces.put(ni.getName(), sorted.toString());
				}
			}
			if (ifaces.isEmpty()) return "none";
			StringBuilder b = new StringBuilder();
			for (java.util.Map.Entry<String, String> e : ifaces.entrySet()) {
				b.append(e.getKey()).append('=').append(e.getValue()).append(';');
			}
			return b.toString();
		} catch (Throwable e) {
			return "unknown";
		}
	}

	/** T113：粘性作用域 = 网络身份 | 配置组 id | 用户档位。任一变化 ⇒ 粘性清零、重新试打洞。 */
	private String stickyContext(String netId) {
		String id = "";
		String strategy = VisitorConfig.STRATEGY_P2P;
		try {
			SharedPreferences prefs = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
			ProfileStore.Profile active = ProfileStore.getActive(prefs);
			if (active != null) {
				id = active.id == null ? "" : active.id;
				strategy = ProfileStore.effectiveStrategy(active);
			}
		} catch (Exception ignored) {
		}
		return netId + "|" + id + "|" + strategy;
	}

	private void publishForeground() {
		if (instance != this) return;
		if (Looper.myLooper() != Looper.getMainLooper()) {
			mainHandler.post(this::publishForeground);
			return;
		}
		if (sessionRunning) {
			enterForeground(buildNotification());
			return;
		}
		// 空闲不留通知。若这次由 startForegroundService 拉起且还没进过前台，
		// 必须先 startForeground，否则约 5 秒后系统会杀掉服务；随后立刻撤掉。
		// 这条临时通知不带按钮，Android 12+ 会推迟显示，撤掉时通常还没出现。
		if (!holdingForeground) enterForeground(buildNotification());
		leaveForeground();
	}

	private void enterForeground(Notification notification) {
		try {
			if (Build.VERSION.SDK_INT >= 34) {
				// AND-02：Android 14+ 以 specialUse 类型启动（与 Manifest 声明一致）。
				// dataSync 有累计时长限制（默认 6 小时内系统可杀），不适合长时隧道。
				startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
			} else {
				startForeground(NOTIFICATION_ID, notification);
			}
			holdingForeground = true;
		} catch (Exception e) {
			Log.w(TAG, "进入前台失败：" + e);
		}
	}

	private void leaveForeground() {
		stopForegroundCompat();
		holdingForeground = false;
		NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
		if (nm != null) nm.cancel(NOTIFICATION_ID);
	}

	/**
	 * AND-01：早停路径退出前必须满足 startForegroundService 的 5 秒契约——
	 * 本次启动若经 startForegroundService() 拉起，却从未调 startForeground()
	 * 就 stopSelf()，Android 8+ 会抛 "did not then call Service.startForeground()"。
	 * 单纯 stopForeground 无法补上该契约（从未进过前台时解除是空操作），
	 * 因此还没进前台时先补一次 startForeground，再撤掉通知并退出。
	 */
	private void stopSelfHonoringForegroundContract() {
		if (Build.VERSION.SDK_INT >= 26 && !holdingForeground) {
			enterForeground(buildNotification());
		}
		leaveForeground();
		stopSelf();
	}

	/**
	 * AND-01：退出前必须先解除前台状态。若本次启动经由 startForegroundService()
	 * 而未调用 startForeground() 就 stopSelf()，Android 8+ 会抛
	 * "did not then call Service.startForeground()"。
	 */
	private void stopForegroundCompat() {
		if (Build.VERSION.SDK_INT >= 24) {
			stopForeground(STOP_FOREGROUND_REMOVE);
		} else {
			stopForeground(true);
		}
	}

	private Notification buildNotification() {
		boolean running = sessionRunning;
		String channel = running ? CHANNEL_SESSION : CHANNEL_KEEP;
		Notification.Builder b;
		if (Build.VERSION.SDK_INT >= 26) {
			b = new Notification.Builder(this, channel);
		} else {
			b = new Notification.Builder(this);
			b.setPriority(running ? Notification.PRIORITY_LOW : Notification.PRIORITY_MIN);
		}
		b.setSmallIcon(R.drawable.ic_stat_tunnel)
			.setOngoing(running)
			.setOnlyAlertOnce(true)
			.setShowWhen(running)
			.setContentIntent(launchIntent());
		if (running && Build.VERSION.SDK_INT >= 31) {
			b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
		}
		if (Build.VERSION.SDK_INT >= 21) {
			b.setVisibility(running ? Notification.VISIBILITY_PUBLIC : Notification.VISIBILITY_SECRET);
			if (running) b.setCategory(Notification.CATEGORY_PROGRESS);
		}
		// 静音由渠道保证（onCreate 里两渠道均 setSound(null,null)、无振动无灯光）。
		// framework Notification.Builder 没有 setSilent(boolean)——那是 androidx 的 API。

		if (running) {
			String title = sessionTitle.length() > 0 ? clip(sessionTitle, 64) : "DSH 会话";
			String text = sessionText.length() > 0 ? clip(sessionText, 160) : "正在生成…";
			b.setContentTitle(title).setContentText(text);
			if (Build.VERSION.SDK_INT >= 16) {
				b.setStyle(new Notification.BigTextStyle().bigText(text));
			}
			// AND-02：通知直达「断开」，不必先进 App 再停隧道。
			// 按钮只加在会话通知上。空闲那条临时通知若带按钮，系统会立刻展示。
			b.addAction(new Notification.Action.Builder(
				R.drawable.ic_stat_tunnel, "断开", stopIntent()).build());
			// D6 ②：通知直达「连接设置」。平板档不装移动 hook，页面上没有长按鲸鱼入口，
			// 这里是运行中进连接设置页的进程外入口；点它不碰隧道，只切 MainActivity 的界面。
			b.addAction(new Notification.Action.Builder(
				R.drawable.ic_stat_tunnel, "连接设置", settingsIntent()).build());
		} else {
			b.setContentTitle("DSH Remote").setContentText("");
		}
		return b.build();
	}

	private PendingIntent launchIntent() {
		Intent launch = new Intent(this, MainActivity.class);
		launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
		int flags = PendingIntent.FLAG_UPDATE_CURRENT;
		if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
		return PendingIntent.getActivity(this, 0, launch, flags);
	}

	private PendingIntent stopIntent() {
		Intent stop = new Intent(this, TunnelService.class);
		stop.setAction(ACTION_STOP);
		int flags = PendingIntent.FLAG_UPDATE_CURRENT;
		if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
		return PendingIntent.getService(this, 1, stop, flags);
	}

	/**
	 * D6 ②：通知「连接设置」动作。requestCode 2 与内容点(0)、断开(1) 相互独立——
	 * PendingIntent 的相等性不含 action，三个 requestCode 撞车会互相覆盖成同一个。
	 * 目标是 MainActivity 而非本服务，因此点它不会走 onStartCommand，不影响隧道生命周期。
	 */
	private PendingIntent settingsIntent() {
		Intent open = new Intent(this, MainActivity.class);
		open.setAction(MainActivity.ACTION_OPEN_SETTINGS);
		open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
		int flags = PendingIntent.FLAG_UPDATE_CURRENT;
		if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
		return PendingIntent.getActivity(this, 2, open, flags);
	}

	private static String clip(String text, int max) {
		if (text == null) return "";
		String t = text.trim();
		if (t.length() <= max) return t;
		return t.substring(0, Math.max(1, max - 1)) + "…";
	}

	@Override
	public void onDestroy() {
		if (instance == this) instance = null;
		sessionRunning = false;
		sessionTitle = "";
		sessionText = "";
		// T113：停掉环境巡检（网络变化清零 + 粘性挂载）。巡检是自续期的，必须显式摘掉，
		// 否则服务销毁后回调还挂在主线程上（虽然 Runnable 里有 instance 判断兜底）。
		if (stickyWatch != null) {
			mainHandler.removeCallbacks(stickyWatch);
			stickyWatch = null;
		}
		runningCfg = null;
		// T104：隧道停止 ⇒ 路径判定一起清掉，诊断行回落「隧道未启动（无法判定）」，，
		// 绝不把上一档的「打洞成功/回退中转」留在屏上冒充这一次。
		// T113：TunnelPath.clear() **不清**粘性回落状态（同一前台会话内"断开→再连接"不再白等一遍），
		// 粘性的清零只由 noteStickyContext（网络/配置组/策略变化）与 App 进程退出负责。
		TunnelPath.clear();
		synchronized (frpcLock) {
			pendingShouldPromote = false;
			pendingShouldDiscard = true;
			pendingCfg = null;
			pendingUserStrategy = null;
			fleetGeneration += 1;
			stopFleetLocked();
		}
		super.onDestroy();
	}

	@Override
	public IBinder onBind(Intent intent) {
		return null;
	}
}
