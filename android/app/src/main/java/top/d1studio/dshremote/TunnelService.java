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

/**
 * 隧道前台服务：保活 frpc visitor（stcp/xtcp）。
 * 配置从 SharedPreferences 读取；MainActivity 负责写入并 startForegroundService。
 * 启停 frpc 放在后台线程，避免主线程等进程退出导致 ANR。
 *
 * 通知：Android 要求前台服务必须挂一条通知。有智能体任务在跑时，通知显示
 * 会话标题和当前内容；空闲时改到静默渠道（尽量不进通知栏）。旧的「隧道」
 * 渠道一旦创建就降不了重要性，空闲必须换新渠道 id。
 */
public class TunnelService extends Service {

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
		ProfileStore.migrateLegacy(getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE));
		ProfileStore.Profile profile = ProfileStore.getActive(
			getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE));
		if (profile == null || !profile.isValid()) {
			stopSelf();
			return START_NOT_STICKY;
		}
		VisitorConfig cfg = profile.toVisitorConfig();

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
		if (Build.VERSION.SDK_INT >= 29) {
			startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
		} else {
			startForeground(NOTIFICATION_ID, n);
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
		if (Build.VERSION.SDK_INT >= 21) {
			b.setVisibility(running ? Notification.VISIBILITY_PUBLIC : Notification.VISIBILITY_SECRET);
			b.setCategory(running ? Notification.CATEGORY_PROGRESS : Notification.CATEGORY_SERVICE);
		}
		if (Build.VERSION.SDK_INT >= 29) b.setSilent(!running);

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
