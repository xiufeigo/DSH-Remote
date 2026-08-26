package top.d1studio.dshremote;

import android.content.SharedPreferences;
import android.net.Uri;
import android.text.TextUtils;

import java.util.Locale;

/**
 * 访客隧道配置 —— 与 PC 端网关生成的连接串一一对应：
 *
 *   dsh-remote://visitor?v=1&mode=xtcp&server=1.2.3.4&cport=7000
 *       &name=<隧道名，与电脑端 frp.name 一致>&sk=<访客密钥>&token=<frps登录密钥>&bport=18443&fp=<证书指纹>
 *
 * 字段语义与 packages/gateway/src/frp.ts 的 renderVisitorToml / visitorConnectionString
 * 保持一致，两端任何一侧调整都要同步。
 */
public final class VisitorConfig {

	public String mode = "xtcp";      // stcp | xtcp
	public String serverAddr = "";    // frps 地址（VPS）
	public int serverPort = 7000;     // frps 控制端口
	public String serverName = "dsh-remote";
	public String secretKey = "";     // 访客密钥（proxy 与 visitor 必须一致）
	public String authToken = "";     // frpc↔frps 登录密钥
	public int bindPort = 18443;      // 与电脑端网关 listenPort 对齐，App 不让用户改
	public String fingerprint = "";   // 网关自签证书 SHA-256（hex 小写无冒号；空 = 退化为 TOFU 确认）

	/** 从 dsh-remote://visitor?... 解析；格式不对返回 null。 */
	public static VisitorConfig parse(String link) {
		if (link == null) return null;
		Uri uri;
		try {
			uri = Uri.parse(link.trim());
		} catch (Exception e) {
			return null;
		}
		if (!"dsh-remote".equals(uri.getScheme()) || !"visitor".equals(uri.getHost())) return null;
		VisitorConfig c = new VisitorConfig();
		String v = uri.getQueryParameter("mode");
		if ("stcp".equals(v) || "xtcp".equals(v)) c.mode = v;
		c.serverAddr = nz(uri.getQueryParameter("server"));
		v = uri.getQueryParameter("cport");
		c.serverPort = parseInt(v, c.serverPort);
		v = uri.getQueryParameter("name");
		if (!TextUtils.isEmpty(v)) c.serverName = v;
		c.secretKey = nz(uri.getQueryParameter("sk"));
		c.authToken = nz(uri.getQueryParameter("token"));
		v = uri.getQueryParameter("bport");
		c.bindPort = ProfileStore.BIND_PORT;
		if (!TextUtils.isEmpty(v)) c.bindPort = parseInt(v, c.bindPort);
		v = uri.getQueryParameter("fp");
		if (!TextUtils.isEmpty(v)) c.fingerprint = v.toLowerCase(Locale.US).replace(":", "");
		return c.isValid() ? c : null;
	}

	public boolean isValid() {
		return serverAddr.length() > 0 && serverPort >= 1 && serverPort <= 65535
			&& serverName.length() > 0 && secretKey.length() > 0 && authToken.length() > 0
			&& bindPort >= 1 && bindPort <= 65535;
	}

	/** 渲染访客侧 frpc.toml —— 与网关 renderVisitorToml 同构。 */
	public String toToml() {
		StringBuilder b = new StringBuilder();
		b.append("# 由 DSH Remote App 自动生成\n");
		b.append("serverAddr = \"").append(serverAddr).append("\"\n");
		b.append("serverPort = ").append(serverPort).append("\n\n");
		b.append("auth.token = \"").append(authToken).append("\"\n");
		b.append("transport.tls.enable = true\n\n");
		if ("xtcp".equals(mode)) {
			String stcpVisitor = serverName + "-stcp-visitor";
			b.append("[[visitors]]\n");
			b.append("name = \"").append(stcpVisitor).append("\"\n");
			b.append("type = \"stcp\"\n");
			b.append("serverName = \"").append(serverName).append("-stcp\"\n");
			b.append("secretKey = \"").append(secretKey).append("\"\n");
			b.append("bindPort = -1\n\n");
			b.append("[[visitors]]\n");
			b.append("name = \"").append(serverName).append("-visitor\"\n");
			b.append("type = \"xtcp\"\n");
			b.append("serverName = \"").append(serverName).append("\"\n");
			b.append("secretKey = \"").append(secretKey).append("\"\n");
			b.append("bindAddr = \"127.0.0.1\"\n");
			b.append("bindPort = ").append(bindPort).append("\n");
			b.append("keepTunnelOpen = true\n");
			b.append("fallbackTo = \"").append(stcpVisitor).append("\"\n");
			b.append("fallbackTimeoutMs = 5000\n");
			return b.toString();
		}
		b.append("[[visitors]]\n");
		b.append("name = \"").append(serverName).append("-visitor\"\n");
		b.append("type = \"stcp\"\n");
		b.append("serverName = \"").append(serverName).append("\"\n");
		b.append("secretKey = \"").append(secretKey).append("\"\n");
		b.append("bindAddr = \"127.0.0.1\"\n");
		b.append("bindPort = ").append(bindPort).append("\n");
		return b.toString();
	}

	// ---------- 持久化 ----------

	private static final String P_MODE = "vp_mode";
	private static final String P_SERVER = "vp_server";
	private static final String P_CPORT = "vp_cport";
	private static final String P_NAME = "vp_name";
	private static final String P_SK = "vp_sk";
	private static final String P_TOKEN = "vp_token";
	private static final String P_BPORT = "vp_bport";
	private static final String P_FP = "vp_fp";

	public void save(SharedPreferences p) {
		p.edit()
			.putString(P_MODE, mode)
			.putString(P_SERVER, serverAddr)
			.putInt(P_CPORT, serverPort)
			.putString(P_NAME, serverName)
			.putString(P_SK, secretKey)
			.putString(P_TOKEN, authToken)
			.putInt(P_BPORT, bindPort)
			.putString(P_FP, fingerprint)
			.apply();
	}

	public void load(SharedPreferences p) {
		mode = p.getString(P_MODE, mode);
		serverAddr = p.getString(P_SERVER, "");
		serverPort = p.getInt(P_CPORT, serverPort);
		serverName = p.getString(P_NAME, serverName);
		secretKey = p.getString(P_SK, "");
		authToken = p.getString(P_TOKEN, "");
		bindPort = p.getInt(P_BPORT, bindPort);
		fingerprint = p.getString(P_FP, "");
	}

	public boolean existsIn(SharedPreferences p) {
		return !TextUtils.isEmpty(p.getString(P_SK, null));
	}

	// ---------- 工具 ----------

	private static String nz(String s) {
		return s == null ? "" : s.trim();
	}

	private static int parseInt(String s, int fallback) {
		try {
			return Integer.parseInt(nz(s));
		} catch (NumberFormatException e) {
			return fallback;
		}
	}
}
