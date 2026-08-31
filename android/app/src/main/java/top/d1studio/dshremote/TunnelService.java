package top.d1studio.dshremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

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
 * 通知带「断开」操作（AND-02），不进 App 即可停隧道。
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
		getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE).edit()
			.putInt(ProfileStore.KEY_BOUND_PORT, port).apply();

		publishForeground();

		final VisitorConfig toStart = cfg;
		new Thread(() -> {
			synchronized (frpcLock) {
				if (frpc != null) frpc.stop();
				FrpcManager next = new FrpcManager(TunnelService.this);
				next.start(toStart);
				frpc = next;
			}
		}, "frpc-start").start();
		return START_STICKY;
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
