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
import java.util.Enumeration;
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
 * 通知：Android 要求前台服务必须挂一条通知。有智能体任务在跑时，通知显示
 * 会话标题和当前内容；空闲时改到静默渠道（尽量不进通知栏）。旧的「隧道」
 * 渠道一旦创建就降不了重要性，空闲必须换新渠道 id。
 * 通知带「断开」操作（AND-02），不进 App 即可停隧道；另有「连接设置」操作（D6 ②），
 * 给平板档（hook 关闭、页面上没有长按鲸鱼入口）补一个运行中进连接设置页的入口。
 */
public class TunnelService extends Service {

	/** 通知「断开」操作（AND-02）。 */
	public static final String ACTION_STOP = "top.d1studio.dshremote.action.STOP_TUNNEL";
	/** MainActivity 传入协商后的本地绑定端口（AND-07）；缺省时服务侧自行协商。 */
	public static final String EXTRA_BIND_PORT = "dshr_bind_port";
	private static final String TAG = "dshr-svc";

	private static final String CHANNEL_SESSION = "session_progress";
	private static final String CHANNEL_KEEP = "tunnel_keep";
	private static final int NOTIFICATION_ID = 1;

	private static volatile TunnelService instance;
	private static volatile boolean sessionRunning;
	private static volatile String sessionTitle = "";
	private static volatile String sessionText = "";

	private final Object frpcLock = new Object();
	private final Handler mainHandler = new Handler(Looper.getMainLooper());
	private FrpcManager frpc;

	/** T113：隧道环境巡检（网络变化清零 + 粘性挂载，见 {@link #watchTunnelEnvironment}）。 */
	private Runnable stickyWatch;
	/** T113：本次 frpc 启动实际用的配置对象（巡检要它能改到下一次重启写出的 toml）。 */
	private volatile VisitorConfig runningCfg;

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
			keep.setDescription("隧道保活。没有正在运行的会话时尽量不显示");
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
		ProfileStore.migrateLegacy(getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE));
		ProfileStore.Profile profile = ProfileStore.getActive(
			getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE));
		if (profile == null || !profile.isValid()) {
			stopSelfHonoringForegroundContract();
			return START_NOT_STICKY;
		}
		VisitorConfig cfg = profile.toVisitorConfig();

		// AND-07：端口协商。优先采用 MainActivity 协商后经 Intent 传入的端口；
		// 缺失时（如进程被杀后 START_STICKY 以 null intent 重启）就地协商，
		// 并把实际端口落盘，供 MainActivity 下次复用探测。
		int requested = intent == null ? -1 : intent.getIntExtra(EXTRA_BIND_PORT, -1);
		int port = (requested >= 1 && requested <= 65535) ? requested : ProfileStore.negotiateBindPort();
		if (port < 0) {
			Log.e(TAG, "端口协商失败：首选 " + ProfileStore.BIND_PORT + " 与回退范围 "
				+ ProfileStore.PORT_RANGE_MIN + "-" + ProfileStore.PORT_RANGE_MAX + " 均被占用");
			stopSelfHonoringForegroundContract();
			return START_NOT_STICKY;
		}
		cfg.bindPort = port;
		// 端口与「本隧道服务的配置组 id」成对落盘：MainActivity 复用探测据此
		// 判断存活隧道是否属于本次所选配置组，防止错复用连到旧 server。
		// T104：再落一个「实际生效的打洞策略」——复用探测也要比它，否则用户切了档
		// 却因为端口还活着被复用，跑到下一次重启前都还是旧档（切档名不副实）。
		getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE).edit()
			.putInt(ProfileStore.KEY_BOUND_PORT, port)
			.putString(ProfileStore.KEY_TUNNEL_PROFILE, profile.id)
			.putString(ProfileStore.KEY_TUNNEL_STRATEGY, cfg.effectiveStrategy())
			.apply();

		publishForeground();

		// ── T113：打洞回落的两个处置（粘性 / 网络清零）────────────────────────
		// 顺序要求：必须在上面的 KEY_TUNNEL_STRATEGY 落盘（用户档位）**之后**再改 cfg.strategy，
		// 否则 MainActivity 的「复用存活隧道」探测会拿"粘性中转"去比"用户选的打洞优先"，
		// 每次都判成策略变了而反复重启隧道。
		try {
			String netId = networkId();
			String ctx = stickyContext(netId);
			boolean ctxChanged = TunnelPath.noteStickyContext(ctx);
			Log.i(TAG, "T113 网络身份=" + netId + " 粘性作用域=" + ctx
				+ (ctxChanged ? "（上下文变化 ⇒ 已清零：" + TunnelPath.stickyResetReason() + "）" : "（未变化）")
				+ " 连续打洞失败=" + TunnelPath.holeFailStreak() + " 粘住中转=" + TunnelPath.stickyRelay());
			// 只有"用户选打洞优先"这一档才谈粘性；用户显式选「只用中转」时本来就写纯 stcp toml。
			if (VisitorConfig.STRATEGY_P2P.equals(cfg.effectiveStrategy()) && TunnelPath.stickyRelay()) {
				// 复用 T104 已有的「只用中转」toml（同一条 stcp 访客分支），不新发明任何 toml 写法。
				cfg.strategy = VisitorConfig.STRATEGY_RELAY;
				TunnelPath.noteStickyApplied();
				Log.i(TAG, "T113 粘性回落生效：连续 " + TunnelPath.holeFailStreak()
					+ " 次打洞超时 ⇒ 本次隧道直接用纯中转 toml（0 空等），换网络或重开 App 后自动重试打洞");
			}
		} catch (Exception e) {
			Log.w(TAG, "T113 粘性判定失败（按用户档位原样启动）：" + e);
		}

		final VisitorConfig toStart = cfg;
		runningCfg = cfg;
		new Thread(() -> {
			synchronized (frpcLock) {
				if (frpc != null) frpc.stop();
				FrpcManager next = new FrpcManager(TunnelService.this);
				next.start(toStart);
				frpc = next;
			}
		}, "frpc-start").start();
		watchTunnelEnvironment();
		return START_STICKY;
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
		Notification n = buildNotification();
		if (Build.VERSION.SDK_INT >= 34) {
			// AND-02：Android 14+ 以 specialUse 类型启动（与 Manifest 声明一致）。
			// dataSync 有累计时长限制（默认 6 小时内系统可杀），不适合长时隧道。
			// 34 以下无 FGS 类型强约束，直接无类型启动。
			startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
		} else {
			startForeground(NOTIFICATION_ID, n);
		}
	}

	/**
	 * AND-01：早停路径退出前必须满足 startForegroundService 的 5 秒契约——
	 * 本次启动若经 startForegroundService() 拉起，却从未调 startForeground()
	 * 就 stopSelf()，Android 8+ 会抛 "did not then call Service.startForeground()"。
	 * 单纯 stopForegroundCompat 无法补上该契约（从未 publish 过时解除是空操作），
	 * 因此先用当前通知补一次 startForeground，再解除前台并退出。已在前台时
	 * 该调用仅刷新通知，无副作用；通知 PendingIntent 触发的重启场景受系统
	 * 临时豁免保护，try/catch 兜底任何厂商差异。
	 */
	private void stopSelfHonoringForegroundContract() {
		if (Build.VERSION.SDK_INT >= 26) {
			try {
				if (Build.VERSION.SDK_INT >= 34) {
					startForeground(NOTIFICATION_ID, buildNotification(),
						ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
				} else {
					startForeground(NOTIFICATION_ID, buildNotification());
				}
			} catch (Exception e) {
				Log.w(TAG, "早停前补 startForeground 失败（继续退出）：" + e);
			}
		}
		stopForegroundCompat();
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
			.setOngoing(true)
			.setOnlyAlertOnce(true)
			.setShowWhen(running)
			.setContentIntent(launchIntent());
		// AND-02：通知直达「断开」，不必先进 App 再停隧道。
		b.addAction(new Notification.Action.Builder(
			R.drawable.ic_stat_tunnel, "断开", stopIntent()).build());
		// D6 ②：通知直达「连接设置」。平板档不装移动 hook，页面上没有长按鲸鱼入口，
		// 这里是运行中进连接设置页的进程外入口；点它不碰隧道，只切 MainActivity 的界面。
		b.addAction(new Notification.Action.Builder(
			R.drawable.ic_stat_tunnel, "连接设置", settingsIntent()).build());
		if (Build.VERSION.SDK_INT >= 21) {
			b.setVisibility(running ? Notification.VISIBILITY_PUBLIC : Notification.VISIBILITY_SECRET);
			b.setCategory(running ? Notification.CATEGORY_PROGRESS : Notification.CATEGORY_SERVICE);
		}
		// 静音由渠道保证（onCreate 里两渠道均 setSound(null,null)、无振动无灯光，
		// 空闲另走 IMPORTANCE_MIN 渠道）。framework Notification.Builder 没有
		// setSilent(boolean)——那是 androidx NotificationCompat 的 API。

		if (running) {
			String title = sessionTitle.length() > 0 ? clip(sessionTitle, 64) : "DSH 会话";
			String text = sessionText.length() > 0 ? clip(sessionText, 160) : "正在生成…";
			b.setContentTitle(title).setContentText(text);
			if (Build.VERSION.SDK_INT >= 16) {
				b.setStyle(new Notification.BigTextStyle().bigText(text));
			}
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
			if (frpc != null) {
				frpc.stop();
				frpc = null;
			}
		}
		super.onDestroy();
	}

	@Override
	public IBinder onBind(Intent intent) {
		return null;
	}
}
