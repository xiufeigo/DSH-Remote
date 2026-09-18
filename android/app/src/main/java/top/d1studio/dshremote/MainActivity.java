package top.d1studio.dshremote;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.text.InputType;
import android.text.TextUtils;
import android.util.Log;
import android.view.ContextThemeWrapper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsAnimation;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.JavascriptInterface;
import android.webkit.CookieManager;
import android.webkit.HttpAuthHandler;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebBackForwardList;
import android.webkit.WebChromeClient;
import android.webkit.WebHistoryItem;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebViewDatabase;
import android.webkit.WebStorage;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;

/**
 * DSH Remote Android 客户端。
 *
 * 配置组与电脑端插件面板对齐，只填四项：VPS 地址、控制端口、登录密钥、访客密钥。
 * 本地端口首选 18443（与网关 listenPort 一致），被占用时在 16225~16235 内协商
 * （AND-07），实际端口透传给 frpc visitor 与 WebView 加载 URL，无需在手机上改。
 * 启动进首页列出配置组，由用户手选连接（不默认连上次，避免上次 server 未启动
 * 时 App 卡死在连接壳）；点卡片切换远程配置；访客密钥与电脑端一致即可连入，
 * 不再扫码配对。
 */
public class MainActivity extends Activity {

	public static final String PREFS = "dsh_remote";
	private static final String KEY_URL = "gateway_url";
	private static final String KEY_CERT_PREFIX = "cert_fp_";
	private static final String KEY_HTTP_AUTH_REMEMBER_PREFIX = "http_auth_remember_";
	private static final String MOBILE_UA_TOKEN = " DSHRemoteAndroid/1";
	private static final int IME_PAD_HYSTERESIS_DP = 12;
	private static final int REQ_FILE_CHOOSER = 1001;
	private static final int REQ_NOTIF_PERM = 1002;
	private static final long TUNNEL_READY_TIMEOUT_MS = 20_000L;

	private enum UiState {
		BOOTSTRAP,
		CONNECTING,
		WEB,
		HOME,
		EDIT
	}

	private FrameLayout rootLayout;
	private ScrollView homeScroll;
	private LinearLayout profilesBox;
	private ScrollView setupScroll;
	private LinearLayout directNodesBox;
	private EditText etName, etServer, etCport, etTunnel, etSk, etToken;
	private TextView tvTunnelState;
	private Button resumeSessionBtn;
	private String editingProfileId = "";
	private WebView webView;
	private ValueCallback<Uri[]> fileCallback;
	/** 当前 WebView 加载的远端地址；本地启动壳不参与证书与同源判断。 */
	private String activeUrl = "";
	/** 从会话进入连接设置时暂存，用于「返回会话」而不必重连。 */
	private String resumeUrl = "";
	private boolean canResumeSession = false;
	private UiState uiState = UiState.BOOTSTRAP;
	/** 每次重新配置/断开都递增，过期的隧道等待线程不得再打开旧页面。 */
	private int connectionGeneration = 0;
	private boolean awaitingCertificateDecision = false;
	private AlertDialog httpAuthDialog;
	private Runnable pendingHttpAuthCancel;
	private String lastHttpAuthHost = "";
	private String lastHttpAuthUser = "";
	/** 每次打开网关，对已保存的 host+realm 凭据最多自动提交一次，防止错误密码死循环。 */
	private final Set<String> submittedHttpAuthThisConnection = new HashSet<>();
	/** 缓存的移动适配脚本（res/raw/mobile.js）；远端页面加载完成后注入。 */
	private String mobileAdaptJs;
	/** 当前已应用到根布局的 IME 底边距（px）。-1 表示尚未同步。 */
	private int currentImePadding = -1;
	/** 当前实际平移量（可能小于 IME 高度，避免把输入框顶出屏幕）。 */
	private int currentImeShift = Integer.MIN_VALUE;
	/** WebView 内焦点输入框相对 WebView 顶部的 CSS 像素，已换算成设备像素。 */
	private int lastImeFocusTopPx = -1;
	private int lastImeFocusBottomPx = -1;
	/** IME 动画进行中：只平移，不改布局、不注入 inset JS。 */
	private boolean imeAnimating = false;
	/** 会话页已成为 WebView 历史根，避免返回键退到连接壳 / settings URL。 */
	private boolean sessionHistoryRooted = false;
	/** 主动 stopLoading / 换页时忽略 WebView 的 ERR_ABORTED，避免误报断线并踢回设置页。 */
	private boolean suppressGatewayErrors = false;
	private int suppressGatewayEpoch = 0;
	private long lastBackAt = 0;
	/** DSH 页面是否处于深色（body[data-ds-dark-theme]），用于状态栏图标和 WebView 底色。 */
	private boolean pageDark = false;
	/** 直连重试不得误用当前选中的 FRP 配置组。 */
	private String directTarget = "";
	/** 会话页沉浸状态栏；注入失败时退回实色。 */
	private boolean edgeToEdgeChrome = true;
	/**
	 * PERF-03：WebView JS 定时器是否已挂起（pauseTimers/resumeTimers 必须成对，
	 * 重复 pause 会叠加计数导致 resume 一次不够，故用本标记守卫）。
	 */
	private boolean webTimersPaused = false;

	/**
	 * AND-06：统一后台线程池（单线程、命名、守护），替换原裸 new Thread 的
	 * 端口探测/隧道等待轮询；onDestroy 时 shutdownNow() 取消在途任务。
	 * 两个后台任务（返回会话探测、隧道就绪等待）由状态机保证不并发，单线程即可。
	 */
	private final ScheduledExecutorService bgExecutor = Executors.newSingleThreadScheduledExecutor(r -> {
		Thread t = new Thread(r, "dshr-bg");
		t.setDaemon(true);
		return t;
	});
	/** AND-03/AND-06：Activity 已销毁——不再提交后台任务、不再执行 UI 回调。 */
	private volatile boolean destroyed = false;

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);
		pageDark = isSystemDark();
		configureSystemBars();
		CookieManager.getInstance().setAcceptCookie(true);
		rootLayout = new FrameLayout(this);
		setContentView(rootLayout);
		installImeInsetHandling();
		buildHomeView();
		buildEditView();
		ensureWebView();
		ProfileStore.migrateLegacy(prefs());
		ProfileStore.migrateDirect(prefs());
		if (!handleImportIntent(getIntent())) {
			// 启动一律进服务器选择页：上次连的 server 不在线时，自动连接会把 App
			// 卡死在连接壳。连哪个 server 由用户当场手选（导入链接除外，那是显式意图）。
			showHome();
		}
	}

	@Override
	protected void onNewIntent(Intent intent) {
		super.onNewIntent(intent);
		setIntent(intent);
		handleImportIntent(intent);
	}

	@Override
	protected void onPause() {
		super.onPause();
		CookieManager.getInstance().flush();
		// PERF-03：退后台即挂起 WebView 渲染与全 WebView JS 定时器（含 DSH 的
		// token 流 MutationObserver/rAF、mobile.js 通知扫描），让射频/CPU 能睡；
		// frpc 隧道与前台服务保留，会话不断，只是页面暂停。回前台见 onResume。
		if (webView != null) {
			try {
				webView.onPause();
			} catch (Exception ignored) {
			}
			if (!webTimersPaused) {
				try {
					webView.pauseTimers();
					webTimersPaused = true;
				} catch (Exception ignored) {
				}
			}
		}
	}

	@Override
	protected void onResume() {
		super.onResume();
		// PERF-03：与 onPause 成对恢复；在 WEB 态补一次 inset/注入（暂停期间
		// 键盘/旋转事件可能漏掉），已有 resumeLiveSession 保证不断整页重载。
		if (webView != null) {
			try {
				webView.onResume();
			} catch (Exception ignored) {
			}
			if (webTimersPaused) {
				try {
					webView.resumeTimers();
				} catch (Exception ignored) {
				} finally {
					webTimersPaused = false;
				}
			}
			if (uiState == UiState.WEB && webView.getVisibility() == View.VISIBLE) {
				applyInsetsToPage(webView);
				// REVIEW-03：后台期间 pauseTimers 未必冻住 WS 事件，running 翻转的
				// 通知可能陈旧（结束仍显示"生成中"）。回前台主动重读一次通知，
				// 经 JS bridge 刷新前台服务文案；读不到桥时静默跳过。
				try {
					webView.evaluateJavascript(
						"(function(){try{var b=window.__dshRemoteAndroidMobile;"
						+ "if(!b||typeof b.readSessionNotice!=='function')return;"
						+ "var n=b.readSessionNotice();"
						+ "if(window.DshRemoteApp&&typeof window.DshRemoteApp.setSessionNotice==='function')"
						+ "window.DshRemoteApp.setSessionNotice(n.title||'',n.text||'',!!n.running);"
						+ "}catch(e){}})()",
						null);
				} catch (Exception ignored) {
				}
			}
		}
	}

	@Override
	protected void onDestroy() {
		// AND-03/AND-06：先关统一线程池——中断在途的隧道就绪轮询与返回会话探测，
		// 等待轮询线程不再持有 Activity 空转。
		destroyed = true;
		bgExecutor.shutdownNow();
		dismissPendingHttpAuth();
		fileCallback = null;
		if (webView != null) {
			// AND-03：非静态内部类 AppBridge 经 addJavascriptInterface 被 WebView 持有，
			// 不销毁则 Chromium 内核与 Activity Context 全部泄漏。顺序：摘 JS 桥
			// → 移出视图树 → 清子视图（Chromium 全屏视频/下拉等宿主子 View）
			// → 停止加载 → 清历史 → destroy。
			webView.removeJavascriptInterface("DshRemoteApp");
			webView.setOnKeyListener(null);
			webView.setWebViewClient(null);
			webView.setWebChromeClient(null);
			webView.setDownloadListener(null);
			if (rootLayout != null) rootLayout.removeView(webView);
			webView.removeAllViews();
			webView.stopLoading();
			webView.clearHistory();
			webView.destroy();
			webView = null;
		}
		// DOM Storage（localStorage/sessionStorage/indexedDB）由 WebView 全局
		// profile 持有，不随 webView.destroy() 释放——Activity 销毁时残留的
		// 远端页面数据会跨启动存活。本 App 是远程访问壳，退出即清，不留痕迹。
		WebStorage.getInstance().deleteAllData();
		super.onDestroy();
	}

	private void configureSystemBars() {
		// Edge-to-edge 下不要让系统改窗口高度：键盘用平移抬起，避免 WebView 重排/字体抖动。
		int imeMode = Build.VERSION.SDK_INT >= 30
			? WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
			: WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
		getWindow().setSoftInputMode(imeMode | WindowManager.LayoutParams.SOFT_INPUT_STATE_UNCHANGED);
		if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
		getWindow().setStatusBarColor(Color.TRANSPARENT);
		getWindow().setNavigationBarColor(shellColor(R.color.shell_background));
		if (Build.VERSION.SDK_INT >= 28) {
			getWindow().setNavigationBarDividerColor(Color.WHITE);
			WindowManager.LayoutParams attrs = getWindow().getAttributes();
			attrs.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
			getWindow().setAttributes(attrs);
		}
		if (Build.VERSION.SDK_INT >= 29) getWindow().setStatusBarContrastEnforced(false);
		if (Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(false);
		int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
			| View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
			| View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
		if (Build.VERSION.SDK_INT >= 26) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
		getWindow().getDecorView().setSystemUiVisibility(flags);
		applySystemBars();
	}

	private boolean isSystemDark() {
		return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
			== Configuration.UI_MODE_NIGHT_YES;
	}

	private int shellColor(int resource) {
		return getResources().getColor(resource, getTheme());
	}

	/** 重着色而不重建表单，保留未保存的输入、焦点和滚动位置。 */
	private void tintShell(View view) {
		if (view == null) return;
		String role = view.getTag() instanceof String ? (String) view.getTag() : "";
		if (view instanceof ScrollView) view.setBackgroundColor(shellColor(R.color.shell_background));
		if (view.getBackground() instanceof GradientDrawable) {
			GradientDrawable bg = (GradientDrawable) view.getBackground();
			boolean selected = "selected-card".equals(role);
			boolean primary = "primary-button".equals(role);
			bg.setColor(primary ? 0xFF1B66FF : shellColor(R.color.shell_surface));
			bg.setStroke(dp(selected ? 2 : 1, getResources().getDisplayMetrics().density),
				selected || primary ? 0xFF1B66FF : shellColor(R.color.shell_border));
		}
		if (view instanceof TextView) {
			TextView text = (TextView) view;
			text.setTextColor("primary-button".equals(role) ? Color.WHITE
				: shellColor("muted".equals(role) ? R.color.shell_muted : R.color.shell_text));
			text.setHintTextColor(shellColor(R.color.shell_muted));
			if (text instanceof EditText) text.setBackgroundTintList(
				android.content.res.ColorStateList.valueOf(shellColor(R.color.shell_muted)));
		}
		if (view instanceof android.view.ViewGroup) {
			android.view.ViewGroup group = (android.view.ViewGroup) view;
			for (int i = 0; i < group.getChildCount(); i++) tintShell(group.getChildAt(i));
		}
	}

	// ---------- 首页：配置组卡片 ----------

	private void buildHomeView() {
		float d = getResources().getDisplayMetrics().density;
		int side = dp(18, d);

		LinearLayout box = new LinearLayout(this);
		box.setOrientation(LinearLayout.VERTICAL);
		box.setPadding(side, dp(8, d), side, dp(28, d));

		TextView title = new TextView(this);
		title.setText("DSH Remote");
		title.setTextSize(24);
		title.setTypeface(null, android.graphics.Typeface.BOLD);
		title.setPadding(0, dp(12, d), 0, dp(4, d));
		box.addView(title);

		TextView subtitle = hintText("点一张配置组即可切换并连接。四项与电脑插件设置一致：VPS 地址、控制端口、登录密钥、访客密钥。", d);
		box.addView(subtitle);

		resumeSessionBtn = styledButton("返回当前会话", true, d);
		resumeSessionBtn.setVisibility(View.GONE);
		resumeSessionBtn.setOnClickListener(v -> resumeSession());
		LinearLayout.LayoutParams resumeParams = new LinearLayout.LayoutParams(
			LinearLayout.LayoutParams.MATCH_PARENT, dp(48, d));
		resumeParams.topMargin = dp(12, d);
		resumeParams.bottomMargin = dp(4, d);
		box.addView(resumeSessionBtn, resumeParams);

		profilesBox = new LinearLayout(this);
		profilesBox.setOrientation(LinearLayout.VERTICAL);
		box.addView(profilesBox);

		Button add = styledButton("添加配置组", true, d);
		add.setOnClickListener(v -> showEditor(null));
		LinearLayout.LayoutParams addParams = new LinearLayout.LayoutParams(
			LinearLayout.LayoutParams.MATCH_PARENT, dp(48, d));
		addParams.topMargin = dp(16, d);
		box.addView(add, addParams);

		tvTunnelState = new TextView(this);
		tvTunnelState.setTextSize(13);
		tvTunnelState.setPadding(0, dp(10, d), 0, 0);
		box.addView(tvTunnelState);

		LinearLayout direct = card(d);
		direct.addView(cardTitle("直连入口或局域网", d));
		direct.addView(hintText("保存多个 HTTPS 网关节点；连接和重试均不启动 FRP。", d));
		directNodesBox = new LinearLayout(this);
		directNodesBox.setOrientation(LinearLayout.VERTICAL);
		direct.addView(directNodesBox);
		Button addDirect = styledButton("添加直连节点", true, d);
		addDirect.setOnClickListener(v -> showDirectEditor(null));
		direct.addView(addDirect, new LinearLayout.LayoutParams(
			LinearLayout.LayoutParams.MATCH_PARENT, dp(44, d)));
		box.addView(direct, cardParams(d));

		LinearLayout maintain = card(d);
		maintain.addView(cardTitle("连接维护", d));
		Button disconnect = styledButton("停止隧道", false, d);
		disconnect.setOnClickListener(v -> stopTunnel());
		maintain.addView(disconnect, new LinearLayout.LayoutParams(
			LinearLayout.LayoutParams.MATCH_PARENT, dp(44, d)));
		Button clear = styledButton("清除本机授权数据", false, d);
		clear.setOnClickListener(v -> clearDeviceData());
		LinearLayout.LayoutParams clearParams = new LinearLayout.LayoutParams(
			LinearLayout.LayoutParams.MATCH_PARENT, dp(44, d));
		clearParams.topMargin = dp(10, d);
		maintain.addView(clear, clearParams);
		Button about = styledButton("关于 DSH Remote", false, d);
		about.setOnClickListener(v -> showAbout());
		LinearLayout.LayoutParams aboutParams = new LinearLayout.LayoutParams(
			LinearLayout.LayoutParams.MATCH_PARENT, dp(44, d));
		aboutParams.topMargin = dp(10, d);
		maintain.addView(about, aboutParams);
		box.addView(maintain, cardParams(d));

		homeScroll = insetScroll(box);
		homeScroll.setVisibility(View.GONE);
		rootLayout.addView(homeScroll,
			new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
	}

	private void refreshProfileCards() {
		if (profilesBox == null) return;
		profilesBox.removeAllViews();
		float d = getResources().getDisplayMetrics().density;
		List<ProfileStore.Profile> profiles = ProfileStore.list(prefs());
		String activeId = ProfileStore.getActiveId(prefs());
		if (profiles.isEmpty()) {
			LinearLayout empty = card(d);
			empty.addView(hintText("还没有配置组。点下方按钮添加，四项与电脑「设置 → 插件 → DSH Remote」一致。", d));
			profilesBox.addView(empty, cardParams(d));
			return;
		}
		for (final ProfileStore.Profile profile : profiles) {
			boolean active = profile.id.equals(activeId);
			LinearLayout item = card(d);
			if (active) {
				GradientDrawable bg = new GradientDrawable();
				bg.setColor(0xFFFFFFFF);
				bg.setCornerRadius(14 * d);
				bg.setStroke(Math.max(2, dp(2, d)), 0xFF1B66FF);
				item.setBackground(bg);
				item.setTag("selected-card");
			}
			TextView name = cardTitle(TextUtils.isEmpty(profile.name) ? profile.serverAddr : profile.name, d);
			item.addView(name);
			TextView meta = hintText(profile.serverAddr + ":" + profile.serverPort
				+ (active ? "  ·  当前" : ""), d);
			item.addView(meta);

			LinearLayout actions = new LinearLayout(this);
			actions.setOrientation(LinearLayout.HORIZONTAL);
			actions.setPadding(0, dp(4, d), 0, 0);
			Button open = styledButton("连接", true, d);
			open.setOnClickListener(v -> connectProfile(profile));
			LinearLayout.LayoutParams openParams = new LinearLayout.LayoutParams(0, dp(42, d), 1f);
			actions.addView(open, openParams);
			Button edit = styledButton("编辑", false, d);
			edit.setOnClickListener(v -> showEditor(profile));
			LinearLayout.LayoutParams editParams = new LinearLayout.LayoutParams(0, dp(42, d), 1f);
			editParams.leftMargin = dp(8, d);
			actions.addView(edit, editParams);
			item.addView(actions);
			item.setOnClickListener(v -> connectProfile(profile));
			profilesBox.addView(item, cardParams(d));
		}
	}

	private void refreshDirectNodes() {
		if (directNodesBox == null) return;
		directNodesBox.removeAllViews();
		float d = getResources().getDisplayMetrics().density;
		String lastId = prefs().getString(ProfileStore.KEY_DIRECT_ACTIVE, "");
		List<ProfileStore.DirectNode> nodes = ProfileStore.listDirect(prefs());
		if (nodes.isEmpty()) directNodesBox.addView(hintText("还没有直连节点，点击下方添加。", d));
		for (ProfileStore.DirectNode node : nodes) {
			LinearLayout item = card(d);
			if (node.id.equals(lastId)) item.setTag("selected-card");
			item.addView(cardTitle(node.name.isEmpty() ? node.url : node.name, d));
			item.addView(hintText(node.url + (node.id.equals(lastId) ? "  ·  上次选择" : ""), d));
			LinearLayout actions = new LinearLayout(this);
			actions.setOrientation(LinearLayout.HORIZONTAL);
			Button connect = styledButton("连接", true, d);
			connect.setOnClickListener(v -> connectDirectNode(node));
			actions.addView(connect, new LinearLayout.LayoutParams(0, dp(42, d), 1));
			Button edit = styledButton("编辑", false, d);
			edit.setOnClickListener(v -> showDirectEditor(node));
			LinearLayout.LayoutParams ep = new LinearLayout.LayoutParams(0, dp(42, d), 1);
			ep.leftMargin = dp(8, d);
			actions.addView(edit, ep);
			item.addView(actions);
			item.setOnClickListener(v -> connectDirectNode(node));
			LinearLayout.LayoutParams ip = cardParams(d);
			ip.bottomMargin = dp(12, d);
			directNodesBox.addView(item, ip);
		}
		tintShell(directNodesBox);
	}

	private void showDirectEditor(ProfileStore.DirectNode existing) {
		float d = getResources().getDisplayMetrics().density;
		LinearLayout form = card(d);
		EditText name = labeled(form, "节点名称", "例如 家里电脑 / 公司电脑", d, InputType.TYPE_CLASS_TEXT);
		EditText address = labeled(form, "网关地址", "https://192.168.1.8:18443", d,
			InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
		if (existing != null) {
			name.setText(existing.name);
			address.setText(existing.url);
		}
		tintShell(form);
		AlertDialog.Builder builder = new AlertDialog.Builder(this)
			.setTitle(existing == null ? "添加直连节点" : "编辑直连节点")
			.setView(form).setPositiveButton("保存", null).setNegativeButton("取消", null);
		if (existing != null) builder.setNeutralButton("删除", (dialog, which) -> {
			new AlertDialog.Builder(this).setTitle("删除直连节点")
				.setMessage("删除此节点？不会清除授权，也不会断开当前会话。")
				.setNegativeButton("取消", null)
				.setPositiveButton("删除", (confirm, button) -> {
					ProfileStore.deleteDirect(prefs(), existing.id);
					refreshDirectNodes();
				}).show();
		});
		AlertDialog dialog = builder.create();
		dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
			ProfileStore.DirectNode node = new ProfileStore.DirectNode();
			if (existing != null) node.id = existing.id;
			node.name = name.getText().toString().trim();
			node.url = address.getText().toString().trim();
			if (!node.isValid()) {
				address.setError("请输入有效的 HTTPS 网关地址（不含用户名密码）");
				return;
			}
			if (node.name.isEmpty()) node.name = Uri.parse(node.url).getHost();
			ProfileStore.upsertDirect(prefs(), node);
			refreshDirectNodes();
			dialog.dismiss();
		}));
		dialog.show();
	}

	private void connectDirectNode(ProfileStore.DirectNode node) {
		if (!node.isValid()) {
			showDirectEditor(node);
			return;
		}
		String url = node.url;
		prefs().edit().putString(KEY_URL, url).putString(ProfileStore.KEY_DIRECT_ACTIVE, node.id).apply();
		directTarget = url;
		clearResumeSession();
		openGateway(url);
	}

	// ---------- 编辑配置组（四项与插件面板对齐） ----------

	private void buildEditView() {
		float d = getResources().getDisplayMetrics().density;
		int side = dp(18, d);

		LinearLayout box = new LinearLayout(this);
		box.setOrientation(LinearLayout.VERTICAL);
		box.setPadding(side, dp(8, d), side, dp(28, d));

		Button back = styledButton("← 返回", false, d);
		back.setPadding(dp(14, d), 0, dp(18, d), 0);
		back.setOnClickListener(v -> leaveEditor());
		box.addView(back, new LinearLayout.LayoutParams(
			LinearLayout.LayoutParams.WRAP_CONTENT, dp(40, d)));

		TextView title = new TextView(this);
		title.setText("配置组");
		title.setTextSize(24);
		title.setTypeface(null, android.graphics.Typeface.BOLD);
		title.setPadding(0, dp(12, d), 0, dp(4, d));
		box.addView(title);
		box.addView(hintText("与电脑插件设置相同：VPS、控制端口、隧道名、登录密钥、访客密钥。本地端口由网关固定为 18443，无需填写。", d));

		LinearLayout form = card(d);
		etName = labeled(form, "名称", "例如 家里电脑", d, InputType.TYPE_CLASS_TEXT);
		etServer = labeled(form, "VPS 地址", "与电脑端一致，例如 1.2.3.4", d,
			InputType.TYPE_TEXT_VARIATION_URI);
		etCport = labeled(form, "控制端口", "frps bindPort，通常 7000", d, InputType.TYPE_CLASS_NUMBER);
		etTunnel = labeled(form, "隧道名", "与电脑插件一致，默认 dsh-remote", d, InputType.TYPE_CLASS_TEXT);
		etToken = labeled(form, "登录密钥", "与 VPS frps.toml 的 auth.token 一致", d,
			InputType.TYPE_TEXT_VARIATION_PASSWORD);
		etSk = labeled(form, "访客密钥", "与电脑插件里的访客密钥一致", d,
			InputType.TYPE_TEXT_VARIATION_PASSWORD);
		box.addView(form, cardParams(d));

		Button save = styledButton("保存", true, d);
		save.setOnClickListener(v -> saveEditor());
		LinearLayout.LayoutParams saveParams = new LinearLayout.LayoutParams(
			LinearLayout.LayoutParams.MATCH_PARENT, dp(48, d));
		saveParams.topMargin = dp(16, d);
		box.addView(save, saveParams);

		Button del = styledButton("删除此配置组", false, d);
		del.setOnClickListener(v -> deleteEditingProfile());
		LinearLayout.LayoutParams delParams = new LinearLayout.LayoutParams(
			LinearLayout.LayoutParams.MATCH_PARENT, dp(44, d));
		delParams.topMargin = dp(10, d);
		box.addView(del, delParams);

		setupScroll = insetScroll(box);
		rootLayout.addView(setupScroll,
			new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
	}

	private ScrollView insetScroll(View child) {
		ScrollView scroll = new ScrollView(this);
		scroll.addView(child);
		scroll.setBackgroundColor(0xFFF2F3F6);
		scroll.setVisibility(View.GONE);
		scroll.setOnApplyWindowInsetsListener((view, insets) -> {
			int top;
			int bottom;
			if (Build.VERSION.SDK_INT >= 30) {
				top = insets.getInsets(WindowInsets.Type.statusBars()).top;
				int nav = insets.getInsets(WindowInsets.Type.navigationBars()).bottom;
				// IME 由根布局 translationY 处理；这里只垫导航栏，避免设置页跟着改高度。
				bottom = nav;
			} else {
				top = insets.getSystemWindowInsetTop();
				bottom = insets.getStableInsetBottom();
			}
			float density = getResources().getDisplayMetrics().density;
			view.setPadding(0, top + dp(8, density), 0, bottom);
			return insets;
		});
		return scroll;
	}

	// ---------- 卡片式设置控件（与电脑端插件面板观感对齐） ----------

	private int dp(float value, float d) {
		return Math.round(value * d);
	}

	private LinearLayout card(float d) {
		LinearLayout card = new LinearLayout(this);
		card.setOrientation(LinearLayout.VERTICAL);
		card.setPadding(dp(16, d), dp(14, d), dp(16, d), dp(16, d));
		GradientDrawable background = new GradientDrawable();
		background.setColor(0xFFFFFFFF);
		background.setCornerRadius(14 * d);
		background.setStroke(Math.max(1, dp(1, d)), 0xFFE4E5E9);
		card.setBackground(background);
		return card;
	}

	private LinearLayout.LayoutParams cardParams(float d) {
		LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
			LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
		params.topMargin = dp(12, d);
		return params;
	}

	private TextView cardTitle(String text, float d) {
		TextView t = new TextView(this);
		t.setText(text);
		t.setTextSize(15);
		t.setTypeface(null, android.graphics.Typeface.BOLD);
		t.setPadding(0, 0, 0, dp(6, d));
		return t;
	}

	private Button styledButton(String text, boolean primary, float d) {
		Button button = new Button(this);
		button.setText(text);
		button.setAllCaps(false);
		button.setTextSize(15);
		button.setMinWidth(0);
		button.setMinimumWidth(0);
		button.setMinHeight(0);
		button.setMinimumHeight(0);
		button.setStateListAnimator(null);
		button.setPadding(dp(14, d), 0, dp(14, d), 0);
		GradientDrawable background = new GradientDrawable();
		background.setCornerRadius(10 * d);
		if (primary) {
			background.setColor(0xFF1B66FF);
			button.setTextColor(0xFFFFFFFF);
		} else {
			background.setColor(0xFFFFFFFF);
			background.setStroke(Math.max(1, dp(1, d)), 0xFFD9DBE0);
			button.setTextColor(0xFF1B1B1F);
		}
		button.setBackground(background);
		button.setTag(primary ? "primary-button" : "secondary-button");
		return button;
	}

	private TextView hintText(String text, float d) {
		TextView t = new TextView(this);
		t.setText(text);
		t.setTextSize(13);
		t.setTag("muted");
		t.setLineSpacing(0, 1.25f);
		t.setPadding(0, 0, 0, (int) (10 * d));
		return t;
	}

	private EditText labeled(LinearLayout parent, String label, String hint, float d, int inputType) {
		TextView t = new TextView(this);
		t.setText(label);
		t.setTextSize(13);
		t.setPadding(0, (int) (12 * d), 0, (int) (2 * d));
		parent.addView(t);
		EditText e = new EditText(this);
		e.setHint(hint);
		e.setInputType(inputType);
		e.setSingleLine(true);
		parent.addView(e);
		return e;
	}

	/**
	 * 服务器选择首页（图1），也是启动默认页。只允许：启动、首次无配置、
	 * 停止/清除隧道、以及长按鲸鱼。返回键不得调用本方法。
	 */
	private void showHome() {
		connectionGeneration += 1;
		sessionHistoryRooted = false;
		awaitingCertificateDecision = false;
		dismissPendingHttpAuth();
		clearResumeSession();
		uiState = UiState.HOME;
		activeUrl = "";
		directTarget = "";
		refreshProfileCards();
		refreshDirectNodes();
		if (homeScroll != null) homeScroll.setVisibility(View.VISIBLE);
		if (setupScroll != null) setupScroll.setVisibility(View.GONE);
		if (webView != null) {
			suppressGatewayErrorsBriefly();
			webView.stopLoading();
			webView.setVisibility(View.GONE);
		}
		applySystemBars();
	}

	/**
	 * 从会话长按鲸鱼进入连接设置：不杀隧道、不丢 WebView 页面。
	 * 这是运行中进入图1的唯一入口。
	 */
	private void showConnectionSettings() {
		awaitingCertificateDecision = false;
		dismissPendingHttpAuth();
		boolean fromSession = webView != null
			&& (isSessionUrl(webView.getUrl()) || !TextUtils.isEmpty(activeUrl));
		if (fromSession) {
			if (TextUtils.isEmpty(activeUrl) && isSessionUrl(webView.getUrl())) {
				activeUrl = webView.getUrl();
			}
			resumeUrl = activeUrl;
			canResumeSession = true;
		} else {
			clearResumeSession();
		}
		if (webView != null) webView.setVisibility(View.GONE);
		uiState = UiState.HOME;
		refreshProfileCards();
		refreshDirectNodes();
		if (resumeSessionBtn != null) {
			resumeSessionBtn.setVisibility(canResumeSession ? View.VISIBLE : View.GONE);
		}
		if (tvTunnelState != null && canResumeSession) {
			tvTunnelState.setText("隧道仍在运行。点上方「返回当前会话」或系统返回键继续，无需重新连接。");
		}
		if (homeScroll != null) homeScroll.setVisibility(View.VISIBLE);
		if (setupScroll != null) setupScroll.setVisibility(View.GONE);
		applySystemBars();
	}

	private void clearResumeSession() {
		canResumeSession = false;
		resumeUrl = "";
		if (resumeSessionBtn != null) resumeSessionBtn.setVisibility(View.GONE);
	}

	private void resumeSession() {
		if (!canResumeSession || TextUtils.isEmpty(resumeUrl) || webView == null) {
			clearResumeSession();
			connectFromStoredTarget();
			return;
		}
		final String target = resumeUrl;
		clearResumeSession();
		// 直连不依赖本地 FRP 端口；保留现有文档，不因端口未开而整页重连。
		if (!TextUtils.isEmpty(directTarget)) {
			activeUrl = target;
			uiState = UiState.WEB;
			hideSettings();
			webView.setVisibility(View.VISIBLE);
			if (!isSessionUrl(webView.getUrl())) webView.loadUrl(target);
			applySystemBars();
			applyInsetsToPage(webView);
			injectMobileAdaptation(webView);
			return;
		}
		// AND-06：端口探测走统一线程池，onDestroy 时随线程池一并取消。
		runInBackground("resume-session", () -> {
			// AND-07：隧道可能跑在协商端口上——先探上次记录的实际端口，回落首选端口。
			int savedPort = prefs().getInt(ProfileStore.KEY_BOUND_PORT, ProfileStore.BIND_PORT);
			boolean up = isLocalPortOpen(savedPort)
				|| (savedPort != ProfileStore.BIND_PORT && isLocalPortOpen(ProfileStore.BIND_PORT));
			final boolean ok = up;
			runOnUiThread(() -> {
				if (destroyed) return;
				if (!ok) {
					Toast.makeText(this, "隧道已断开，正在重新连接…", Toast.LENGTH_SHORT).show();
					connectFromStoredTarget();
					return;
				}
				activeUrl = target;
				uiState = UiState.WEB;
				if (homeScroll != null) homeScroll.setVisibility(View.GONE);
				if (setupScroll != null) setupScroll.setVisibility(View.GONE);
				webView.setVisibility(View.VISIBLE);
				String current = webView.getUrl();
				boolean stillOnGateway = current != null && isActiveGatewayUri(Uri.parse(current));
				if (!stillOnGateway) webView.loadUrl(target);
				applyInsetsToPage(webView);
				injectMobileAdaptation(webView);
			});
		});
	}

	private void showEditor(ProfileStore.Profile existing) {
		awaitingCertificateDecision = false;
		dismissPendingHttpAuth();
		uiState = UiState.EDIT;
		if (existing == null) {
			editingProfileId = "";
			etName.setText("");
			etServer.setText("");
			etCport.setText("7000");
			etTunnel.setText(ProfileStore.DEFAULT_TUNNEL_NAME);
			etToken.setText("");
			etSk.setText("");
		} else {
			editingProfileId = existing.id;
			etName.setText(existing.name);
			etServer.setText(existing.serverAddr);
			etCport.setText(existing.serverPort > 0 ? String.valueOf(existing.serverPort) : "7000");
			etTunnel.setText(TextUtils.isEmpty(existing.tunnelName)
				? ProfileStore.DEFAULT_TUNNEL_NAME : existing.tunnelName);
			etToken.setText(existing.authToken);
			etSk.setText(existing.secretKey);
		}
		if (homeScroll != null) homeScroll.setVisibility(View.GONE);
		if (setupScroll != null) setupScroll.setVisibility(View.VISIBLE);
		if (webView != null) webView.setVisibility(View.GONE);
		applySystemBars();
	}

	private void leaveEditor() {
		if (setupScroll != null) setupScroll.setVisibility(View.GONE);
		showConnectionSettings();
	}

	private void saveEditor() {
		ProfileStore.Profile p = TextUtils.isEmpty(editingProfileId)
			? ProfileStore.newProfile()
			: ProfileStore.get(prefs(), editingProfileId);
		if (p == null) p = ProfileStore.newProfile();
		if (!TextUtils.isEmpty(editingProfileId)) p.id = editingProfileId;
		p.name = TextUtils.isEmpty(etName.getText()) ? "" : etName.getText().toString().trim();
		p.serverAddr = TextUtils.isEmpty(etServer.getText()) ? "" : etServer.getText().toString().trim();
		p.serverPort = parseInt(etCport);
		if (p.serverPort <= 0) p.serverPort = 7000;
		p.authToken = TextUtils.isEmpty(etToken.getText()) ? "" : etToken.getText().toString().trim();
		p.secretKey = TextUtils.isEmpty(etSk.getText()) ? "" : etSk.getText().toString().trim();
		String tunnelRaw = TextUtils.isEmpty(etTunnel.getText()) ? "" : etTunnel.getText().toString().trim();
		if (!ProfileStore.isValidTunnelNameInput(tunnelRaw)) {
			Toast.makeText(this, "隧道名须以字母开头，仅含字母数字和 - _，最长 32 位", Toast.LENGTH_LONG).show();
			return;
		}
		p.tunnelName = ProfileStore.normalizeTunnelName(tunnelRaw);
		p.mode = ProfileStore.DEFAULT_MODE;
		if (TextUtils.isEmpty(p.name)) p.name = p.serverAddr;
		if (!p.isValid()) {
			Toast.makeText(this, "请填写完整：VPS 地址、控制端口、登录密钥、访客密钥", Toast.LENGTH_LONG).show();
			return;
		}
		ProfileStore.upsert(prefs(), p);
		editingProfileId = p.id;
		Toast.makeText(this, "已保存", Toast.LENGTH_SHORT).show();
		leaveEditor();
	}

	private void deleteEditingProfile() {
		if (TextUtils.isEmpty(editingProfileId)) {
			leaveEditor();
			return;
		}
		new AlertDialog.Builder(this)
			.setTitle("删除配置组")
			.setMessage("确定删除这个配置组？")
			.setPositiveButton("删除", (d, w) -> {
				ProfileStore.delete(prefs(), editingProfileId);
				leaveEditor();
			})
			.setNegativeButton("取消", null)
			.show();
	}

	private void connectFromStoredTarget() {
		if (!TextUtils.isEmpty(directTarget)) {
			openGateway(directTarget);
			return;
		}
		ProfileStore.Profile active = ProfileStore.getActive(prefs());
		if (active != null && active.isValid()) {
			connectProfile(active);
			return;
		}
		String saved = prefs().getString(KEY_URL, "");
		if (isGatewayUrl(saved)) {
			openGateway(saved);
			return;
		}
		showHome();
	}

	private void connectProfile(ProfileStore.Profile profile) {
		if (profile == null || !profile.isValid()) {
			Toast.makeText(this, "请先填写完整：VPS 地址 / 控制端口 / 登录密钥 / 访客密钥", Toast.LENGTH_LONG).show();
			showEditor(profile);
			return;
		}
		ProfileStore.setActiveId(prefs(), profile.id);
		beginTunnel(profile);
	}

	private boolean handleImportIntent(Intent i) {
		if (i == null || i.getData() == null) return false;
		Uri data = i.getData();
		if (!"dsh-remote".equals(data.getScheme()) || !"visitor".equals(data.getHost())) return false;
		VisitorConfig c = VisitorConfig.parse(data.toString());
		if (c == null) {
			Toast.makeText(this, "无法识别的导入链接", Toast.LENGTH_LONG).show();
			showHome();
			return true;
		}
		ProfileStore.Profile p = ProfileStore.newProfile();
		p.name = c.serverAddr;
		p.serverAddr = c.serverAddr;
		p.serverPort = c.serverPort;
		p.authToken = c.authToken;
		p.secretKey = c.secretKey;
		p.mode = ProfileStore.DEFAULT_MODE;
		p.tunnelName = ProfileStore.normalizeTunnelName(c.serverName);
		ProfileStore.upsert(prefs(), p);
		ProfileStore.setActiveId(prefs(), p.id);
		beginTunnel(p);
		return true;
	}

	private void showLocalShell(UiState nextState, String state, String title, String message,
			String primaryHref, String primaryLabel, String secondaryHref, String secondaryLabel) {
		activeUrl = "";
		awaitingCertificateDecision = false;
		dismissPendingHttpAuth();
		uiState = nextState;
		pageDark = isSystemDark();
		edgeToEdgeChrome = true;
		webView.setBackgroundColor(shellColor(R.color.shell_background));
		applySystemBars();
		if (homeScroll != null) homeScroll.setVisibility(View.GONE);
		if (setupScroll != null) setupScroll.setVisibility(View.GONE);
		suppressGatewayErrorsBriefly();
		webView.stopLoading();
		webView.setVisibility(View.VISIBLE);
		String html = readRawText(R.raw.mobile_shell)
			.replace("{{STATE}}", state)
			.replace("{{TITLE}}", title)
			.replace("{{MESSAGE}}", message)
			.replace("{{PRIMARY_HREF}}", primaryHref)
			.replace("{{PRIMARY_LABEL}}", primaryLabel)
			.replace("{{SECONDARY_HREF}}", secondaryHref)
			.replace("{{SECONDARY_LABEL}}", secondaryLabel);
		webView.loadDataWithBaseURL("https://dsh-remote.local/", html, "text/html", "utf-8", null);
		webView.clearHistory();
	}

	private String readRawText(int resourceId) {
		StringBuilder out = new StringBuilder();
		try (InputStream stream = getResources().openRawResource(resourceId);
			 BufferedReader reader = new BufferedReader(new InputStreamReader(stream, "UTF-8"))) {
			String line;
			while ((line = reader.readLine()) != null) out.append(line).append('\n');
		} catch (IOException error) {
			return "<!doctype html><title>DSH Remote</title><p>连接状态不可用。</p>";
		}
		return out.toString();
	}

	private boolean isGatewayUrl(String url) {
		return url != null && (url.startsWith("https://") || url.startsWith("http://")) && url.length() >= 10;
	}

	// ---------- 隧道模式 ----------

	private void beginTunnel(final ProfileStore.Profile profile) {
		directTarget = "";
		clearResumeSession();
		final int generation = ++connectionGeneration;
		final VisitorConfig cfg = profile.toVisitorConfig();
		if (!cfg.isValid()) {
			Toast.makeText(this, "连接配置不完整，请检查配置组。", Toast.LENGTH_LONG).show();
			showHome();
			return;
		}
		if (Build.VERSION.SDK_INT >= 33
			&& checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
			requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIF_PERM);
		}
		if (tvTunnelState != null) tvTunnelState.setText("正在检测隧道状态…");
		// AND-07/AND-06：端口探测与协商必须在后台线程做——主线程 socket connect
		// 会抛 NetworkOnMainThreadException 并被 isLocalPortOpen 吞掉（探测恒
		// false，复用逻辑整段失效：每次重连都杀掉存活隧道换端口重启），且 400ms
		// 超时本身也会阻塞主线程。结论统一回到 UI 线程后按 generation 过期丢弃。
		runInBackground("tunnel-probe", () -> {
			// 只复用「确实为这个配置组起的」存活隧道：端口存活不代表就是本次要连的
			// server——启动改为手选后，换配置组连接是常规路径，错复用会连到旧 server。
			String tunnelProfile = prefs().getString(ProfileStore.KEY_TUNNEL_PROFILE, "");
			int savedPort = prefs().getInt(ProfileStore.KEY_BOUND_PORT, 0);
			int reusePort = 0;
			if (profile.id.equals(tunnelProfile)) {
				if (savedPort >= 1 && savedPort <= 65535 && isLocalPortOpen(savedPort)) reusePort = savedPort;
				else if (isLocalPortOpen(ProfileStore.BIND_PORT)) reusePort = ProfileStore.BIND_PORT;
			}
			// AND-07：复用存活隧道——先探上次记录的实际绑定端口，再探首选端口。
			final int reused = reusePort;
			// AND-07：端口协商——首选 BIND_PORT，被占用时在 16225~16235 取首个空闲端口；
			// 实际端口传给 frpc visitor（Intent extra）与 WebView 加载 URL（cfg.bindPort）。
			final int negotiated = reused > 0 ? reused : ProfileStore.negotiateBindPort();
			runOnUiThread(() -> {
				if (destroyed) return;
				if (generation != connectionGeneration) return;
				if (reused > 0) {
					cfg.bindPort = reused;
					String target = "https://127.0.0.1:" + reused + "/";
					if (tvTunnelState != null) tvTunnelState.setText("隧道已在运行，正在打开会话…");
					if (resumeLiveSession(target)) return;
					openGateway(target);
					return;
				}
				if (negotiated < 0) {
					Toast.makeText(MainActivity.this, "本地端口 " + ProfileStore.BIND_PORT + " 与回退范围 "
						+ ProfileStore.PORT_RANGE_MIN + "-" + ProfileStore.PORT_RANGE_MAX
						+ " 均被占用，无法启动隧道。", Toast.LENGTH_LONG).show();
					showHome();
					return;
				}
				int port = negotiated;
				cfg.bindPort = port;
				prefs().edit().putInt(ProfileStore.KEY_BOUND_PORT, port).apply();
				Intent svc = new Intent(MainActivity.this, TunnelService.class);
				svc.putExtra(TunnelService.EXTRA_BIND_PORT, port);
				if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc);
				else startService(svc);
				if (tvTunnelState != null) {
					tvTunnelState.setText("隧道启动中（frpc 打洞/建联一般 3~10 秒）…"
						+ (port == ProfileStore.BIND_PORT ? "" : "（端口 " + port + "）"));
				}
				showLocalShell(
					UiState.CONNECTING,
					"connecting",
					"正在连接 DSH",
					"正在建立安全隧道。",
					"dsh-remote://app/retry",
					"重新连接",
					"",
					""
				);
				waitAndOpen(cfg, generation);
			});
		});
	}

	private void waitAndOpen(final VisitorConfig cfg, final int generation) {
		final long deadline = System.currentTimeMillis() + TUNNEL_READY_TIMEOUT_MS;
		// AND-06：就绪轮询走统一线程池；onDestroy 的 shutdownNow() 会中断该轮询。
		runInBackground("tunnel-wait", () -> {
			boolean up = false;
			while (!destroyed && System.currentTimeMillis() < deadline) {
				if (Thread.currentThread().isInterrupted()) break;
				try {
					Socket s = new Socket();
					s.connect(new InetSocketAddress("127.0.0.1", cfg.bindPort), 600);
					s.close();
					up = true;
					break;
				} catch (IOException ignored) {
				}
				try {
					Thread.sleep(400);
				} catch (InterruptedException e) {
					Thread.currentThread().interrupt();
					break;
				}
			}
			final boolean ok = up;
			runOnUiThread(() -> {
				if (destroyed) return;
				if (generation != connectionGeneration || uiState != UiState.CONNECTING) return;
				if (!ok) {
					if (tvTunnelState != null) {
						tvTunnelState.setText("隧道未就绪：检查电脑网关、密钥和 frps 网络。");
					}
					showLocalShell(
						UiState.CONNECTING,
						"failed",
						"无法连接 DSH",
						"隧道未在 20 秒内就绪。请检查电脑网关、密钥和 frps 网络后重试。",
						"dsh-remote://app/retry",
						"重新连接",
						"dsh-remote://app/home",
						"返回服务器列表"
					);
					return;
				}
				// 二维码携带的指纹在首连前预置：免 TOFU 弹窗，直接锁定。
				if (cfg.fingerprint.length() == 64) {
					prefs().edit()
						.putString(KEY_CERT_PREFIX + "127.0.0.1:" + cfg.bindPort, cfg.fingerprint)
						.apply();
				}
				openGateway("https://127.0.0.1:" + cfg.bindPort + "/");
			});
		});
	}

	/**
	 * AND-06：提交后台探测/轮询任务到统一线程池（替换裸 new Thread）。
	 * Activity 销毁后静默丢弃；任务内异常只记日志，不上抛崩线程池。
	 */
	private void runInBackground(String name, Runnable work) {
		if (destroyed) return;
		try {
			bgExecutor.execute(() -> {
				Thread.currentThread().setName(name);
				try {
					work.run();
				} catch (Exception e) {
					Log.w("dshr-main", "后台任务 " + name + " 异常：" + e);
				}
			});
		} catch (RejectedExecutionException ignored) {
			// onDestroy 已 shutdownNow()，过期任务静默丢弃。
		}
	}

	private void stopTunnel() {
		connectionGeneration += 1;
		stopService(new Intent(this, TunnelService.class));
		if (tvTunnelState != null) tvTunnelState.setText("隧道已停止");
		showHome();
	}

	// ---------- 直连模式 ----------

	private void openGateway(String url) {
		connectionGeneration += 1;
		sessionHistoryRooted = false;
		submittedHttpAuthThisConnection.clear();
		final String target = url.trim();
		showLocalShell(
			UiState.CONNECTING,
			"connecting",
			"正在连接 DSH",
			"正在验证网关和设备授权。",
			"dsh-remote://app/retry",
			"重新连接",
			"",
			""
		);
		activeUrl = target;
		webView.post(() -> {
			if (uiState == UiState.CONNECTING && target.equals(activeUrl)) webView.loadUrl(target);
		});
	}

	private SharedPreferences prefs() {
		return getSharedPreferences(PREFS, MODE_PRIVATE);
	}

	// ---------- WebView ----------

	private void ensureWebView() {
		if (webView != null) return;
		// DayNight 包装让 WebView 的 prefers-color-scheme 跟随系统。
		Context webCtx = this;
		if (Build.VERSION.SDK_INT >= 29) {
			webCtx = new ContextThemeWrapper(this, android.R.style.Theme_DeviceDefault_DayNight);
		}
		webView = new WebView(webCtx);
		webView.setBackgroundColor(shellColor(R.color.shell_background));
		WebSettings s = webView.getSettings();
		s.setJavaScriptEnabled(true);
		s.setDomStorageEnabled(true);
		s.setUseWideViewPort(true);
		s.setLoadWithOverviewMode(false);
		s.setTextZoom(100);
		s.setLayoutAlgorithm(WebSettings.LayoutAlgorithm.NORMAL);
		s.setAllowFileAccess(false);
		s.setAllowFileAccessFromFileURLs(false);
		s.setAllowUniversalAccessFromFileURLs(false);
		if (Build.VERSION.SDK_INT >= 33) {
			s.setAlgorithmicDarkeningAllowed(false);
		} else if (Build.VERSION.SDK_INT >= 29) {
			s.setForceDark(WebSettings.FORCE_DARK_OFF);
		}
		String userAgent = s.getUserAgentString();
		if (userAgent == null || !userAgent.contains(MOBILE_UA_TOKEN.trim())) {
			s.setUserAgentString((userAgent == null ? "" : userAgent) + MOBILE_UA_TOKEN);
		}
		webView.addJavascriptInterface(new AppBridge(), "DshRemoteApp");
		webView.setOnKeyListener((v, keyCode, event) -> {
			if (keyCode != KeyEvent.KEYCODE_BACK) return false;
			// 必须在 ACTION_DOWN 就吃掉，否则 WebView 会自己 goBack 到连接壳并触发断线误报。
			if (event.getAction() == KeyEvent.ACTION_UP) handleAppBack();
			return true;
		});
		webView.setVisibility(View.GONE);
		webView.setWebViewClient(new WebViewClient() {
			@Override
			public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
				Uri uri = request.getUrl();
				if (handleAppAction(uri)) return true;
				String scheme = uri.getScheme();
				boolean web = "http".equals(scheme) || "https".equals(scheme);
				if (web) return false;
				if ("dsh-remote".equals(scheme)) return true;
				try {
					startActivity(new Intent(Intent.ACTION_VIEW, uri));
				} catch (ActivityNotFoundException ignored) {
				}
				return true;
			}

			@Override
			public void onPageFinished(WebView view, String url) {
				enterSessionPage(view, url);
				applyInsetsToPage(view);
			}

			@Override
			public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
				enterSessionPage(view, url);
			}

			@Override
			public void onPageCommitVisible(WebView view, String url) {
				if (Build.VERSION.SDK_INT >= 23) enterSessionPage(view, url);
			}

			@Override
			public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
				if (suppressGatewayErrors || awaitingCertificateDecision) return;
				if (request == null || !request.isForMainFrame()) return;
				if (isIgnorableWebError(error)) return;
				if (isActiveGatewayUri(request.getUrl())) {
					showGatewayFailure("网络连接中断，请确认网关和隧道仍在运行。");
				}
			}

			@Override
			public void onReceivedHttpError(WebView view, WebResourceRequest request,
					WebResourceResponse response) {
				if (suppressGatewayErrors || request == null || !request.isForMainFrame()) return;
				if (response.getStatusCode() >= 500 && isActiveGatewayUri(request.getUrl())) {
					showGatewayFailure("网关已连接，但电脑上的 DSH Web 暂时不可用。");
				}
			}

			@Override
			public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler,
					String host, String realm) {
				handleHttpAuthRequest(handler, host, realm);
			}

			@Override
			public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
				handleSslError(handler, error);
			}
		});
		webView.setWebChromeClient(new WebChromeClient() {
			@Override
			public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
											 FileChooserParams params) {
				if (fileCallback != null) fileCallback.onReceiveValue(null);
				fileCallback = callback;
				try {
					startActivityForResult(params.createIntent(), REQ_FILE_CHOOSER);
					return true;
				} catch (ActivityNotFoundException e) {
					fileCallback = null;
					return false;
				}
			}
		});
		webView.setDownloadListener((url, ua, contentDisposition, mime, length) -> {
			try {
				DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
				r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
				r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
					"dsh-remote-" + System.currentTimeMillis());
				Object svc = getSystemService(Context.DOWNLOAD_SERVICE);
				((DownloadManager) svc).enqueue(r);
				Toast.makeText(this, "已开始下载", Toast.LENGTH_SHORT).show();
			} catch (Exception e) {
				Toast.makeText(this, "下载失败：" + e.getMessage(), Toast.LENGTH_SHORT).show();
			}
		});
		rootLayout.addView(webView,
			new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
	}

	/**
	 * Edge-to-edge 下窗口不随键盘缩小。用 translationY 把页面抬到键盘上方，
	 * 不改 WebView 布局高度，避免 100vh/垂直居中重排和字体抖动。
	 * 平移量按焦点输入框位置计算：已经在键盘上方就不动，不够才抬，且不得顶出状态栏。
	 */
	private void installImeInsetHandling() {
		if (rootLayout == null) return;
		rootLayout.setFitsSystemWindows(false);
		rootLayout.setOnApplyWindowInsetsListener((view, insets) -> {
			applyImeShift(imeBottomPx(insets));
			// 导航模式 / 平板任务栏变化未必触发页面加载或焦点事件。
			// 下一帧读取最新 root insets；IME 动画中不注入 JS，避免重排。
			if (!imeAnimating && webView != null) {
				webView.post(() -> { if (!destroyed && !imeAnimating) applyInsetsToPage(webView); });
			}
			if (Build.VERSION.SDK_INT >= 30) {
				return new WindowInsets.Builder(insets)
					.setInsets(WindowInsets.Type.ime(), Insets.NONE)
					.build();
			}
			return insets;
		});
		if (Build.VERSION.SDK_INT >= 30) installImeAnimationCallback();
		rootLayout.getViewTreeObserver().addOnGlobalLayoutListener(this::syncImeFromVisibleFrame);
		rootLayout.requestApplyInsets();
	}

	private void installImeAnimationCallback() {
		rootLayout.setWindowInsetsAnimationCallback(new WindowInsetsAnimation.Callback(
			WindowInsetsAnimation.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
			@Override
			public void onPrepare(WindowInsetsAnimation animation) {
				if ((animation.getTypeMask() & WindowInsets.Type.ime()) != 0) {
					imeAnimating = true;
				}
			}

			@Override
			public WindowInsets onProgress(WindowInsets insets, List<WindowInsetsAnimation> runningAnimations) {
				applyImeShift(imeBottomPx(insets));
				return insets;
			}

			@Override
			public void onEnd(WindowInsetsAnimation animation) {
				if ((animation.getTypeMask() & WindowInsets.Type.ime()) == 0) return;
				imeAnimating = false;
				WindowInsets insets = rootLayout.getRootWindowInsets();
				applyImeShift(insets == null ? 0 : imeBottomPx(insets));
			}
		});
	}

	private int imeBottomPx(WindowInsets insets) {
		if (insets == null) return 0;
		if (Build.VERSION.SDK_INT >= 30) return insets.getInsets(WindowInsets.Type.ime()).bottom;
		return 0;
	}

	/** API 30+：按焦点位置平移。更旧系统走 adjustResize，不再叠加平移。 */
	private void applyImeShift(int imePx) {
		if (rootLayout == null) return;
		if (Build.VERSION.SDK_INT < 30) return;
		if (imePx < 0) imePx = 0;
		int shift = computeImeShift(imePx);
		if (imePx == currentImePadding && shift == currentImeShift) return;
		currentImePadding = imePx;
		currentImeShift = shift;
		if (rootLayout.getPaddingBottom() != 0 || rootLayout.getPaddingTop() != 0) {
			rootLayout.setPadding(0, 0, 0, 0);
		}
		rootLayout.setTranslationY(-shift);
	}

	/**
	 * 只抬到让焦点输入框露在键盘上方。空会话/设置页元素少时，整页抬满 IME
	 * 高度会把输入框顶出屏幕。
	 */
	private int computeImeShift(int imePx) {
		if (imePx <= 0 || rootLayout == null) return 0;
		int rootH = rootLayout.getHeight();
		if (rootH <= 0) rootH = getWindow().getDecorView().getHeight();
		if (rootH <= 0) return 0;
		int keyboardTop = rootH - imePx;
		float density = getResources().getDisplayMetrics().density;
		int pad = dp(12, density);
		int insetTop = 0;
		if (Build.VERSION.SDK_INT >= 30) {
			WindowInsets insets = rootLayout.getRootWindowInsets();
			if (insets != null) insetTop = insets.getInsets(WindowInsets.Type.statusBars()).top;
		}
		int[] rootLoc = new int[2];
		rootLayout.getLocationOnScreen(rootLoc);
		int fieldTop = -1;
		int fieldBottom = -1;
		if (uiState == UiState.WEB && webView != null && lastImeFocusBottomPx >= 0) {
			int[] webLoc = new int[2];
			webView.getLocationOnScreen(webLoc);
			fieldTop = (webLoc[1] - rootLoc[1]) + lastImeFocusTopPx;
			fieldBottom = (webLoc[1] - rootLoc[1]) + lastImeFocusBottomPx;
		} else {
			View focused = getCurrentFocus();
			if (focused == null || focused == rootLayout || focused == webView) return 0;
			int[] loc = new int[2];
			focused.getLocationOnScreen(loc);
			fieldTop = loc[1] - rootLoc[1];
			fieldBottom = fieldTop + Math.max(focused.getHeight(), dp(36, density));
		}
		if (fieldBottom < 0 || fieldTop < 0) return 0;
		int needed = fieldBottom + pad - keyboardTop;
		if (needed <= 0) return 0;
		int maxKeep = Math.max(0, fieldTop - insetTop - pad);
		if (maxKeep <= 0) return 0;
		return Math.min(imePx, Math.min(needed, maxKeep));
	}

	/** 部分 OEM WebView 不派发 IME inset：用可见区域差兜底。 */
	private void syncImeFromVisibleFrame() {
		if (imeAnimating || Build.VERSION.SDK_INT < 30) return;
		View decor = getWindow().getDecorView();
		Rect visible = new Rect();
		decor.getWindowVisibleDisplayFrame(visible);
		int covered = Math.max(0, decor.getHeight() - visible.bottom);
		int nav = 0;
		int ime = 0;
		WindowInsets insets = decor.getRootWindowInsets();
		if (insets != null) {
			nav = insets.getInsets(WindowInsets.Type.navigationBars()).bottom;
			ime = insets.getInsets(WindowInsets.Type.ime()).bottom;
		}
		float density = getResources().getDisplayMetrics().density;
		int guessed = covered > nav + dp(64, density) ? covered : 0;
		int next = Math.max(ime, guessed);
		int hysteresis = dp(IME_PAD_HYSTERESIS_DP, density);
		if (currentImePadding >= 0) {
			int delta = Math.abs(next - currentImePadding);
			boolean stayingClosed = currentImePadding == 0 && next <= hysteresis;
			boolean stayingOpen = currentImePadding > hysteresis && next > hysteresis && delta < hysteresis;
			if (stayingClosed || stayingOpen) return;
		}
		applyImeShift(next);
	}

	/**
	 * 把状态栏/导航栏 inset 换算成 CSS 像素写入页面（--dshr-inset-top / --dshr-inset-bottom）。
	 * 远端 DSH 页面由注入的 mobile.js 消费，本地壳页面自带同名接收端。
	 * 状态栏透明（edge-to-edge）后页面内容下移让出系统栏、背景延伸到栏后，
	 * 状态栏颜色与页面一致，实现安卓默认沉浸效果。
	 * 键盘用 translationY 抬起整页，WebView 高度不变，CSS 底 inset 始终按导航栏，
	 * 不要随 IME 清零，否则会再触发一次页面重排。
	 */
	private void applyInsetsToPage(WebView view) {
		if (view == null) return;
		WindowInsets insets = getWindow().getDecorView().getRootWindowInsets();
		if (insets == null) return;
		int topPx;
		int bottomPx;
		if (Build.VERSION.SDK_INT >= 30) {
			topPx = insets.getInsets(WindowInsets.Type.statusBars()).top;
			bottomPx = insets.getInsets(WindowInsets.Type.navigationBars()).bottom;
		} else {
			topPx = insets.getSystemWindowInsetTop();
			bottomPx = insets.getStableInsetBottom();
		}
		float density = getResources().getDisplayMetrics().density;
		int top = Math.round(topPx / density);
		int bottom = Math.round(bottomPx / density);
		view.evaluateJavascript(
			"(function(){var s=window.__dshRemoteInsets;if(s&&typeof s.set==='function')s.set(" + top + "," + bottom + ");})()",
			null);
	}

	private String readMobileAdaptJs() {
		if (mobileAdaptJs == null) mobileAdaptJs = readRawText(R.raw.mobile);
		return mobileAdaptJs;
	}

	private void injectMobileAdaptation(WebView view) {
		view.evaluateJavascript(readMobileAdaptJs(), null);
	}

	/**
	 * 注入自检：页面加载数秒后确认适配脚本确实在页面里运行。
	 * 若脚本始终缺失（evaluateJavascript 丢失、极端 WebView 环境），
	 * 退回实色状态栏模式——内容整体位于状态栏下方，绝不与系统栏重叠；
	 * 脚本正常时保持透明状态栏沉浸模式。
	 */
	private void scheduleAdaptationProbe(WebView view) {
		view.postDelayed(() -> {
			if (uiState != UiState.WEB || view.getVisibility() != View.VISIBLE) return;
			view.evaluateJavascript("String(window.__dshRemoteMobileInstalled===true)", value -> {
				boolean injected = value != null && value.contains("true");
				applySystemBarMode(injected);
				if (!injected) {
					// 最后再补一次注入机会，成功后自动恢复沉浸模式。
					injectMobileAdaptation(view);
					applyInsetsToPage(view);
					view.postDelayed(() -> {
						if (uiState != UiState.WEB) return;
						view.evaluateJavascript("String(window.__dshRemoteMobileInstalled===true)", retry -> {
							if (retry != null && retry.contains("true")) applySystemBarMode(true);
						});
					}, 2000);
				}
			});
		}, 6000);
	}

	@Override
	public void onConfigurationChanged(Configuration newConfig) {
		super.onConfigurationChanged(newConfig);
		// Activity 声明了 configChanges=uiMode，不重建。必须把新配置派发给
		// WebView，prefers-color-scheme / 「跟随系统」才会跟着系统深浅变。
		if (rootLayout != null) rootLayout.dispatchConfigurationChanged(newConfig);
		else if (webView != null) webView.dispatchConfigurationChanged(newConfig);
		if (uiState != UiState.WEB && webView != null) {
			pageDark = isSystemDark();
			webView.setBackgroundColor(shellColor(R.color.shell_background));
		}
		applySystemBars();
		if (webView != null && uiState == UiState.WEB) {
			applyInsetsToPage(webView);
			webView.evaluateJavascript(
				"(function(){var a=window.__dshRemoteAndroidMobile;if(a&&a.syncViewport)a.syncViewport();})()",
				null);
		}
	}

	/** edgeToEdge=true：透明状态栏沉浸；false：实色状态栏、内容排在状态栏下方。 */
	private void applySystemBarMode(boolean edgeToEdge) {
		edgeToEdgeChrome = edgeToEdge;
		applySystemBars();
	}

	private void applyPageDark(boolean dark) {
		pageDark = dark;
		if (webView != null) webView.setBackgroundColor(uiState == UiState.WEB
			? (dark ? 0xFF141414 : Color.WHITE) : shellColor(R.color.shell_background));
		applySystemBars();
	}

	private void applySystemBars() {
		boolean session = uiState == UiState.WEB;
		boolean dark = session ? pageDark : isSystemDark();
		boolean edge = !session || edgeToEdgeChrome;
		if (rootLayout != null) rootLayout.setBackgroundColor(session
			? (dark ? 0xFF141414 : Color.WHITE) : shellColor(R.color.shell_background));
		if (!session) {
			tintShell(homeScroll);
			tintShell(setupScroll);
		}
		// 只在适配已启用的会话中透明：各列 CSS inset 留空间，背景画到手势条下。
		int nav = edge ? Color.TRANSPARENT : (dark ? 0xFF141414 : Color.WHITE);
		WindowManager.LayoutParams attrs = getWindow().getAttributes();
		View decor = getWindow().getDecorView();
		int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
		getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
		getWindow().clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
		if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
		if (Build.VERSION.SDK_INT >= 29) {
			getWindow().setStatusBarContrastEnforced(false);
			getWindow().setNavigationBarContrastEnforced(false);
		}
		if (edge) {
			getWindow().setStatusBarColor(Color.TRANSPARENT);
			flags |= View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
			if (Build.VERSION.SDK_INT >= 28) {
				attrs.layoutInDisplayCutoutMode =
					WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
			}
		} else {
			getWindow().setStatusBarColor(dark ? 0xFF141414 : Color.WHITE);
			if (Build.VERSION.SDK_INT >= 28) {
				attrs.layoutInDisplayCutoutMode =
					WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
			}
		}
		if (!dark) {
			flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
			if (Build.VERSION.SDK_INT >= 26) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
		}
		getWindow().setNavigationBarColor(nav);
		if (Build.VERSION.SDK_INT >= 28) getWindow().setNavigationBarDividerColor(nav);
		getWindow().setAttributes(attrs);
		decor.setSystemUiVisibility(flags);
		if (Build.VERSION.SDK_INT >= 30) {
			android.view.WindowInsetsController controller = getWindow().getInsetsController();
			if (controller != null) {
				int mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
					| android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
				controller.setSystemBarsAppearance(dark ? 0 : mask, mask);
			}
		}
	}

	private void hideSettings() {
		if (homeScroll != null) homeScroll.setVisibility(View.GONE);
		if (setupScroll != null) setupScroll.setVisibility(View.GONE);
	}

	private boolean isLocalShellUrl(String url) {
		if (TextUtils.isEmpty(url)) return true;
		String u = url.toLowerCase(Locale.US);
		return u.startsWith("https://dsh-remote.local")
			|| u.startsWith("http://dsh-remote.local")
			|| u.startsWith("data:")
			|| u.startsWith("about:");
	}

	private boolean isSessionUrl(String url) {
		if (isLocalShellUrl(url)) return false;
		try {
			Uri uri = Uri.parse(url);
			String scheme = uri.getScheme();
			return "http".equals(scheme) || "https".equals(scheme);
		} catch (Exception ignored) {
			return false;
		}
	}

	/**
	 * 任意非本地壳的 http(s) 主文档都视为会话页：注入移动适配并标成 WEB。
	 * 这样网关跳转/Host 改写后也不会落成官方桌面栏。
	 * 用户正在看连接设置时只更新状态、不抢回前台。
	 */
	private void enterSessionPage(WebView view, String url) {
		if (view == null || !isSessionUrl(url)) return;
		activeUrl = url;
		injectMobileAdaptation(view);
		if (uiState == UiState.HOME || uiState == UiState.EDIT) return;
		boolean alreadyInSession = uiState == UiState.WEB && sessionHistoryRooted;
		hideSettings();
		uiState = UiState.WEB;
		applySystemBars();
		if (webView != null && webView.getVisibility() != View.VISIBLE) {
			webView.setVisibility(View.VISIBLE);
		}
		if (alreadyInSession) {
			applyInsetsToPage(view);
			return;
		}
		if (!sessionHistoryRooted) {
			sessionHistoryRooted = true;
			view.clearHistory();
		}
		if (tvTunnelState != null) tvTunnelState.setText("隧道运行中");
		view.postDelayed(() -> {
			if (uiState == UiState.WEB) injectMobileAdaptation(view);
		}, 1500);
		view.postDelayed(() -> {
			if (uiState == UiState.WEB) injectMobileAdaptation(view);
		}, 4000);
		scheduleAdaptationProbe(view);
		applyInsetsToPage(view);
	}

	/** 隧道仍在、WebView 还留着会话文档时，直接露出会话并补注入，禁止整页重载成官方栏。 */
	private boolean resumeLiveSession(String target) {
		if (webView == null || !isSessionUrl(webView.getUrl())) return false;
		hideSettings();
		clearResumeSession();
		activeUrl = target;
		uiState = UiState.WEB;
		applySystemBars();
		webView.setVisibility(View.VISIBLE);
		injectMobileAdaptation(webView);
		applyInsetsToPage(webView);
		scheduleAdaptationProbe(webView);
		if (tvTunnelState != null) tvTunnelState.setText("隧道运行中");
		return true;
	}

	private boolean handleAppAction(Uri uri) {
		if (!"dsh-remote".equals(uri.getScheme()) || !"app".equals(uri.getHost())) return false;
		String path = uri.getPath();
		if ("/settings".equals(path)) {
			showConnectionSettings();
			return true;
		}
		if ("/retry".equals(path)) {
			connectFromStoredTarget();
			return true;
		}
		if ("/home".equals(path)) {
			showHome();
			return true;
		}
		if ("/disconnect".equals(path)) {
			stopTunnel();
			return true;
		}
		if ("/clear".equals(path)) {
			clearDeviceData();
			return true;
		}
		return true;
	}

	private void suppressGatewayErrorsBriefly() {
		suppressGatewayErrors = true;
		final int epoch = ++suppressGatewayEpoch;
		if (webView != null) {
			webView.postDelayed(() -> {
				if (epoch == suppressGatewayEpoch) suppressGatewayErrors = false;
			}, 1200);
		} else {
			suppressGatewayErrors = false;
		}
	}

	private boolean isIgnorableWebError(WebResourceError error) {
		if (error == null) return true;
		int code = error.getErrorCode();
		CharSequence desc = error.getDescription();
		String text = desc == null ? "" : desc.toString();
		if (text.contains("ERR_ABORTED") || text.contains("ERR_CACHE_MISS")) return true;
		if (code == WebViewClient.ERROR_UNKNOWN && (text.length() == 0 || text.contains("ERR_ABORTED"))) {
			return true;
		}
		return false;
	}

	private boolean isLocalPortOpen(int port) {
		Socket socket = null;
		try {
			socket = new Socket();
			socket.connect(new InetSocketAddress("127.0.0.1", port), 400);
			return true;
		} catch (Exception ignored) {
			return false;
		} finally {
			if (socket != null) {
				try {
					socket.close();
				} catch (IOException ignored) {
				}
			}
		}
	}

	private boolean isActiveGatewayUri(Uri uri) {
		if (TextUtils.isEmpty(activeUrl) || uri == null) return false;
		try {
			Uri base = Uri.parse(activeUrl);
			String scheme = uri.getScheme();
			boolean web = "http".equals(scheme) || "https".equals(scheme);
			return web && TextUtils.equals(base.getHost(), uri.getHost())
				&& effectivePort(base) == effectivePort(uri);
		} catch (Exception ignored) {
			return false;
		}
	}

	private boolean isActiveHttpsGatewayHost(String host) {
		if (TextUtils.isEmpty(activeUrl) || TextUtils.isEmpty(host)) return false;
		try {
			Uri target = Uri.parse(activeUrl);
			return "https".equalsIgnoreCase(target.getScheme())
				&& target.getHost() != null
				&& target.getHost().equalsIgnoreCase(host);
		} catch (Exception ignored) {
			return false;
		}
	}

	private void handleHttpAuthRequest(final HttpAuthHandler handler, String host, String realm) {
		// Basic Auth 仅允许用于当前的 HTTPS 网关；不向嵌入的跨站资源泄露凭据。
		if (!isActiveHttpsGatewayHost(host)) {
			handler.cancel();
			return;
		}
		if (httpAuthDialog != null && httpAuthDialog.isShowing()) {
			handler.cancel();
			return;
		}

		final String authHost = host == null ? "" : host.trim();
		final String authRealm = realm == null ? "" : realm;
		final String authKey = httpAuthPreferenceKey(authHost, authRealm);
		SharedPreferences authPrefs = prefs();
		final boolean rememberDefault = !authPrefs.contains(authKey)
			|| authPrefs.getBoolean(authKey, false);
		String[] saved = null;
		if (rememberDefault && webView != null) {
			saved = webView.getHttpAuthUsernamePassword(authHost, authRealm);
		}
		boolean hasSaved = saved != null && saved.length >= 2
			&& !TextUtils.isEmpty(saved[0]) && saved[1] != null;
		if (hasSaved && !submittedHttpAuthThisConnection.contains(authKey)) {
			// App 重启或重新连接后自动提交一次。若服务器再次挑战同一 realm，
			// 说明凭据失效，下面会清掉该条并回到人工输入，绝不循环提交。
			submittedHttpAuthThisConnection.add(authKey);
			lastHttpAuthHost = authHost;
			lastHttpAuthUser = saved[0];
			handler.proceed(saved[0], saved[1]);
			return;
		}
		if (hasSaved) {
			lastHttpAuthHost = authHost;
			lastHttpAuthUser = saved[0];
			// WebViewDatabase 没有按 host+realm 删除的公开 API；覆盖为空值，
			// 同时保留“记住”选择，用户修正后会写入新凭据。
			webView.setHttpAuthUsernamePassword(authHost, authRealm, "", "");
		}

		float d = getResources().getDisplayMetrics().density;
		int pad = (int) (20 * d);
		LinearLayout form = new LinearLayout(this);
		form.setOrientation(LinearLayout.VERTICAL);
		form.setPadding(pad, (int) (4 * d), pad, 0);

		TextView note = new TextView(this);
		String protectedRealm = TextUtils.isEmpty(authRealm) ? "默认认证域" : authRealm;
		note.setText("此网关启用了 HTTP Basic Auth。\n" + authHost + " · " + protectedRealm);
		note.setTextSize(13);
		note.setLineSpacing(0, 1.25f);
		note.setPadding(0, 0, 0, (int) (14 * d));
		form.addView(note);

		final EditText username = new EditText(this);
		username.setHint("用户名");
		username.setSingleLine(true);
		username.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
		if (authHost.equalsIgnoreCase(lastHttpAuthHost)) username.setText(lastHttpAuthUser);
		form.addView(username, new LinearLayout.LayoutParams(
			LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

		final EditText password = new EditText(this);
		password.setHint("密码");
		password.setSingleLine(true);
		password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
		password.setImeOptions(EditorInfo.IME_ACTION_DONE);
		form.addView(password, new LinearLayout.LayoutParams(
			LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

		final CheckBox remember = new CheckBox(this);
		remember.setText("记住此网关的认证信息");
		remember.setChecked(rememberDefault);
		form.addView(remember, new LinearLayout.LayoutParams(
			LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

		TextView storageNote = new TextView(this);
		storageNote.setText("用户名和密码保存在 Android WebView 的 App 私有认证库；“清除本机授权数据”会一并删除。");
		storageNote.setTextSize(12);
		storageNote.setTextColor(0xFF66666D);
		storageNote.setPadding(0, 0, 0, (int) (4 * d));
		form.addView(storageNote);

		final boolean[] settled = {false};
		final Runnable cancel = () -> {
			if (!settled[0]) {
				settled[0] = true;
				handler.cancel();
			}
		};
		pendingHttpAuthCancel = cancel;
		final AlertDialog dialog = new AlertDialog.Builder(this)
			.setTitle("需要网关认证")
			.setView(form)
			.setPositiveButton("继续", (ignored, which) -> {
				String user = username.getText().toString();
				String pass = password.getText().toString();
				if (TextUtils.isEmpty(user)) {
					cancel.run();
					showGatewayFailure("未填写 Basic Auth 用户名，已停止连接。");
					return;
				}
				if (!settled[0]) {
					settled[0] = true;
					pendingHttpAuthCancel = null;
					lastHttpAuthHost = authHost;
					lastHttpAuthUser = user;
					boolean keep = remember.isChecked();
					prefs().edit().putBoolean(authKey, keep).apply();
					if (webView != null) {
						webView.setHttpAuthUsernamePassword(
							authHost, authRealm, keep ? user : "", keep ? pass : "");
					}
					if (keep) submittedHttpAuthThisConnection.add(authKey);
					handler.proceed(user, pass);
				}
			})
			.setNegativeButton("取消", (ignored, which) -> {
				cancel.run();
				showGatewayFailure("已取消网关认证。");
			})
			.setOnCancelListener(ignored -> {
				cancel.run();
				showGatewayFailure("已取消网关认证。");
			})
			.create();
		httpAuthDialog = dialog;
		dialog.setOnDismissListener(ignored -> {
			if (httpAuthDialog == dialog) httpAuthDialog = null;
			if (pendingHttpAuthCancel == cancel) pendingHttpAuthCancel = null;
		});
		dialog.show();
	}

	private static String httpAuthPreferenceKey(String host, String realm) {
		return KEY_HTTP_AUTH_REMEMBER_PREFIX
			+ Uri.encode(host.toLowerCase(Locale.US) + "\n" + realm);
	}

	private void dismissPendingHttpAuth() {
		Runnable cancel = pendingHttpAuthCancel;
		pendingHttpAuthCancel = null;
		if (cancel != null) cancel.run();
		if (httpAuthDialog != null) {
			AlertDialog dialog = httpAuthDialog;
			httpAuthDialog = null;
			dialog.dismiss();
		}
	}

	private static int effectivePort(Uri uri) {
		if (uri.getPort() >= 0) return uri.getPort();
		return "https".equals(uri.getScheme()) ? 443 : 80;
	}

	private void showGatewayFailure(String message) {
		if (suppressGatewayErrors) return;
		if (uiState == UiState.WEB) {
			Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
			return;
		}
		if (uiState == UiState.HOME || uiState == UiState.EDIT) return;
		connectionGeneration += 1;
		Toast.makeText(this, message, Toast.LENGTH_LONG).show();
		showLocalShell(
			UiState.CONNECTING,
			"failed",
			"无法打开 DSH",
			message,
			"dsh-remote://app/retry",
			"重新连接",
			"dsh-remote://app/home",
			"返回服务器列表"
		);
	}

	/**
	 * 自签证书固定：键为 host:port，值为规范化的 SHA-256 hex（小写无冒号）。
	 * 命中 → 直接放行；未命中/变更 → 弹确认（变更时强提示 MITM 风险），
	 * 用户信任后记录指纹并重载（同一 handler 不能二次 proceed）。
	 */
	private void handleSslError(SslErrorHandler handler, SslError error) {
		if (awaitingCertificateDecision) {
			handler.cancel();
			return;
		}
		String errorUrl = error.getUrl();
		if (TextUtils.isEmpty(errorUrl) || !isActiveGatewayUri(Uri.parse(errorUrl))) {
			handler.cancel();
			return;
		}
		String fingerprint;
		try {
			X509Certificate cert = error.getCertificate().getX509Certificate();
			if (cert == null) {
				// AND-08：个别实现会返回 null。不再静默 cancel——用户只见「校验失败」
				// 却无原因。记录设备 API 级别便于排查，并给出含重试入口的明确错误。
				Log.w("dshr-ssl", "SslError 无法提取 X.509 证书（getX509Certificate()=null）"
					+ ", url=" + errorUrl
					+ ", primaryError=" + error.getPrimaryError()
					+ ", api=" + Build.VERSION.SDK_INT);
				handler.cancel();
				showCertificateExtractionFailure();
				return;
			}
			byte[] digest = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
			StringBuilder sb = new StringBuilder(digest.length * 2);
			for (byte b : digest) sb.append(String.format(Locale.US, "%02x", b));
			fingerprint = sb.toString();
		} catch (Exception e) {
			// AND-08：指纹提取异常同样给可见提示，不再静默吞掉。
			Log.w("dshr-ssl", "证书指纹提取失败：" + e
				+ ", url=" + errorUrl + ", api=" + Build.VERSION.SDK_INT);
			handler.cancel();
			showCertificateExtractionFailure();
			return;
		}
		if (TextUtils.isEmpty(activeUrl)) {
			handler.cancel();
			showGatewayFailure("无法确认当前服务器的证书。");
			return;
		}
		Uri base = Uri.parse(activeUrl);
		final String key = base.getHost() + ":" + effectivePort(base);
		final String fp = fingerprint;
		String stored = prefs().getString(KEY_CERT_PREFIX + key, null);
		if (stored == null) {
			String legacyKey = base.getHost() + ":" + base.getPort();
			stored = prefs().getString(KEY_CERT_PREFIX + legacyKey, null);
		}
		final boolean changed = stored != null && !stored.equalsIgnoreCase(fp);
		if (!changed && stored != null) {
			handler.proceed();
			return;
		}
		awaitingCertificateDecision = true;
		handler.cancel();

		StringBuilder msg = new StringBuilder();
		msg.append(key).append("\n\n证书指纹 (SHA-256)\n").append(prettyFingerprint(fp));
		if (changed) {
			msg.insert(0, "警告：该地址的证书与上次记录不同！若不是你本人更换了网关或证书，请取消——这可能是一次中间人攻击。\n\n");
		}
		new AlertDialog.Builder(this)
			.setTitle(changed ? "证书已变更！" : (stored == null ? "信任此服务器？" : "证书校验失败"))
			.setMessage(msg.toString())
			.setPositiveButton(changed ? "仍要更新信任" : "信任并继续", (dialog, which) -> {
				awaitingCertificateDecision = false;
				prefs().edit().putString(KEY_CERT_PREFIX + key, fp).apply();
				if (!TextUtils.isEmpty(activeUrl)) webView.loadUrl(activeUrl);
			})
			.setNegativeButton("取消", (dialog, which) -> {
				awaitingCertificateDecision = false;
				showGatewayFailure("未信任服务器证书，已停止连接。");
			})
			.setOnCancelListener(dialog -> {
				awaitingCertificateDecision = false;
				showGatewayFailure("未信任服务器证书，已停止连接。");
			})
			.show();
	}

	/**
	 * AND-08：无法从 SslError 提取证书时的明确错误。重试会重新发起加载、
	 * 再次走证书校验流程；每次重试都需用户显式点击，不会自动循环。
	 */
	private void showCertificateExtractionFailure() {
		new AlertDialog.Builder(this)
			.setTitle("证书校验失败")
			.setMessage("无法读取该服务器的证书，不能完成指纹核对。\n"
				+ "可能是系统 WebView 实现的兼容性问题，请重试，或检查系统更新后再试。")
			.setPositiveButton("重试", (dialog, which) -> {
				if (webView != null && !TextUtils.isEmpty(activeUrl)) webView.loadUrl(activeUrl);
			})
			.setNegativeButton("取消", (dialog, which) -> showGatewayFailure("证书校验失败，已停止连接。"))
			.setOnCancelListener(dialog -> showGatewayFailure("证书校验失败，已停止连接。"))
			.show();
	}

	private static String prettyFingerprint(String hex) {
		StringBuilder sb = new StringBuilder(hex.length() + hex.length() / 2);
		for (int i = 0; i < hex.length(); i += 2) {
			if (i > 0) sb.append(':');
			sb.append(hex.substring(i, Math.min(i + 2, hex.length())));
		}
		return sb.toString().toUpperCase(Locale.US);
	}

	// ---------- 连接维护 ----------

	private void clearDeviceData() {
		connectionGeneration += 1;
		CookieManager.getInstance().removeAllCookies(null);
		CookieManager.getInstance().flush();
		WebViewDatabase.getInstance(this).clearHttpAuthUsernamePassword();
		submittedHttpAuthThisConnection.clear();
		lastHttpAuthHost = "";
		lastHttpAuthUser = "";
		SharedPreferences p = prefs();
		SharedPreferences.Editor editor = p.edit();
		for (String key : p.getAll().keySet()) {
			if (key.startsWith(KEY_CERT_PREFIX)
				|| key.startsWith(KEY_HTTP_AUTH_REMEMBER_PREFIX)) editor.remove(key);
		}
		editor.apply();
		Toast.makeText(this, "本机授权已清除", Toast.LENGTH_SHORT).show();
		showHome();
	}

	private void showAbout() {
		String version;
		try {
			version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
		} catch (Exception e) {
			version = "?";
		}
		new AlertDialog.Builder(this)
			.setTitle("关于 DSH Remote")
			.setMessage("DSH Remote Android 客户端 v" + version + "\n"
				+ "通过受证书锁定保护的 frpc 隧道访问本机 DSH。\n\n"
				+ "在电脑插件里填写 VPS 地址、控制端口、登录密钥、访客密钥；"
				+ "手机添加配置组后点卡片即可连接，无需扫码。")
			.show();
	}

	// ---------- 其他生命周期 ----------

	@Override
	protected void onActivityResult(int requestCode, int resultCode, Intent data) {
		if (requestCode == REQ_FILE_CHOOSER && fileCallback != null) {
			fileCallback.onReceiveValue(
				WebChromeClient.FileChooserParams.parseResult(resultCode, data));
			fileCallback = null;
			return;
		}
		super.onActivityResult(requestCode, resultCode, data);
	}

	@Override
	public void onWindowFocusChanged(boolean hasFocus) {
		super.onWindowFocusChanged(hasFocus);
		// 旋转、分屏、刘海显隐之后重新下发 inset，页面避让保持准确。
		if (hasFocus && webView != null && webView.getVisibility() == View.VISIBLE) {
			applyInsetsToPage(webView);
		}
	}

	@Override
	public boolean dispatchKeyEvent(KeyEvent event) {
		if (event.getKeyCode() == KeyEvent.KEYCODE_BACK
			&& (uiState == UiState.WEB || uiState == UiState.CONNECTING)) {
			if (event.getAction() == KeyEvent.ACTION_UP) handleAppBack();
			return true;
		}
		return super.dispatchKeyEvent(event);
	}

	@Override
	public void onBackPressed() {
		handleAppBack();
	}

	private void handleAppBack() {
		long now = System.currentTimeMillis();
		if (now - lastBackAt < 80) return;
		lastBackAt = now;
		if (uiState == UiState.EDIT) {
			leaveEditor();
			return;
		}
		if (uiState == UiState.HOME) {
			if (canResumeSession) {
				resumeSession();
				return;
			}
			super.onBackPressed();
			return;
		}
		if (uiState == UiState.CONNECTING) {
			moveTaskToBack(true);
			return;
		}
		if (uiState == UiState.WEB && webView != null && webView.getVisibility() == View.VISIBLE) {
			webView.evaluateJavascript(
				"(function(){var bridge=window.__dshRemoteAndroidMobile;return !!(bridge&&bridge.closeSidebarIfExpanded&&bridge.closeSidebarIfExpanded());})()",
				value -> {
					if (value == null || !value.contains("true")) finishWebBack();
				}
			);
			return;
		}
		super.onBackPressed();
	}

	/**
	 * 会话内返回：先关官方弹层/侧栏（由 JS 处理）；再仅在同一网关内 goBack。
	 * 不退到连接壳或设置页。已在会话根时把 App 放到后台，隧道继续跑。
	 */
	private void finishWebBack() {
		if (uiState != UiState.WEB || webView == null || webView.getVisibility() != View.VISIBLE) {
			return;
		}
		if (webView.canGoBack()) {
			WebBackForwardList list = webView.copyBackForwardList();
			int idx = list.getCurrentIndex();
			if (idx > 0) {
				WebHistoryItem prev = list.getItemAtIndex(idx - 1);
				String prevUrl = prev != null ? prev.getUrl() : "";
				if (!TextUtils.isEmpty(prevUrl) && isActiveGatewayUri(Uri.parse(prevUrl))) {
					suppressGatewayErrorsBriefly();
					webView.goBack();
					return;
				}
			}
			webView.clearHistory();
		}
		moveTaskToBack(true);
	}

	private final class AppBridge {
		@JavascriptInterface
		public void openSettings() {
			runOnUiThread(() -> showConnectionSettings());
		}

		@JavascriptInterface
		public void setPageDark(boolean dark) {
			runOnUiThread(() -> applyPageDark(dark));
		}

		@JavascriptInterface
		public void setSessionNotice(String title, String text, boolean running) {
			TunnelService.updateSessionNotice(getApplicationContext(), title, text, running);
		}

		@JavascriptInterface
		public void imeFocusRect(double topCssPx, double bottomCssPx) {
			float density = getResources().getDisplayMetrics().density;
			if (topCssPx < 0 || bottomCssPx < 0) {
				lastImeFocusTopPx = -1;
				lastImeFocusBottomPx = -1;
			} else {
				lastImeFocusTopPx = Math.round((float) topCssPx * density);
				lastImeFocusBottomPx = Math.round((float) bottomCssPx * density);
			}
			runOnUiThread(() -> {
				if (rootLayout == null || Build.VERSION.SDK_INT < 30) return;
				WindowInsets insets = rootLayout.getRootWindowInsets();
				int ime = insets == null ? 0 : imeBottomPx(insets);
				if (ime > 0 || currentImePadding > 0) applyImeShift(ime);
			});
		}
	}

	private void showConnectionHome() {
		showConnectionSettings();
	}

	private static int parseInt(EditText e) {
		try {
			return Integer.parseInt(e.getText().toString().trim());
		} catch (NumberFormatException ex) {
			return -1;
		}
	}
}
