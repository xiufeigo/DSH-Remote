package android.util;

/** JVM 装置不需要 Android 日志服务。 */
public final class Log {
	public static int i(String tag, String message) { return 0; }
	public static int w(String tag, String message) { return 0; }
}
