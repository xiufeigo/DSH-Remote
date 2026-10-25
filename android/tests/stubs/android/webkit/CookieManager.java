package android.webkit;

/** 仅供 PinnedFetch JVM 装置；生产 APK 仍使用系统 CookieManager。 */
public final class CookieManager {
	private static final CookieManager INSTANCE = new CookieManager();
	public static CookieManager getInstance() { return INSTANCE; }
	public String getCookie(String url) { return ""; }
	public void setAcceptCookie(boolean value) {}
	public void setCookie(String url, String cookie, ValueCallback<Boolean> callback) { callback.onReceiveValue(true); }
	public void flush() {}
}
