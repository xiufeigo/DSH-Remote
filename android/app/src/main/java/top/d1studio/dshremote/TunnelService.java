package top.d1studio.dshremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import java.util.Locale;

/**
 * 隧道前台服务：保活 frpc visitor（stcp/xtcp）。
 * 配置从 SharedPreferences 读取；MainActivity 负责写入并 startForegroundService。
 * 启停 frpc 放在后台线程，避免主线程等进程退出导致 ANR。
 */
public class TunnelService extends Service {

	private static final String CHANNEL_ID = "tunnel";
	private static final int NOTIFICATION_ID = 1;

	private final Object frpcLock = new Object();
	private FrpcManager frpc;

	@Override
	public void onCreate() {
		super.onCreate();
		NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
		if (nm != null && Build.VERSION.SDK_INT >= 26) {
			nm.createNotificationChannel(new NotificationChannel(
				CHANNEL_ID, "隧道", NotificationManager.IMPORTANCE_LOW));
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

		Notification n = buildNotification(cfg.bindPort);
		if (Build.VERSION.SDK_INT >= 29) {
			startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
		} else {
			startForeground(NOTIFICATION_ID, n);
		}

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

	private Notification buildNotification(int bindPort) {
		Notification.Builder b;
		if (Build.VERSION.SDK_INT >= 26) {
			b = new Notification.Builder(this, CHANNEL_ID);
		} else {
			b = new Notification.Builder(this);
			b.setPriority(Notification.PRIORITY_LOW);
		}
		b.setContentTitle("DSH Remote 隧道运行中")
			.setContentText(String.format(Locale.US, "本机 %d 端口直通家里网关", bindPort))
			.setSmallIcon(R.drawable.ic_stat_tunnel)
			.setOngoing(true);
		return b.build();
	}

	@Override
	public void onDestroy() {
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
