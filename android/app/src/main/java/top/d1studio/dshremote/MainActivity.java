package top.d1studio.dshremote;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.text.InputType;
import android.text.TextUtils;
import android.util.Log;
import android.view.ContextThemeWrapper;
import android.view.DisplayCutout;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsAnimation;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.JavascriptInterface;
import android.webkit.CookieManager;
import android.webkit.HttpAuthHandler;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
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
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.HashMap;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;

import org.json.JSONObject;

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

	/**
	 * 隧道常驻通知「连接设置」动作的 Intent action（D6）。
	 * 平板档（sw >= 600）不装移动 hook，页面上没有长按鲸鱼入口（契约 3.4），
	 * 通知是运行中进入连接设置页的进程外入口；与 ACTION_STOP 是两码事，不碰隧道。
	 */
	public static final String ACTION_OPEN_SETTINGS = "top.d1studio.dshremote.action.OPEN_SETTINGS";

	private static final String KEY_URL = "gateway_url";
	/** 地址维度的证书指纹键前缀（存量安装 + 直连/局域网节点），见 CertPin.HOST_PREFIX。 */
	private static final String KEY_CERT_PREFIX = CertPin.HOST_PREFIX;
	private static final String KEY_HTTP_AUTH_REMEMBER_PREFIX = "http_auth_remember_";
	private static final String MOBILE_UA_TOKEN = " DSHRemoteAndroid/1";
	private static final int IME_PAD_HYSTERESIS_DP = 12;
	/** 平板档门槛（契约 3.1）：smallestScreenWidthDp >= 600 即平板 / 折叠屏展开。 */
	private static final int TABLET_SW_DP = 600;
	/** 设备档位：契约里 device 的两个原生取值。 */
	private static final String MODE_PHONE = "phone";
	private static final String MODE_TABLET = "tablet";
	private static final int REQ_FILE_CHOOSER = 1001;
	private static final int REQ_NOTIF_PERM = 1002;
	/**
	 * T39：logcat tag。与既有 {@code dshr-frpc} / {@code dshr-svc} 同族命名。
	 * 用途：把每次文件选择器的原始结果（resultCode / data 是否为空 / URI scheme+authority /
	 * clipData 条数 / 能否读取与字节数 / 异常类名）打一份，便于事后用 adb 复盘。
	 * 用户远程不方便 adb，所以他主要看连接设置页那行只读诊断；这份是留给我们自己的。
	 */
	private static final String TAG = "dshr-chooser";
	/** T39：可读性自检的字节数硬顶。超过即认为流有问题（选择器返回 0 字节/半截流）。 */
	private static final int CHOOSER_PROBE_CAP = 1024 * 1024;
	/** T39：复制进私有缓存的单文件字节上限。附件场景足够，同时兜住"选择器给了个超大流"。 */
	private static final long CHOOSER_CACHE_MAX = 64L * 1024 * 1024;
	/**
	 * 隧道就绪等待硬顶。T23-B 把它搬到 TunnelReady（纯常量、可单测），值仍是 20_000ms。
	 * @see TunnelReady#TUNNEL_READY_TIMEOUT_MS
	 */

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
	/** T22-D：连接设置页的只读诊断行（无点击、无控件），显示 hook 最近一次上报。 */
	private TextView tvUiDiag;
	private Button resumeSessionBtn;
	private String editingProfileId = "";
	private WebView webView;
	private ValueCallback<Uri[]> fileCallback;
	/**
	 * T78：主界面可见的重连状态横幅（原生覆盖条）。与 WebView 同级、{@code layout_gravity=top}，
	 * 页面 DOM 一个字节都不写 ⇒ 手机档 / 平板档同一条路径，平板档天然零痕迹。
	 * 状态信号来自**只读** {@code evaluateJavascript} 探针（{@link ReconnectBanner#PROBE_JS}），
	 * 不依赖 hook，也不读 hook 的诊断载荷。
	 */
	private ReconnectBanner.Bar reconnectBanner;
	/**
	 * T78：防抖状态机（连续 2 次真才显示 / 连续 3 次假才隐藏 / UNKNOWN 不计数）。
	 * **只允许经 {@link #hideReconnectBannerNow()} 清零**，避免上一页的累计带到新页面。
	 */
	private final ReconnectBanner.Debouncer reconnectDebounce = new ReconnectBanner.Debouncer();
	/** T78：轮询是否在推进（onResume 起、onPause 停）。 */
	private boolean reconnectPolling = false;
	/**
	 * T90：横幅的**第二个数据源** —— hook 经既有 JS 桥（{@code DshRemoteApp.setUiDiag}）
	 * 推上来的 {@code wsState}（{@code reconnecting} / {@code ok-recovered} / {@code ok}）。
	 *
	 * <p>为什么必须加它：官方那条「重新连接中」指示器的渲染条件是 {@code state: wide && …}
	 * （{@code wide = !collapsed}）⇒ **左栏收起（56px rail，用户平时的状态）时它根本不渲染**，
	 * DOM 探针什么都探不到（T88 §E.4 实测：45s 真断线窗口 0 帧 / T90 复现一致）。
	 * hook 侧 T90 起用**UI 无关**的 WebSocket 观测拿到真实连接态，翻转时推一次；
	 * 这里把它与 DOM 探针做 **OR**：任一为真即「正在重连」。
	 *
	 * <p>生命周期：**页面级**（新文档开始时置 null，见 {@code onPageStarted}）。
	 * hook 每次装上都经 {@code reportUiDiag()} 推一次当前状态，所以新文档必然有一次刷新；
	 * 不需要 TTL —— 它本来就是"当前状态"而不是"心跳"。{@code volatile}：写在 WebView 的
	 * JS 桥线程、读在主线程（{@code reconnectPollTick}）。
	 */
	private volatile String hookConnState = null;
	/**
	 * T78：系统栏/挖孔/任务栏的逐方向并集（px）。T72 的平板让位与 T78 的横幅外边距
	 * **共用这一份取值**，不各自算一套——否则两处会各自漂移。
	 */
	private final int[] systemBarInsetsPx = new int[4];
	/** 当前 WebView 加载的远端地址；本地启动壳不参与证书与同源判断。 */
	private String activeUrl = "";
	/** 从会话进入连接设置时暂存，用于「返回会话」而不必重连。 */
	private String resumeUrl = "";
	private boolean canResumeSession = false;
	/**
	 * 本次连接设置页是不是「会话根返回键」进来的（D6.1）。为 true 时设置页的
	 * 返回键退到后台而不是回会话——否则「会话根 → 设置 → 返回 → 会话 → 返回 →
	 * 设置」死循环，用返回键退不出 App。一次性消费：退后台那一刻立即清零，任何离开设置页
	 * 的路径也都经 clearResumeSession() 清零，故再次进入会话/设置不会残留。
	 *
	 * <p><b>T65：置位点从「平板档」放宽到「任意档位」</b>。改前唯一置位点在
	 * {@code finishWebBack()} 的 {@code if (isTabletClass())} 分支内 ⇒ 手机档恒为 false
	 * ⇒ 手机档会话根按返回键落到 {@code moveTaskToBack(true)} 直接退到桌面，而设置页文案
	 * 却在承诺「点上方「返回当前会话」或系统返回键继续」⇒ <b>行为与承诺不一致</b>
	 * （T48/T58/T59 三轮都踩到同一个现象：会话页里按返回键直接回桌面）。
	 * 现在两档一致：会话根按返回键 → 连接设置页（隧道/会话活性保持），
	 * 设置页再按一次才退到后台。平板档语义（D6.1）**逐字不变**，
	 * 只是手机档从此也适用同一套判据。
	 */
	private boolean settingsViaBackKey = false;
	/**
	 * 当前页面状态。**只允许通过 {@link #setUiState(UiState)} 写入**：
	 * 平板档的系统栏让位绑在这个跃迁上（见 setUiState 的注释），直接赋值会漏掉让位重算。
	 * 字段初始化是唯一例外（那时还没有 WebView，setUiState 的门禁本来也会直接返回）。
	 */
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
	/**
	 * T23-A：本次连接来自哪个配置组（直连/局域网节点为空串）。
	 * 隧道模式下一律连本机回环地址 127.0.0.1:&lt;端口&gt;，两个配置档背后是两台不同的
	 * 电脑、却共用同一个回环端口 ⇒ 只按 host:port 锁证书必然在切档时误报「证书已变更！」。
	 * 有它才能按配置档身份核对指纹（CertPin.PROFILE_PREFIX）。每次 openGateway 一次性赋值，
	 * 不跨连接残留。
	 */
	private String activeProfileId = "";
	/**
	 * T49：当前网关的 host/port。Service Worker 的子资源必须由 App 自己按已锁定
	 * 指纹去取（SW 自己的 fetch 拿不到 proceed 放行），而那条通道只对**当前网关**
	 * 开放——绝不能变成一个可以随便连别处的通用代理。每次 openGateway 一次性赋值。
	 */
	private volatile String activeGatewayHost = "";
	private volatile int activeGatewayPort = -1;
	/** 会话页沉浸状态栏；注入失败时退回实色。 */
	private boolean edgeToEdgeChrome = true;
	/**
	 * PERF-03：WebView JS 定时器是否已挂起（进程级全局，本标记只用于「不要叠加 pause」）。
	 *
	 * pauseTimers()/resumeTimers() 的作用域是【整个进程】而不是单个 WebView（AOSP 原文：
	 * "This is a global requests, not restricted to just this WebView"），所以本标记
	 * 必须 static：一旦 Activity 重建（T17 §3 里 fontScale/locale/navigation 等未声明
	 * 在 configChanges 的配置变化即可触发），实例字段会归零而进程真实状态仍为 paused，
	 * 新实例 onResume 的 if 永假 ⇒ 定时器被永久冻结到进程被杀，而 hook 的收敛全部依赖
	 * setTimeout/rAF（mobile-web.js:3243 的有界重试、:3195 的去抖）。这正是
	 * 「连接失败/中断后再次连接」的典型动作序列。
	 */
	private static boolean webTimersPaused = false;
	/**
	 * 当前是否处于前台。只用于 ensureWebView() 新建 WebView 后按「当前处于前台」把
	 * 进程级全局态归零；正确性不依赖它——onResume 无条件 resumeTimers 才是结构不变量。
	 */
	private static volatile boolean appInForeground = false;
	/**
	 * DIAG-30s：本次连接起点（openGateway 落点）。onPageStarted/onPageFinished/
	 * 首次进入会话三处打 t+xxms，用户复现时抓 `adb logcat -s dshr-perf` 即可
	 * 看出 30s 花在哪一段（TLS+首包 / 资源加载 / DSH 前端启动）。
	 */
	private long connectStartMs = 0;

	/**
	 * T22-B：主框架失败的那个 URL。Chromium 在主框架失败后仍用【原 URL】回调
	 * onPageFinished / doUpdateVisitedHistory / onPageCommitVisible，所以错误页会以
	 * 「网关 URL」的身份走到 enterSessionPage。若照常判成会话页，就会给错误页注入
	 * hook、置 uiState=WEB、clearHistory()，之后所有网关失败被 showGatewayFailure
	 * 永久降级成 Toast、「重新连接」入口从此消失。命中本字段的 URL 一律不进 WEB 态。
	 * 每次网关失败都置位，命中本字段的 URL 一律不进 WEB 态。清零只有两个点：
	 * openGateway（新一轮连接尝试，含「重新连接」）与 enterSessionPage 里
	 * 「换了 URL」的成功路径。**不能在 onPageStarted 或 showLocalShell 清**——
	 * 前者与主框架错误同毫秒到达（会提前清掉），后者是失败处理自己走的路径
	 * （showGatewayFailure → showLocalShell，清了等于没记）。
	 */
	private String failedMainFrameUrl = "";
	/**
	 * T22-D：hook 侧最近一次上报的页面适配诊断（window.DshRemoteApp.setUiDiag 过桥），
	 * 字段集与 hook 的 collectUiDiag() 同源：device/on/rootClass/ready/whale/frame/
	 * strictOff。只在内存里留最近一份，供连接设置页那行只读诊断显示；缺失显示「未上报」。
	 * 由 WebView 的 JS 线程写、UI 线程读，故声明 volatile。
	 */
	private volatile String uiDiagRaw = "";
	private volatile String uiDiagSummary = "";

	/**
	 * T39：最近一次 WebView 文件选择器的诊断行（原生侧，只读）。与 {@code uiDiagSummary}
	 * 分开存：hook 那份是页面适配诊断且**载荷字段集合被 test:device 全等钉死**（9 字段 + ts），
	 * 原生这份是文件选择器链路，混进去会破坏那条契约断言，故在 refreshUiDiagLine() 里拼接。
	 * 空串 = 本次 App 生命周期内还没选过文件（显示「未选择」而不是省略）。
	 */
	private volatile String chooserDiag = "";

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
		// T49：必须早于任何页面加载装（Service Worker 的脚本抓取随时可能发生）。
		installServiceWorkerClient();
		ensureWebView();
		ProfileStore.migrateLegacy(prefs());
		ProfileStore.migrateDirect(prefs());
		if (!handleImportIntent(getIntent()) && !handleOpenSettingsIntent(getIntent())) {
			// 启动一律进服务器选择页：上次连的 server 不在线时，自动连接会把 App
			// 卡死在连接壳。连哪个 server 由用户当场手选（导入链接除外，那是显式意图）。
			showHome();
		}
	}

	@Override
	protected void onNewIntent(Intent intent) {
		super.onNewIntent(intent);
		setIntent(intent);
		if (handleImportIntent(intent)) return;
		handleOpenSettingsIntent(intent);
	}

	@Override
	protected void onPause() {
		super.onPause();
		// T78：退后台即停轮询并立即收起横幅——后台不该留一条"重新连接中"，
		// 也不该继续每 500ms 往页面里跑只读探针。
		stopReconnectPolling();
		hideReconnectBannerNow();
		CookieManager.getInstance().flush();
		// PERF-03：退后台即挂起 WebView 渲染与全 WebView JS 定时器（含 DSH 的
		// token 流 MutationObserver/rAF、mobile.js 通知扫描），让射频/CPU 能睡；
		// frpc 隧道与前台服务保留，会话不断，只是页面暂停。回前台见 onResume。
		if (webView != null) {
			try {
				webView.onPause();
			} catch (Exception ignored) {
			}
			// 守卫只用于「不要叠加 pause」：pause 侧可能叠加、resume 侧不依赖它
			// （onResume 无条件 resumeTimers），故这一处语义未变。
			if (!webTimersPaused) {
				try {
					webView.pauseTimers();
					webTimersPaused = true;
					Log.i("dshr-perf", "onPause: 进程级定时器已挂起（webTimersPaused=true）");
				} catch (Exception e) {
					Log.w("dshr-perf", "onPause: pauseTimers 失败 " + e);
				}
			}
		}
		appInForeground = false;
	}

	@Override
	protected void onResume() {
		super.onResume();
		appInForeground = true;
		// T72：平板档系统栏让位的最后一层兜底。insets listener（2342 附近）已覆盖
		// 任务栏显隐/导航模式/旋转，但「冷启动 + 后台期间状态变化」这条路上未必有新 insets
		// 事件；这里 post 一次重算（幂等，成本一次 setPadding），保证冷启动首帧就避让。
		if (rootLayout != null) rootLayout.post(this::applyDeviceClassInsets);
		// T78：横幅的四向外边距与平板让位同源同值，回前台补算一次（幂等）。
		if (rootLayout != null) rootLayout.post(this::applyReconnectBannerInsets);
		// T78：回前台重启重连状态轮询（onPause 停掉的那条）。
		startReconnectPolling();
		// T90：顺便**补读一次** hook 的连接态（只读、一次性）：后台期间 pauseTimers 冻住了
		// 页面侧 JS，翻转事件未必推得过来（见 refreshHookConnState 注释）。放在
		// startReconnectPolling 之后：先让轮询恢复，再补这一读，横幅下一拍就能用上新值。
		refreshHookConnState();
		// PERF-03：与 onPause 成对恢复；在 WEB 态补一次 inset/注入（暂停期间
		// 键盘/旋转事件可能漏掉），已有 resumeLiveSession 保证不断整页重载。
		if (webView != null) {
			try {
				webView.onResume();
			} catch (Exception ignored) {
			}
			// 防御性恢复（T17 b'）：resumeTimers() 是全局「恢复运行」而非「加一」，
			// 前台必须恒为未暂停。**无条件**调用，不看 webTimersPaused——该字段一旦与
			// 真实全局态失配（Activity 重建后归零、resumeTimers 抛异常后被 finally 清掉），
			// 条件式恢复就会永远不执行，定时器被永久冻结到进程被杀。
			// 不依赖「重复 pause 是否叠加计数」这一未证实语义：pause 侧有守卫不叠加，
			// 重复 resume 在两种语义下都安全。
			try {
				webView.resumeTimers();
				webTimersPaused = false;
				Log.i("dshr-perf", "onResume: 进程级定时器已恢复运行（无条件 resumeTimers）");
			} catch (Exception e) {
				// 恢复失败不得把标志留在「已挂起」——否则下一轮守卫会把 pause 也跳过。
				webTimersPaused = false;
				Log.w("dshr-perf", "onResume: resumeTimers 失败（标志已清零，下轮仍会重试）" + e);
			}
			if (uiState == UiState.WEB && webView.getVisibility() == View.VISIBLE) {
				applyInsetsToPage(webView);
				// T27-B：回前台也重排一次自检。退后台期间页面可能被系统回收重建
				// （或用户在别处改了什么导致档位/收敛态漂移），回前台是补注的天然时机。
				scheduleAdaptationProbe(webView);
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
		// T78：停掉重连状态轮询并摘掉横幅引用（rootLayout 随 Activity 一起销毁）。
		stopReconnectPolling();
		reconnectBanner = null;
		bgExecutor.shutdownNow();
		// T23-B：frpc 就绪回调是静态字段且持有本 Activity，销毁即注销
		//（正常路径由 waitAndOpen 的 finally 注销，这里兜底重建/异常路径）。
		FrpcManager.setReadyListener(null);
		dismissPendingHttpAuth();
		// T41-F3（T40 反例 F3 / T37 早就指出）：在途的文件选择回调必须**归还 null**，
		// 不能只把字段置空。位置选在这里、WebView 拆除**之前**：
		//   ① ValueCallback 是 Chromium 侧 AwContents 持有的对象，回调会顺着它给渲染进程
		//      发"选择结束(无结果)"，页面的 <input type=file> 才会真正复位；
		//   ② 一旦 webView.destroy() 先跑，回调就悬在一个已销毁的 WebView 上 ——
		//      要么静默 no-op（input 永远挂着，用户看到卡在"选择中"），
		//      要么在 Chromium 内部抛异常。
		// 覆盖的重建场景：configChanges 含 orientation/screenSize/screenLayout/
		// smallestScreenSize/density/keyboardHidden/uiMode，旋转/分屏/深色**不会**重建；
		// 但 locale / fontScale 不在列表里，改系统语言或字号 ⇒ Activity 重建 ⇒
		// onActivityResult 送到新实例、fileCallback 为 null ⇒ 结果被丢弃。
		// 归还在此发生，新实例那次仍会走"回调已丢失"诊断分支（结果确实拿不回来，
		// 那要靠 onSaveInstanceState 才能救），但**页面 input 一定不会永久悬空**。
		releaseInFlightFileCallback("onDestroy");
		if (webView != null) {
			// AND-03：非静态内部类 AppBridge 经 addJavascriptInterface 被 WebView 持有，
			// 不销毁则 Chromium 内核与 Activity Context 全部泄漏。顺序：摘 JS 桥
			// → 移出视图树 → 清子视图（Chromium 全屏视频/下拉等宿主子 View）
			// → 停止加载 → 清历史 → destroy。
			webView.removeJavascriptInterface("DshRemoteApp");
			// 归还进程级全局态（T17 P1 的直接成因）：pauseTimers 的作用域是整个进程，
			// 不会随本实例一起死。销毁前不恢复，同进程内下一个 Activity 实例就继承
			// 一个「已暂停」的进程，而它的 webTimersPaused 因字段重建而为 false，
			// 于是永不 resumeTimers —— 定时器永久冻结。
			try {
				webView.resumeTimers();
				Log.i("dshr-perf", "onDestroy: 销毁 WebView 前归还进程级定时器（resumeTimers）");
			} catch (Exception e) {
				Log.w("dshr-perf", "onDestroy: 归还定时器失败 " + e);
			}
			webTimersPaused = false;
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
		// T41-F2（T40 反例 F2）：chooser 缓存目录此前**只增不减**（全仓零清理），
		// 与上面"退出即清"是同一口径。放在 WebView 已 destroy() 之后清：
		//   ① 此时渲染进程已死，不会再有新的 openFile 进来；
		//   ② 即使有**正在读**的 fd，POSIX 语义下 unlink 不影响已打开的 fd，
		//      正在进行的读照样读完（Android 是 ext4/f2fs，都符合）；
		//   ③ 唯一的窗口是"清完之后 WebView 又来读那个 URI" ⇒ 拿到 FileNotFoundException，
		//      但那时 WebView 已 destroy、页面已随 Activity 一起死，不存在用户可见的失败。
		// 另：进程被系统强杀（无 onDestroy）时目录会残留，属 cacheDir，由系统按存储压力回收。
		purgeChooserCacheDir("onDestroy");
		super.onDestroy();
	}

	/**
	 * T41-F3：归还在途的文件选择回调（{@code onReceiveValue(null)}）并清空字段。
	 * 幂等：没有在途回调时什么都不做。
	 */
	private void releaseInFlightFileCallback(String why) {
		ValueCallback<Uri[]> cb = fileCallback;
		fileCallback = null;
		if (cb == null) return;
		try {
			cb.onReceiveValue(null);
			Log.i("dshr-chooser", "released in-flight fileCallback at " + why + "（页面 input 已复位）");
		} catch (Throwable t) {
			// 回调抛异常也不能带崩 onDestroy；页面那边最坏是这次没复位。
			Log.w("dshr-chooser", "release in-flight fileCallback failed at " + why
				+ ": " + t.getClass().getSimpleName());
		}
	}

	/** T41-F2：清空 {@code cacheDir/chooser/}（不删目录本身，provider 侧会复用）。 */
	private void purgeChooserCacheDir(String why) {
		try {
			int removed = ChooserCacheProvider.purgeCache(this);
			if (removed > 0) {
				Log.i("dshr-chooser", "purged chooser cache at " + why + ": " + removed + " file(s)");
			}
		} catch (Throwable t) {
			Log.w("dshr-chooser", "purge chooser cache failed at " + why
				+ ": " + t.getClass().getSimpleName());
		}
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

		// T22-D：只读诊断行（纯文本、不可点、不新增任何控件），显示 hook 最近一次
		// 上报的页面适配效果。给「手机界面到底有没有生效」一个当场可读的答案。
		tvUiDiag = new TextView(this);
		tvUiDiag.setTextSize(12);
		tvUiDiag.setPadding(0, dp(4, d), 0, 0);
		box.addView(tvUiDiag);
		refreshUiDiagLine();

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
		setUiState(UiState.HOME);
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
		setUiState(UiState.HOME);
		refreshProfileCards();
		refreshDirectNodes();
		if (resumeSessionBtn != null) {
			resumeSessionBtn.setVisibility(canResumeSession ? View.VISIBLE : View.GONE);
		}
		if (tvTunnelState != null && canResumeSession) {
			// D6.1：由返回键进入设置时，返回键 = 退到后台（不回会话，否则死循环），
			// 这时不能再承诺「系统返回键继续」——只承诺上方按钮。其余入口（通知动作 /
			// 长按鲸鱼等）返回键确实回会话，原文案成立。
			// T65：判据从 `settingsViaBackKey && isTabletClass()` 收窄为 `settingsViaBackKey`
			// —— 置位点已放宽到任意档位（见字段注释），再加 isTabletClass() 会让手机档
			// 重新落进「承诺系统返回键、实际退桌面」的旧坑，正是本任务要修的那条。
			tvTunnelState.setText(settingsViaBackKey
				? "隧道仍在运行。点上方「返回当前会话」继续，无需重新连接。"
				: "隧道仍在运行。点上方「返回当前会话」或系统返回键继续，无需重新连接。");
		}
		if (homeScroll != null) homeScroll.setVisibility(View.VISIBLE);
		if (setupScroll != null) setupScroll.setVisibility(View.GONE);
		refreshUiDiagLine();
		applySystemBars();
	}

	/**
	 * 刷新连接设置页那行只读诊断。显示最近一次 hook 上报的关键字段
	 * （device/on/rootClass/ready/whale/frame/strictOff），从未收到上报时显示「未上报」。
	 * 必须在 UI 线程调用。
	 *
	 * <p>T39：在 hook 那段后面接上**原生侧**的文件选择器诊断（同一行、仍然只读、无新增控件）。
	 * 分两段而不是揉进 {@link #formatUiDiag}：那份载荷字段集合被 test:device 全等钉死
	 * （9 字段 + ts），原生这段不属于 hook 契约，揉进去会破坏那条断言。
	 * 这样用户远程复现一次后，回设置页看一眼就能告诉我们卡在选择器链路的哪一环。
	 *
	 * <p>T60：第三段接上 {@link PinnedFetch#statsSummary()}（并发峰值/排队/拒绝/累计字节），
	 * 同样只读、无新增可点控件。刻意做成**独立一段**而不是揉进 {@link #formatUiDiag}：
	 * 后者的载荷字段集合被 test:device 全等钉死。
	 */
	private void refreshUiDiagLine() {
		if (tvUiDiag == null) return;
		String summary = uiDiagSummary;
		String base = TextUtils.isEmpty(summary)
			? "页面适配诊断：未上报（连上会话后由页面回报）"
			: summary;
		String chooser = TextUtils.isEmpty(chooserDiag)
			? "文件选择：未选择过"
			: "文件选择：" + chooserDiag;
		// T60：PinnedFetch 那一行（只读纯文本，与上面两段同一 TextView、同样不新增控件）。
		// 「并发峰值 / 排队 / 拒绝 / 本次累计字节」四项是并发闸门唯一能被用户
		// 自证的证据——没它们就只能翻 logcat（远程场景下用户拿不到）。
		// 计数器在后台线程变，这里只在刷新时读一次，不做主动推送。
		//
		// T65：追加两段——落盘缓存的命中/取回/淘汰，以及**未拦**计数。
		// 后者是「/api 与主文档没被接管」的唯一用户自证：远程场景下用户拿不到 logcat，
		// 而这恰恰是最该被怀疑的一处（拦错 = 白屏 / 登录态坏掉）。
		// 同样只读纯文本、同样不新增可点控件，formatUiDiag 的载荷契约一个字没动。
		tvUiDiag.setText(base + "\n" + chooser + "\n" + PinnedFetch.statsSummary()
			+ "\n" + StaticDiskCache.statsSummary()
			+ "\n" + staticPassthroughSummary());
	}

	/**
	 * 把 hook 的诊断 JSON 折成一行文案。字段名与 hook 的 collectUiDiag() 同源，
	 * 任何字段缺失都显示「未上报」而不是省略——缺字段本身就是要说出来的信息。
	 * 解析失败返回空串，由 refreshUiDiagLine() 落回「未上报」。
	 */
	private static String formatUiDiag(String json) {
		if (TextUtils.isEmpty(json)) return "";
		try {
			JSONObject o = new JSONObject(json);
			return "页面适配诊断：档位 " + diagStr(o, "device")
				+ " · 钩子 " + diagBool(o, "on")
				+ " · 根类 " + diagStr(o, "rootClass")
				+ " · 收敛 " + diagBool(o, "ready")
				+ " · 鲸鱼 " + diagBool(o, "whale")
				+ " · 三栏 " + diagBool(o, "frame")
				+ " · 严格关闭 " + diagBool(o, "strictOff")
				// T38-3：接上 T31-4 加的 wsState / lastDisconnectAt。
				// 这两个字段此前 hook 一直在报、原生却从不读 ⇒ 诊断行说的"连接好不好"全是空话；
				// 而 T30 §5 第四步要的正是"用户手机不接电脑时，靠这一行自证是不是真在掉线"。
				// 纯展示、只读，不新增任何可点击控件。
				+ " · 连接 " + diagWsState(o)
				+ " · 上次断线 " + diagLastDisconnect(o);
		} catch (Exception e) {
			return "";
		}
	}

	/**
	 * T38-3：把 hook 侧观测到的 WS 连接状态翻成中文，取值与 mobile.js 的
	 * collectUiDiag() 一一对应：reconnecting / ok-recovered / ok。
	 * 字段缺失（旧版 hook）时返回「未上报」，与其它字段同一口径，不静默编造。
	 */
	private static String diagWsState(JSONObject o) {
		if (!o.has("wsState")) return "未上报";
		String v = o.optString("wsState", "");
		if (TextUtils.isEmpty(v)) return "无";
		if ("reconnecting".equals(v)) return "正在重连";
		if ("ok-recovered".equals(v)) return "曾断开已恢复";
		if ("ok".equals(v)) return "已连接";
		return v;
	}

	/**
	 * T38-3：上次断线的时刻。0 或字段缺失 = 本次页面生命周期内一次都没断过（显示「无」）。
	 * 每次调用新建 SimpleDateFormat：setUiDiag 跑在 WebView 的桥线程上，
	 * 复用实例会有并发风险。
	 */
	private static String diagLastDisconnect(JSONObject o) {
		if (!o.has("lastDisconnectAt")) return "未上报";
		long v = o.optLong("lastDisconnectAt", 0L);
		if (v <= 0L) return "无";
		return new SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault()).format(new Date(v));
	}

	private static String diagStr(JSONObject o, String key) {
		if (!o.has(key)) return "未上报";
		String v = o.optString(key, "");
		return TextUtils.isEmpty(v) ? "无" : v;
	}

	private static String diagBool(JSONObject o, String key) {
		if (!o.has(key)) return "未上报";
		return o.optBoolean(key) ? "是" : "否";
	}

	/**
	 * T90：只认 hook 诊断载荷里 {@code wsState} 的三个**已知取值**（横幅的第二个数据源）。
	 * 未知取值 / 缺字段 / 载荷坏掉一律返回 {@code null} = 「这个数据源不投票」
	 * （横幅照旧只看 DOM 探针，行为与 T90 之前逐字相同）。
	 */
	private static String normaliseWsState(String v) {
		if (v == null) return null;
		if ("reconnecting".equals(v) || "ok-recovered".equals(v) || "ok".equals(v)) return v;
		return null;
	}

	private static String parseUiDiagWsState(String json) {
		if (json == null || json.isEmpty()) return null;
		try {
			return normaliseWsState(new JSONObject(json).optString("wsState", ""));
		} catch (Throwable ignored) {
			return null;
		}
	}

	private static String normaliseJsonString(String value) {
		if (value == null) return null;
		String v = value.trim();
		if (v.isEmpty() || "null".equals(v)) return null;
		if (v.length() >= 2 && v.charAt(0) == '"' && v.charAt(v.length() - 1) == '"') {
			v = v.substring(1, v.length() - 1);
		}
		return v.isEmpty() ? null : v;
	}

	private void clearResumeSession() {
		canResumeSession = false;
		resumeUrl = "";
		// 离开连接设置页的所有出口（返回会话、返回键退后台之外的重连、直连、showHome）
		// 都经这里，顺带把「本次来自返回键路径」的一次性标记清掉，不留残值。
		settingsViaBackKey = false;
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
			setUiState(UiState.WEB);
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
				setUiState(UiState.WEB);
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
		setUiState(UiState.EDIT);
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
		// T23-A：二维码里的网关自签指纹必须随配置组一起存下来。改前这里没拷，
		// Profile 也没有该字段 ⇒ 指纹在导入那一刻就被丢弃，后续首连前的「预置指纹」
		// 分支永远不成立（每次都退回 TOFU）。
		p.fingerprint = CertPin.normalizeFingerprint(c.fingerprint);
		ProfileStore.upsert(prefs(), p);
		ProfileStore.setActiveId(prefs(), p.id);
		beginTunnel(p);
		return true;
	}

	/**
	 * 隧道常驻通知「连接设置」动作的落点（D6）。冷启动（onCreate）与已在前台/后台
	 * （onNewIntent，Activity 是 singleTask）两条路径复用同一入口，行为一致：
	 * 只切到连接设置页，不动隧道、不重载 WebView 页面。
	 * 与 handleImportIntent 一样是「一次性意图」：消费后清掉 Intent 上的 action，
	 * 避免系统因内存回收重建 Activity 时又无端跳回设置页。
	 */
	private boolean handleOpenSettingsIntent(Intent i) {
		if (i == null || !ACTION_OPEN_SETTINGS.equals(i.getAction())) return false;
		i.setAction(null);
		showConnectionSettings();
		return true;
	}

	private void showLocalShell(UiState nextState, String state, String title, String message,
			String primaryHref, String primaryLabel, String secondaryHref, String secondaryLabel) {
		activeUrl = "";
		awaitingCertificateDecision = false;
		dismissPendingHttpAuth();
		setUiState(nextState);
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
		// T23-A：证书按配置档身份锁定，连接全程（含复用活隧道的直连 openGateway）都要带着它。
		activeProfileId = profile.id;
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
					setTunnelState("隧道已在运行，正在打开会话…");
					if (resumeLiveSession(target)) return;
					openGateway(target, profile.id);
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
				// T23-B：状态标签逐步更新。改前只有「隧道启动中（…3~10 秒）…」这一句，
				// 且 openGateway 之后再也不动它 ⇒ 用户是在看一个过期标签判断卡没卡。
				setTunnelState("正在启动隧道（端口 " + port + "）…");
				Intent svc = new Intent(MainActivity.this, TunnelService.class);
				svc.putExtra(TunnelService.EXTRA_BIND_PORT, port);
				if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc);
				else startService(svc);
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
				// 壳页已经就位，这一条才会同时落到壳页正文上（用户真正在看的那块屏）。
				setShellStage("正在建立隧道（frpc 打洞/建联）…"
					+ (port == ProfileStore.BIND_PORT ? "" : "（端口 " + port + "）"));
				waitAndOpen(cfg, generation, profile.id);
			});
		});
	}

	/**
	 * 隧道就绪等待。判据只有一个：本地回环端口能不能连上。
	 *
	 * T23-B 相对改前的三处变化（20s 硬顶与打洞 fallbackTimeoutMs=5000 都【没动】）：
	 * ①探测从 connect 600ms 收到 200ms —— 回环要么秒连要么秒拒，600ms 是过度冗余；
	 * ②间隔从固定 400ms 改成 100→200→400ms 轻微退避，最坏检出滞后 1000ms → 600ms；
	 * ③frpc 命中就绪日志时立刻唤醒一次探测，而不是死等下一个 tick。
	 *   日志只用来提前触发，【端口可连仍是唯一判据】——frp 的文案会随版本/语言漂移，
	 *   绝不放行任何连接。
	 */
	private void waitAndOpen(final VisitorConfig cfg, final int generation, final String profileId) {
		final long startMs = System.currentTimeMillis();
		final long deadline = startMs + TunnelReady.TUNNEL_READY_TIMEOUT_MS;
		final Object signal = new Object();
		final boolean[] signaled = new boolean[1];
		// AND-06：就绪轮询走统一线程池；onDestroy 的 shutdownNow() 会中断该轮询。
		runInBackground("tunnel-wait", () -> {
			FrpcManager.setReadyListener(() -> {
				synchronized (signal) {
					signaled[0] = true;
					signal.notifyAll();
				}
			});
			boolean up = false;
			int attempts = 0;
			long statusMs = 0;
			try {
				while (!destroyed && System.currentTimeMillis() < deadline) {
					if (Thread.currentThread().isInterrupted()) break;
					if (isLoopbackPortOpen(cfg.bindPort)) {
						up = true;
						Log.i("dshr-perf", "隧道就绪 t+"
							+ (System.currentTimeMillis() - startMs) + "ms 端口=" + cfg.bindPort
							+ " 探测次数=" + (attempts + 1));
						break;
					}
					attempts++;
					synchronized (signal) {
						if (signaled[0]) {
							// frpc 已报就绪：不等退避，立刻再探一次。
							signaled[0] = false;
						} else {
							try {
								signal.wait(TunnelReady.nextDelayMs(attempts));
							} catch (InterruptedException e) {
								Thread.currentThread().interrupt();
								break;
							}
							signaled[0] = false;
						}
					}
					// 状态文案每秒刷新一次已等待时长，让「还在等、等了多久」当场可读。
					long now = System.currentTimeMillis();
					if (now - statusMs >= 1000) {
						statusMs = now;
						setShellStage(TunnelReady.waitingLabel(now - startMs));
					}
				}
			} finally {
				// 回调持有 Activity，绝不能留在静态字段里。
				FrpcManager.setReadyListener(null);
			}
			final boolean ok = up;
			runOnUiThread(() -> {
				if (destroyed) return;
				if (generation != connectionGeneration || uiState != UiState.CONNECTING) return;
				if (!ok) {
					setTunnelState("隧道未就绪：检查电脑网关、密钥和 frps 网络。");
					showLocalShell(
						UiState.CONNECTING,
						"failed",
						"无法连接 DSH",
						"隧道未在 " + (TunnelReady.TUNNEL_READY_TIMEOUT_MS / 1000)
							+ " 秒内就绪。请检查电脑网关、密钥和 frps 网络后重试。",
						"dsh-remote://app/retry",
						"重新连接",
						"dsh-remote://app/home",
						"返回服务器列表"
					);
					return;
				}
				// 二维码携带的指纹在首连前预置：免 TOFU 弹窗，直接锁定。
				// T27-A：预置**只**写配置档键。判定侧已把「配置档连接」与「直连地址」
				// 两个信任语境彻底分开（不再互回退），此时写共享地址键对本档毫无用处，
				// 反而会把这份信任泄漏给同一 host:port 上的直连/局域网节点。
				String seedFp = CertPin.normalizeFingerprint(cfg.fingerprint);
				if (seedFp.length() == 64) {
					SharedPreferences.Editor seed = prefs().edit();
					for (String key : CertPin.seedKeys(profileId, "127.0.0.1", cfg.bindPort)) {
						seed.putString(key, seedFp);
					}
					seed.apply();
					Log.i("dshr-perf", "预置网关证书指纹 profile=" + profileId
						+ " 端口=" + cfg.bindPort);
				}
				setTunnelState("隧道已就绪，正在打开 DSH…");
				openGateway("https://127.0.0.1:" + cfg.bindPort + "/", profileId);
			});
		});
	}

	/**
	 * 回环端口探测（隧道就绪的唯一判据）。必须在后台线程调用。
	 * 回环 connect 要么立刻成功、要么立刻 ECONNREFUSED，超时只用于兜底
	 * （端口被半死进程占住时），故 200ms 足够。
	 */
	private static boolean isLoopbackPortOpen(int port) {
		try {
			Socket s = new Socket();
			try {
				s.connect(new InetSocketAddress("127.0.0.1", port), (int) TunnelReady.PROBE_TIMEOUT_MS);
				return true;
			} finally {
				try {
					s.close();
				} catch (IOException ignored) {
				}
			}
		} catch (IOException ignored) {
			return false;
		}
	}

	/**
	 * T23-B：状态文案的唯一写入口（空指针安全，可从后台线程调用）。只写原生标签。
	 *
	 * 刻意【不】碰 WebView：直连/复用路径上 openGateway 时屏幕上仍是上一张会话页，
	 * 对它 evaluateJavascript 会排在那个页面的 JS 队列后面（实测在 DSH 首屏解析期间
	 * 要等几十毫秒），等于给每条连接白加一次等待。壳页正文由 setShellStage 单独负责，
	 * 只在确定「壳页正在屏上」（隧道等待期）时才发那一次 JS。
	 */
	private void setTunnelState(final String text) {
		if (tvTunnelState == null) return;
		runOnUiThread(() -> {
			if (tvTunnelState != null) tvTunnelState.setText(text);
		});
	}

	/**
	 * 隧道等待期的阶段文案：原生标签 + 本地壳页正文一起更新。
	 *
	 * 为什么要落到壳页：连接中原生连接设置页是隐藏的，屏幕上只有这张壳页，
	 * 改前它从头到尾只有「正在建立安全隧道。」一句不变的话——用户判断不了卡在哪一步。
	 * 用 evaluateJavascript 只改文本节点、【不重新导航】，因此不碰 T22 的失败窗口与
	 * 失败标记时序；且带 data-state==='connecting' 守卫，失败壳/会话页都不会被改。
	 */
	private void setShellStage(final String text) {
		setTunnelState(text);
		if (webView == null) return;
		runOnUiThread(() -> {
			if (webView == null || uiState != UiState.CONNECTING) return;
			String js = "(function(){try{var b=document.body;var p=document.querySelector('main p');"
				+ "if(p&&b&&b.getAttribute('data-state')==='connecting'){p.textContent="
				+ jsStringLiteral(text) + ";}}catch(e){}})()";
			try {
				webView.evaluateJavascript(js, null);
			} catch (Exception ignored) {
			}
		});
	}

	/** 把字符串安全地编成 JS 字面量（阶段文案含全角省略号与括号，不做转义会拼坏脚本）。 */
	private static String jsStringLiteral(String value) {
		StringBuilder sb = new StringBuilder(value.length() + 8);
		sb.append('"');
		for (int i = 0; i < value.length(); i++) {
			char c = value.charAt(i);
			if (c == '"' || c == '\\') sb.append('\\').append(c);
			else if (c == '\n') sb.append("\\n");
			else if (c == '\r') sb.append("\\r");
			else if (c < 0x20) sb.append(String.format(Locale.US, "\\u%04x", (int) c));
			else sb.append(c);
		}
		return sb.append('"').toString();
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
		openGateway(url, "");
	}

	/**
	 * @param profileId 本次连接的配置组 id；直连/局域网节点传空串。
	 *                   T23-A：证书锁定按配置档身份比对，只有隧道路径才带得进去。
	 */
	private void openGateway(String url, String profileId) {
		connectionGeneration += 1;
		sessionHistoryRooted = false;
		submittedHttpAuthThisConnection.clear();
		final String target = url.trim();
		activeProfileId = profileId == null ? "" : profileId;
		// T49：记下本轮网关的 host/port，供 ServiceWorkerClient 的可信取数通道限定范围。
		Uri targetUri = Uri.parse(target);
		activeGatewayHost = targetUri.getHost() == null ? "" : targetUri.getHost();
		activeGatewayPort = targetUri.getPort() == -1
			? ("http".equals(targetUri.getScheme()) ? 80 : 443)
			: targetUri.getPort();
		connectStartMs = System.currentTimeMillis();
		// T60：一轮新连接尝试 = PinnedFetch 全部计数器的唯一清零点。
		// 这样「首连（全部子资源都要走可信链）」与「二次进入（warm、几乎 0 传输）」
		// 的差别能直接在这行诊断里读出来，不用去翻 logcat。
		PinnedFetch.resetStats();
		// T65：落盘缓存与「未拦」计数器同一零点（同一行注释的理由）。
		StaticDiskCache.resetStats();
		passthroughMainDoc.set(0);
		passthroughApi.set(0);
		passthroughOther.set(0);
		passthroughNonGet.set(0);
		passthroughOrigin.set(0);
		// 一轮新的连接尝试 = 失败标记的唯一清零点。「重新连接」也走这里，故
		// 重试不会被上一轮的失败标记挡住；而同一次尝试内 showGatewayFailure 换出的
		// 失败壳不得清它，否则紧随的 onPageFinished 又会把错误页判成会话页。
		failedMainFrameUrl = "";
		Log.i("dshr-perf", "openGateway t+0ms target=" + target);
		// T23-B：这一步起就把状态标签推进到「正在打开 DSH 页面…」。改前这里不动标签，
		// 屏幕上会一直留着上一阶段的「隧道启动中（…3~10 秒）…」，直到 enterSession 才被
		// 覆盖成「隧道运行中」——用户看到的过期文案正是「卡住了」的来源。
		setTunnelState("正在打开 DSH 页面…（验证网关与设备授权）");
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
		// T27-B：一轮新的连接尝试 = 自检重排预算的起点（滚动窗口也要显式归零，
		// 否则上一轮的重定向风暴会把紧接着的「重新连接」也挡在窗口外）。
		adaptProbeArms = 0;
		adaptProbeWindowStartMs = 0L;
		lastAdaptProbeArmMs = 0L;
		adaptProbeCapLogged = false;
		webView.post(() -> {
			if (uiState == UiState.CONNECTING && target.equals(activeUrl)) webView.loadUrl(target);
		});
	}

	private SharedPreferences prefs() {
		return getSharedPreferences(PREFS, MODE_PRIVATE);
	}

	// ---------- WebView ----------

	// ---------- Service Worker（T49）----------

	/** SW 脚本在网关侧的路径（与 pwa.ts 的 SW_PATH、server.ts 路由同名）。 */
	private static final String SW_SCRIPT_PATH = "/__dsh_remote__/sw.js";
	/** res/raw/dsh_sw.js 的字节缓存（只读一次；SW 源码随 APK 发布，运行期不变）。 */
	private static volatile byte[] swScriptBytes;

	/**
	 * 用本地资源供给 Service Worker 脚本。
	 *
	 * 为什么必须有这一步（T45 §2/§4 实测，勿删）：WebView 的 SW 脚本抓取由
	 * **浏览器进程的 ServiceWorker 子系统**发起，不经过 WebViewClient，因此
	 * {@code onReceivedSslError → handler.proceed()} 放行不到它。网关用的是自签
	 * 证书 ⇒ 这条抓取必然死在证书校验上：
	 * {@code SecurityError: An SSL certificate error occurred when fetching the script.}
	 * （同一个 URL 用页面 fetch/XHR 拿得到 200，因为那两条走 WebViewClient。）
	 *
	 * 做法：ServiceWorkerClient.shouldInterceptRequest 命中该路径时，从 APK 的
	 * res/raw/dsh_sw.js 返回。**脚本不经网络 ⇒ 证书不参与 ⇒ pin/TOFU 一行不改**
	 * —— 刻意**不**把自签根装成受信任锚：那会让 onReceivedSslError 不再触发，
	 * CertPin 的 TOFU 与「证书已变更！」告警整条失效（T45 §6.2 已判定不推荐）。
	 *
	 * 其余请求一律返回 null 走原路径，SW 对我们 fetch 的代理行为完全不变。
	 */
	/**
	 * R7（T53）：判定「这个请求是不是 SW 脚本本身」。
	 *
	 * 原来写的是 {@code url.contains(SW_SCRIPT_PATH)} —— **子串**判定。任何路径里
	 * 恰好含有这段文字的请求都会被当成本地 SW 脚本供给，例如
	 * {@code /plugins/x/__dsh_remote__/sw.js}、{@code /__dsh_remote__/sw.js.bak}、
	 * 甚至 query 里带这段文字的普通资源。那会把**别的响应体**当 SW 脚本回给
	 * ServiceWorker 子系统（内容不是 SW 就注册失败，且日志写着"本地供给"极具误导性）。
	 *
	 * 改成**路径精确匹配**：只认 pathname 恰好等于 {@link #SW_SCRIPT_PATH} 的请求。
	 * query（{@code ?v=…}）不影响判定 —— SW 脚本 URL 带 query 也仍是同一个脚本。
	 * Uri 解析不了就退化成"去掉 query 后的字符串等于 SW_SCRIPT_PATH"，宁可放过、
	 * 也不误判（放过的后果只是回落到网络路径，与改动前一致）。
	 */
	private static boolean isSwScriptRequest(String url) {
		if (url == null) return false;
		try {
			String path = Uri.parse(url).getPath();
			if (path != null) return SW_SCRIPT_PATH.equals(path);
		} catch (Throwable ignoredParse) { /* URL 解析不了：走下面的退化判定 */ }
		int cut = url.indexOf('?');
		return SW_SCRIPT_PATH.equals(cut >= 0 ? url.substring(0, cut) : url);
	}

	private void installServiceWorkerClient() {
		try {
			ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
				@Override
				public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
					// 回调在**后台线程**：只做字符串判定 + 读已缓存字节，绝不碰 UI。
					if (request == null || request.getUrl() == null) return null;
					String url = request.getUrl().toString();
					if (isSwScriptRequest(url)) {
						byte[] body = loadSwScript();
						if (body == null) {
							// 本地没有就放行网络（回到改动前的行为，只是 SW 装不上）。
							Log.w("dshr-perf", "swIntercept 命中但本地 SW 源码缺失，放行网络 url=" + url);
							return null;
						}
						Log.i("dshr-perf", "swIntercept 本地供给 SW 脚本 bytes=" + body.length + " url=" + url);
						// 头必须与网关 /__dsh_remote__/sw.js 一致：Service-Worker-Allowed
						// 决定 scope 能否扩到 "/"（脚本在 /__dsh_remote__/ 下，默认 scope
						// 只有该目录，页面注册用的正是 scope:"/"）。
						Map<String, String> headers = new HashMap<String, String>();
						headers.put("Content-Type", "text/javascript; charset=utf-8");
						headers.put("Service-Worker-Allowed", "/");
						headers.put("Cache-Control", "no-cache");
						headers.put("X-Content-Type-Options", "nosniff");
						return new WebResourceResponse("text/javascript", "utf-8", 200, "OK", headers,
							new ByteArrayInputStream(body));
					}
					// T49：SW 的**子资源** fetch 同样不经 WebViewClient、同样拿不到
					// proceed() 放行（实测全部 TypeError: Failed to fetch，见 PinnedFetch
					// 类注释）。它填不满自己的缓存 ⇒ 页面 net::ERR_FAILED 白屏。
					// 这里改由 App 用**已锁定的指纹**自己取（只复用主框架 TOFU 弹窗已经
					// 落盘的那把锁；未信任/已变更一律不放行）。
					WebResourceResponse fetched = fetchForServiceWorker(url);
					if (fetched != null) return fetched;
					Log.i("dshr-perf", "swIntercept passthrough url=" + url);
					return null;
				}
			});
			Log.i("dshr-perf", "ServiceWorkerClient 已装（SW 脚本本地供给 " + SW_SCRIPT_PATH + "）");
		} catch (Throwable t) {
			// 装不上只是退回「SW 不生效」，页面照常用 —— 不能因此崩。
			Log.w("dshr-perf", "ServiceWorkerClient 安装失败（SW 将不可用）：" + t);
		}
	}

	/**
	/**
	 * SW 子资源的可信取数（见 PinnedFetch 类注释：这是 SW 唯一能拿到字节的路）。
	 * 只处理**当前网关**自己的 host:port，别的一律放行。返回 null = 放行原路径。
	 * 回调在后台线程，阻塞取数是允许的（SW 本来就在等这次响应）。
	 *
	 * <p><b>T65</b>：这一条通道会**先查 App 私有目录的落盘缓存**。原因见
	 * {@link #interceptStaticAsset} 的注释——SW 一旦激活就接管全部子资源，
	 * {@code WebViewClient.shouldInterceptRequest} 根本不会被调用；只改 WebViewClient
	 * 那一侧的话，落盘写进去了却**永远读不到**，「第二次进入」仍要全量重下。
	 * 两条通道共用同一个 {@link StaticDiskCache}，所以首屏那份字节在哪条路上被要，
	 * 都在另一条路上命中。
	 */
	private WebResourceResponse fetchForServiceWorker(String url) {
		String host = activeGatewayHost;
		int port = activeGatewayPort;
		if (host.isEmpty() || port <= 0) return null;
		Uri uri = Uri.parse(url);
		if (!"https".equals(uri.getScheme())) return null;
		String reqHost = uri.getHost() == null ? "" : uri.getHost();
		int reqPort = uri.getPort() == -1 ? 443 : uri.getPort();
		if (!host.equalsIgnoreCase(reqHost) || port != reqPort) return null;

		// T65：只有白名单静态资源才查盘。/api/*、/favicon.svg、SW 脚本等照旧走可信链取数。
		if (isStaticCachePath(uri.getPath() == null ? "" : uri.getPath())) {
			StaticDiskCache.Hit hit = StaticDiskCache.get(staticCacheDir(), url);
			if (hit != null) {
				Log.i("dshr-perf", "swIntercept 落盘命中 bytes=" + hit.body.length + " url=" + url);
				// 这里**不能**用 no-store：SW 正是靠 cache-control 决定要不要
				// 把这条响应写进自己的 CacheStorage，抹掉会让该缓存的不缓存。
				return webResourceResponse(hit.contentType, hit.cacheControl, hit.body, false);
			}
			PinnedFetch.Result r = PinnedFetch.get(url, host, port, activeProfileId, certPinStore(), "sw");
			if (r == null) return null;
			StaticDiskCache.noteFetched(r.body.length);
			StaticDiskCache.put(staticCacheDir(), url, r.body, r.contentType, r.cacheControl);
			Map<String, String> h = new HashMap<String, String>();
			if (r.contentType != null) h.put("Content-Type", r.contentType);
			if (r.cacheControl != null) h.put("Cache-Control", r.cacheControl);
			Log.i("dshr-perf", "swIntercept 可信链供给子资源 bytes=" + r.body.length
				+ " mime=" + r.contentType + " url=" + url);
			return webResourceResponse(r.contentType, r.cacheControl, r.body, false);
		}

		PinnedFetch.Result r = PinnedFetch.get(url, host, port, activeProfileId, certPinStore(), "sw");
		if (r == null) return null;
		Log.i("dshr-perf", "swIntercept 可信链供给子资源 bytes=" + r.body.length
			+ " mime=" + r.contentType + " url=" + url);
		return webResourceResponse(r.contentType, r.cacheControl, r.body, false);
	}

	// ───────────────────── T65：首屏静态资源落盘（WebViewClient 侧） ─────────────────────

	/**
	 * T65 静态白名单：<b>只有这两个前缀</b>的 GET 会被接管。
	 *
	 * <p>与浏览器侧 {@code pwa.ts} 的白名单同源但**更窄**：那边是
	 * 「扩展名正则 + {@code /plugins/}」，这边只用两个前缀。理由是这一条通道
	 * 走的是 {@link PinnedFetch}（每条都要过证书 pin 与并发闸门），把判据收到
	 * 「构建产物只有这两个目录」这种程度，比维护一份正则更不容易漂。
	 *
	 * <p>刻意**不**包含：{@code /}（主文档，必须永远新鲜——它是唯一说出新版资源 URL 的地方，
	 * 见 {@code pwa.ts} 的 T63 注释）、{@code /api/*}（动态面：认证/配对/会话列表/工作区）、
	 * {@code /__dsh_remote__/*}（App 本地供给的 SW 脚本，不经网络）、
	 * {@code /favicon.svg} 等其余路径（数量小、不在首屏关键路径上，交给浏览器侧缓存）。
	 */
	private static final String[] STATIC_CACHE_PREFIXES = {"/assets/", "/plugins/"};

	/** 落盘目录名（相对 {@code getFilesDir()}）。 */
	private static final String STATIC_CACHE_DIR = "static-cache";

	private File staticCacheDir;
	// 放行计数器：用来**证明**没拦到不该拦的东西（验收项 4）。非白名单一律回 0。
	private final java.util.concurrent.atomic.AtomicInteger passthroughMainDoc =
		new java.util.concurrent.atomic.AtomicInteger();
	private final java.util.concurrent.atomic.AtomicInteger passthroughApi =
		new java.util.concurrent.atomic.AtomicInteger();
	private final java.util.concurrent.atomic.AtomicInteger passthroughOther =
		new java.util.concurrent.atomic.AtomicInteger();
	private final java.util.concurrent.atomic.AtomicInteger passthroughNonGet =
		new java.util.concurrent.atomic.AtomicInteger();
	private final java.util.concurrent.atomic.AtomicInteger passthroughOrigin =
		new java.util.concurrent.atomic.AtomicInteger();

	private File staticCacheDir() {
		if (staticCacheDir == null) {
			File d = new File(getFilesDir(), STATIC_CACHE_DIR);
			if (!d.isDirectory()) //noinspection ResultOfMethodCallIgnored
				d.mkdirs();
			staticCacheDir = d;
		}
		return staticCacheDir;
	}

	/** 设置页那行只读诊断里的放行计数（纯展示，无点击）。 */
	private String staticPassthroughSummary() {
		return "未拦 主文档 " + passthroughMainDoc.get() + " · /api " + passthroughApi.get()
			+ " · 非白名单 " + passthroughOther.get() + " · 非GET " + passthroughNonGet.get()
			+ " · 非本网关 " + passthroughOrigin.get();
	}

	/**
	 * T65 主逻辑。返回 {@code null} = **放行**，交回 WebView 自己的网络栈
	 * （与改动前逐字节同构）。
	 *
	 * <p>顺序刻意是「便宜的判定在前」：方法 → 主框架 → origin → 路径白名单。
	 * 前三道任何一道不过就记账并放行，<b>绝不</b>因为判据拿不准就去猜。
	 *
	 * <p>WS 升级：{@code shouldInterceptRequest} 只对 http(s) 子资源回调，
	 * 且 WS 走的是 {@code Upgrade:} 握手而非 GET；即便将来有非 GET 进来，
	 * {@code passthroughNonGet} 那道也先把它放行了。
	 */
	private WebResourceResponse interceptStaticAsset(WebResourceRequest request) {
		if (request == null || request.getUrl() == null) return null;
		Uri uri = request.getUrl();
		String path = uri.getPath() == null ? "" : uri.getPath();

		// ① 只 GET。POST/PUT/HEAD 一律放行。
		if (!"GET".equalsIgnoreCase(request.getMethod())) {
			passthroughNonGet.incrementAndGet();
			return null;
		}
		// ② 主框架（主文档）永不落盘：它必须永远新鲜。
		if (request.isForMainFrame()) {
			passthroughMainDoc.incrementAndGet();
			return null;
		}
		// ③ 只当前网关自己的 origin，且只 https（PinnedFetch 只走 HttpsURLConnection）。
		String host = activeGatewayHost;
		int port = activeGatewayPort;
		if (host.isEmpty() || port <= 0 || !"https".equals(uri.getScheme())) {
			passthroughOrigin.incrementAndGet();
			return null;
		}
		String reqHost = uri.getHost() == null ? "" : uri.getHost();
		int reqPort = uri.getPort() == -1 ? 443 : uri.getPort();
		if (!host.equalsIgnoreCase(reqHost) || port != reqPort) {
			passthroughOrigin.incrementAndGet();
			return null;
		}
		// ④ 动态面与 SW 脚本：显式记账后放行（验收要看到 /api 计数为 0 拦截）。
		if (path.startsWith("/api/") || path.startsWith("/__dsh_remote__/")) {
			passthroughApi.incrementAndGet();
			return null;
		}
		// ⑤ 静态白名单（两个前缀）。
		if (!isStaticCachePath(path)) {
			passthroughOther.incrementAndGet();
			return null;
		}

		// ---- 到这里才接管 ----
		final String url = uri.toString();
		File dir = staticCacheDir();
		// 命中：直接回盘上字节（0 传输）。这正是把「第二次进入」从 ~6.2 MB 打到 ≈0 的那一步。
		StaticDiskCache.Hit hit = StaticDiskCache.get(dir, url);
		if (hit != null) {
			Log.i("dshr-perf", "静态落盘 命中 bytes=" + hit.body.length + " url=" + url);
			return webResourceResponse(hit.contentType, hit.cacheControl, hit.body, true);
		}
		// 未命中：用**既有** PinnedFetch 取（复用它的 MAX_INFLIGHT 闸门、32 MB 硬顶、
		// 45 s 总量预算与证书 pin 语义），落盘再返回。
		PinnedFetch.Result r = PinnedFetch.get(url, host, port, activeProfileId, certPinStore(), "page");
		if (r == null) {
			// 取不到（未信任/已变更/超时）⇒ 放行，行为与改动前一致。
			return null;
		}
		StaticDiskCache.noteFetched(r.body.length);
		StaticDiskCache.put(dir, url, r.body, r.contentType, r.cacheControl);
		Log.i("dshr-perf", "静态落盘 取回并落盘 bytes=" + r.body.length + " mime=" + r.contentType
			+ " url=" + url);
		return webResourceResponse(r.contentType, r.cacheControl, r.body, true);
	}

	/** T65 静态白名单判定（两个前缀）。WebViewClient 与 ServiceWorkerClient 两条通道共用。 */
	private static boolean isStaticCachePath(String path) {
		for (String p : STATIC_CACHE_PREFIXES) {
			if (path.startsWith(p)) return true;
		}
		return false;
	}

	/**
	 * 由**解压后**字节构造响应。
	 *
	 * <p>⚠️ 刻意<b>不</b>声明任何 {@code content-encoding}：{@link PinnedFetch} 已经
	 * 把 gzip/deflate 解掉了（{@code PinnedFetch.java:237-250}），再声明一次就是让
	 * WebView 对已解码字节再解一遍 ⇒ 垃圾内容。T60 已经在 SW 那条通道上踩过同一类坑。
	 *
	 * @param forceNoStore {@code true} = 走 WebViewClient 那一侧，本目录**就是**这条路
	 *                     径的缓存，让 WebView 的 HTTP 缓存再存一份只会变成第三份副本
	 *                     （自签证书下它本来也不落盘，T62 实测 {@code Cache_Data} 仅 32 KB），
	 *                     并且会把「第二次进入 ≈0 传输」这个结论搅浑。
	 *                     {@code false} = 走 ServiceWorkerClient 那一侧，<b>必须</b>透传
	 *                     原始 cache-control：SW 靠它决定「no-cache 响应不进缓存」，
	 *                     抹掉会让本该穿透的资源被缓存住（T49 原注释的理由，逐字保留）。
	 */
	private WebResourceResponse webResourceResponse(String contentType, String cacheControl,
			byte[] body, boolean forceNoStore) {
		String mime = "application/octet-stream";
		String enc = null;
		if (contentType != null) {
			String lower = contentType.toLowerCase(Locale.US);
			int semi = lower.indexOf(';');
			mime = (semi > 0 ? lower.substring(0, semi) : lower).trim();
			int cs = lower.indexOf("charset=");
			if (cs > 0) {
				enc = contentType.substring(cs + 8).trim();
				int sp = enc.indexOf(';');
				if (sp > 0) enc = enc.substring(0, sp).trim();
			}
		}
		Map<String, String> headers = new HashMap<String, String>();
		if (contentType != null) headers.put("Content-Type", contentType);
		if (forceNoStore) headers.put("Cache-Control", "no-store");
		else if (cacheControl != null) headers.put("Cache-Control", cacheControl);
		return new WebResourceResponse(mime, enc, 200, "OK", headers, new ByteArrayInputStream(body));
	}

	/** 指纹存储适配器：与 {@link #fetchForServiceWorker} 用的是同一把锁。 */
	private CertPin.Store certPinStore() {
		return new CertPin.Store() {
			@Override
			public String get(String key) {
				return prefs().getString(key, null);
			}
		};
	}

	/**
	 * 读 res/raw/dsh_sw.js。构建期由 android/sync-sw-asset.mjs 从
	 * packages/gateway/src/pwa.ts 的 renderServiceWorker() 渲染（单一源，禁止手改）。
	 * 用 openRawResource 而不是 getResourceAsStream("/raw/...")：后者依赖 aapt2
	 * 打包后保留的目录名，raw 的目录布局不是稳定契约。
	 */
	private byte[] loadSwScript() {
		byte[] cached = swScriptBytes;
		if (cached != null) return cached;
		InputStream in = null;
		try {
			in = getResources().openRawResource(R.raw.dsh_sw);
			ByteArrayOutputStream out = new ByteArrayOutputStream(8192);
			byte[] buf = new byte[8192];
			int n;
			while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
			cached = out.toByteArray();
			swScriptBytes = cached;
			return cached;
		} catch (Exception e) {
			Log.w("dshr-perf", "读取 res/raw/dsh_sw.js 失败：" + e);
			return null;
		} finally {
			if (in != null) {
				try { in.close(); } catch (IOException ignored) { }
			}
		}
	}

	// ---------- WebView ----------

	private void ensureWebView() {
		if (webView != null) return;
		// 测试期可观测性：仅当 APK 自身带 FLAG_DEBUGGABLE（即用 `build.ps1 -Debug`
		// 走 `aapt2 link --debug-mode` 产出的 dsh-remote-debug.apk）才打开 WebView
		// DevTools 协议，用于 adb forward + CDP 读页面真值（mobile hook 是否装上、
		// 挂在哪一步）。发布构建不带该 flag，故此分支永不成立——发布包不暴露调试口。
		// 严禁改成无条件开启：debuggable 的 WebView 任何本地应用都能接管调试。
		if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
			try {
				WebView.setWebContentsDebuggingEnabled(true);
				Log.i("dshr-perf", "WebView DevTools 已开启（debuggable 构建）");
			} catch (Exception e) {
				Log.w("dshr-perf", "开启 WebView DevTools 失败：" + e);
			}
		}
		// DayNight 包装让 WebView 的 prefers-color-scheme 跟随系统。
		Context webCtx = this;
		if (Build.VERSION.SDK_INT >= 29) {
			webCtx = new ContextThemeWrapper(this, android.R.style.Theme_DeviceDefault_DayNight);
		}
		webView = new WebView(webCtx);
		// 进程级全局态不随实例走：新建后按「当前是否在前台」把它归零——前台立刻钉回
		// 运行中，后台则交给 onResume 的无条件 resumeTimers（那才是结构不变量）。
		if (appInForeground) {
			try {
				webView.resumeTimers();
			} catch (Exception e) {
				Log.w("dshr-perf", "ensureWebView: resumeTimers 失败 " + e);
			}
		}
		webTimersPaused = false;
		Log.i("dshr-perf", "ensureWebView 新建 WebView：appInForeground=" + appInForeground
			+ "，进程级定时器标志归零");
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
			/**
			 * T65：首屏静态资源落盘。
			 *
			 * <p>回调在**后台线程**（不是 UI 线程），所以只做字符串判定 + 磁盘 IO +
			 * 可信取数，<b>绝不碰 UI</b>——与 {@code ServiceWorkerClient} 那条通道同一纪律。
			 *
			 * <p>范围被刻意收得很窄：<b>只</b>当前网关 origin + <b>只</b>静态白名单前缀
			 * + <b>只</b> GET。主文档、{@code /api/*}、WS 升级、非白名单路径一律
			 * {@code return null} 交回 WebView 自己的网络栈（计数见
			 * {@link #staticPassthroughSummary()}）。收窄的理由是 T49 踩过的坑：
			 * 「拦不拦截」与「用什么键存」是必须同批决定的一对，判宽了就会把
			 * 5 MB 大包喂给只想要 40 KB 的 {@code __ModuleLoader__.load()} ⇒ 白屏。
			 */
			@Override
			public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
				return interceptStaticAsset(request);
			}

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
			public void onPageStarted(WebView view, String url, Bitmap favicon) {
				// DIAG-30s：主帧导航提交点。首包慢（TLS/网关/上游）会体现在
				// openGateway→onPageStarted 的差值里。
				// T90：**页面级**数据源随文档一起重置 —— 上一页 hook 推来的连接态一律不许
				// 带到新文档（新文档的 hook 装好后会经 reportUiDiag 推一次当前状态）。
				hookConnState = null;
				// 这里【不】清 failedMainFrameUrl：主框架错误可能与 onPageStarted 同一
				// 毫秒到达（如 ERR_UNSAFE_PORT 实测两者同为 t+348ms），在这里清会把
				// 紧随其后的 onPageFinished 放行，错误页又会被当成会话页。
				// 失败标记只由 openGateway（新一轮连接）和「换 URL 进会话」清除。
				if (connectStartMs > 0 && isSessionUrl(url)) {
					Log.i("dshr-perf", "onPageStarted t+"
						+ (System.currentTimeMillis() - connectStartMs) + "ms url=" + url);
				}
			}

			@Override
			public void onPageFinished(WebView view, String url) {
				if (connectStartMs > 0 && isSessionUrl(url)) {
					Log.i("dshr-perf", "onPageFinished t+"
						+ (System.currentTimeMillis() - connectStartMs) + "ms url=" + url);
				}
				enterSessionPage(view, url);
				applyInsetsToPage(view);
			}

			@Override
			public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
				enterSessionPage(view, url);
			}

			@Override
			public void onPageCommitVisible(WebView view, String url) {
				// T78：新文档这一刻立即收起横幅并把防抖清零——上一页的"重新连接中"
				// 一律不许带到新页面（也不许把上一页累计的"连续为真"带过来）。
				hideReconnectBannerNow();
				if (Build.VERSION.SDK_INT >= 23) enterSessionPage(view, url);
			}

			@Override
			public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
				boolean mainFrame = request != null && request.isForMainFrame();
				if (mainFrame && error != null) {
					Log.w("dshr-perf", "mainFrame error code=" + error.getErrorCode()
						+ " desc=" + error.getDescription() + " url=" + request.getUrl());
				}
				if (awaitingCertificateDecision) return;
				if (!mainFrame) return;
				// 我们主动 stopLoading / 换壳造成的取消已被 isIgnorableWebError 滤掉，
				// 所以走到这里的主框架错误一定是真实失败——**不能再被错误抑制窗口吞掉**。
				// 原来的 1200ms 窗口比实测首个主框架错误的到达时间（t+89ms）长一个数量级，
				// 曾让整条失败反馈消失，用户只看到 Chromium 原始错误页（T16 缺陷 1）。
				// 窗口长度从此不再决定用户看到什么：主框架错误结构性绕过本标志。
				if (isIgnorableWebError(error)) return;
				suppressGatewayErrors = false;
				if (isActiveGatewayUri(request.getUrl())) {
					failedMainFrameUrl = request.getUrl().toString();
					showGatewayFailure("网络连接中断，请确认网关和隧道仍在运行。");
				}
			}

			@Override
			public void onReceivedHttpError(WebView view, WebResourceRequest request,
					WebResourceResponse response) {
				// DIAG-30s：主帧任何 HTTP 错误都打点（含 401——上游会话失效时主帧
				// 拿 401 纯文本、无自动重试，用户看到的就是"白屏卡住"）。
				if (request != null && request.isForMainFrame() && response != null) {
					Log.w("dshr-perf", "mainFrame httpError status=" + response.getStatusCode()
						+ " url=" + request.getUrl());
				}
				if (awaitingCertificateDecision || response == null
					|| request == null || !request.isForMainFrame()) return;
				if (response.getStatusCode() < 500 || !isActiveGatewayUri(request.getUrl())) return;
				// 同 onReceivedError：主框架 5xx 也不受错误抑制窗口影响。
				suppressGatewayErrors = false;
				failedMainFrameUrl = request.getUrl().toString();
				showGatewayFailure("网关已连接，但电脑上的 DSH Web 暂时不可用。");
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
					// T39 加固。createIntent() 只负责把页面 <input type=file> 的
					// action / acceptTypes / capture 意图翻成 Intent，**不保证带读授权**。
					// 原实现直接丢给 startActivityForResult ⇒ 拿到的 content:// URI
					// 我们可能压根没有读权限 ⇒ WebView 打开时 SecurityException ⇒
					// 页面拿到 0 字节 ⇒ 用户看到"选完什么都没多"，且全程零报错。
					// 这在 AOSP 上看不出来（AVD 上 txt 走通过），只在小米这类 OEM 选择器上炸。
					Intent chooser = params.createIntent();
					// ① 读授权：必须显式加。WebView 的 onReceiveValue(Uri[]) 在**本进程内**
					//    经 ContentResolver 打开 URI 再把字节交给渲染进程，所以这一条 grant
					//    就同时覆盖"我们的可读性自检"与"浏览器侧读取"两处。
					//    瞬时 grant 正好匹配用法（拿到立刻读），故**不**申请
					//    FLAG_GRANT_PERSISTABLE_URI_PERMISSION。
					chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
					// ② 多选：WebView 的 createIntent() 在部分 Android 版本上不带
					//    EXTRA_ALLOW_MULTIPLE，多选会静默降级成单选。按页面自己声明的
					//    mode 显式打开——页面写了 multiple 才开，不越权改页面语义。
					if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
						chooser.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
					}
					// ③ **不**换成 ACTION_OPEN_DOCUMENT + CATEGORY_OPENABLE：换 action
					//    会丢掉 input 上带 capture 时的 ACTION_IMAGE_CAPTURE 分支
					//    （WebView 只在 createIntent() 内部处理 capture，params 上没有
					//    对应的公开 getter，拿不到就没法在替换 action 时复现它），
					//    那是实打实的回归；而 PERSISTABLE grant 的唯一价值是
					//    "进程重启后仍可读"，我们的消费是即时的，付不出收益。
					//    故 action 保持 createIntent() 的原样，不动。
					// Intent 没有 hasFlags()（那是 API 34 才有的 setFlags 配套的读取扩展，
					// 框架未提供），这里直接按位与读回我们自己刚加的 flag。
					Log.i(TAG, "show mode=" + params.getMode()
						+ " accept=" + java.util.Arrays.toString(params.getAcceptTypes())
						+ " multiple=" + chooser.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
						+ " grantRead="
						+ ((chooser.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0)
						+ " action=" + chooser.getAction());
					startActivityForResult(chooser, REQ_FILE_CHOOSER);
					return true;
				} catch (ActivityNotFoundException e) {
					Log.w(TAG, "no activity for chooser: " + e);
					fileCallback = null;
					toast("没有可用的文件选择器：" + e.getClass().getSimpleName());
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
		installReconnectBanner();
	}

	/**
	 * T78：把原生重连横幅挂进根布局。
	 *
	 * <p>挂在 WebView **之后**（同级、z 序在上）、{@code layout_gravity=top}：
	 * 只叠与 WebView 无关的一条 View，页面侧零写入。初始 {@code GONE}——
	 * 不显示时既不占位、也不参与触摸派发。
	 */
	private void installReconnectBanner() {
		if (rootLayout == null || reconnectBanner != null) return;
		ReconnectBanner.Bar bar = new ReconnectBanner.Bar(this);
		bar.setId(R.id.dshrReconnectBanner);
		rootLayout.addView(bar, new FrameLayout.LayoutParams(
			FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP));
		reconnectBanner = bar;
		applyReconnectBannerInsets();
	}

	/**
	 * T78：系统栏/挖孔/任务栏的逐方向并集（px）。与 T72 平板让位**同一份取值**。
	 *
	 * <p>逐方向并集（T72 / T67 §6.1）。{@code getInsets(mask)} 对 mask 内各来源**逐边取 max**，
	 * 所以「状态栏在顶」与「状态栏/导航栏在左右」两种形态一次覆盖，不再有竖屏假设：
	 * <ul>
	 *   <li>{@code systemBars()} 状态栏 + 导航栏，四个方向都读（横屏落左右也拿得到）；</li>
	 *   <li>{@code displayCutout()} 挖孔（横屏在左右、竖屏在顶）；</li>
	 *   <li>{@code tappableElement()} 12L+ 任务栏：部分 ROM 把任务栏报成 tappableElement 而非
	 *       navigationBars，只认 navigationBars 时 bottom 会恒为 0。</li>
	 * </ul>
	 * 取 max 不求和 ⇒ 任务栏与状态栏同时存在时不会重复叠加。
	 * 注意 mask 里**不含 ime()**：键盘仍只由 applyImeShift 的 translationY 抬页处理。
	 *
	 * <p>API 24-29 无 taskbar，按四向取系统栏，**不用 getStableInsetBottom()**：
	 * stable 在栏隐藏时不收缩，导航栏一隐藏就多垫一块（方向相反的错位）。
	 */
	private int[] readSystemBarInsetsPx() {
		int[] out = systemBarInsetsPx;
		out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
		if (getWindow() == null) return out;
		WindowInsets insets = getWindow().getDecorView().getRootWindowInsets();
		if (insets == null) return out;
		if (Build.VERSION.SDK_INT >= 30) {
			Insets all = insets.getInsets(WindowInsets.Type.systemBars()
				| WindowInsets.Type.displayCutout()
				| WindowInsets.Type.tappableElement());
			out[0] = all.left; out[1] = all.top; out[2] = all.right; out[3] = all.bottom;
		} else {
			out[0] = insets.getSystemWindowInsetLeft();
			out[1] = insets.getSystemWindowInsetTop();
			out[2] = insets.getSystemWindowInsetRight();
			out[3] = insets.getSystemWindowInsetBottom();
			if (Build.VERSION.SDK_INT >= 28) {
				DisplayCutout cut = insets.getDisplayCutout();
				if (cut != null) {
					out[0] = Math.max(out[0], cut.getSafeInsetLeft());
					out[1] = Math.max(out[1], cut.getSafeInsetTop());
					out[2] = Math.max(out[2], cut.getSafeInsetRight());
					out[3] = Math.max(out[3], cut.getSafeInsetBottom());
				}
			}
		}
		return out;
	}

	/** T78：把系统栏 inset 作为外边距写给横幅 ⇒ 横幅顶边不低于系统栏底边（不压状态栏）。 */
	private void applyReconnectBannerInsets() {
		if (reconnectBanner == null) return;
		int[] i = readSystemBarInsetsPx();
		reconnectBanner.applySystemBarInsets(i[0], i[1], i[2], i[3]);
	}

	/** T78：启动重连状态轮询（幂等）。 */
	private void startReconnectPolling() {
		if (rootLayout == null || destroyed || reconnectPolling) return;
		reconnectPolling = true;
		rootLayout.removeCallbacks(reconnectPollTick);
		rootLayout.postDelayed(reconnectPollTick, ReconnectBanner.POLL_INTERVAL_MS);
	}

	/** T78：停止重连状态轮询（幂等）。 */
	private void stopReconnectPolling() {
		reconnectPolling = false;
		if (rootLayout != null) rootLayout.removeCallbacks(reconnectPollTick);
	}

	/**
	 * T78：轮询节拍。守卫照抄既有会话页判据（{@code uiState == WEB && webView 可见}）：
	 * 不满足即立即收起横幅并清零计数，不推进状态机。
	 */
	private final Runnable reconnectPollTick = new Runnable() {
		@Override
		public void run() {
			if (destroyed) return;
			pollReconnectOnce();
			if (reconnectPolling) rootLayout.postDelayed(this, ReconnectBanner.POLL_INTERVAL_MS);
		}
	};

	/**
	 * T78：跑一次只读探针。回调里的空值/异常**一律记 UNKNOWN**，既不显示也不累计。
	 *
	 * <p>T90：探针之外**再 OR 一路 hook 上报的状态**（见 {@link #hookConnState}）——
	 * 左栏收起时 DOM 探针恒探不到，rail 下的唯一信号是 hook 那条 WebSocket 观测。
	 */
	private void pollReconnectOnce() {
		if (destroyed) return;
		if (uiState != UiState.WEB || webView == null || webView.getVisibility() != View.VISIBLE) {
			hideReconnectBannerNow();
			return;
		}
		try {
			webView.evaluateJavascript(ReconnectBanner.PROBE_JS, this::handleReconnectProbe);
		} catch (Exception e) {
			handleReconnectProbe(null);
		}
	}

	/**
	 * T90：回前台**补读一次** hook 的连接态（只读、一次性，不是轮询）。
	 *
	 * <p>为什么需要：退后台时轮询停了，而且页面侧 {@code pauseTimers()} 会冻住 JS 定时器，
	 * 后台期间发生的连接态翻转未必推得过来 —— 回前台这一读保证横幅拿到的是当前值。
	 * 前台正常路径完全靠 hook 在状态翻转时**推**（{@code setUiDiag}）。
	 */
	private void refreshHookConnState() {
		if (webView == null || destroyed) return;
		try {
			webView.evaluateJavascript(
				"(function(){try{var b=window.__dshRemoteAndroidMobile;"
					+ "return b&&typeof b.wsStateNow==='function'?String(b.wsStateNow()):'';}catch(e){return '';}})()",
				value -> {
					if (destroyed) return;
					hookConnState = normaliseWsState(normaliseJsonString(value));
				});
		} catch (Exception ignored) { /* 读不到就不投票 */ }
	}

	/** T78：立即收起横幅并把防抖清零（onPageCommitVisible / 退后台 / 离开会话页）。 */
	private void hideReconnectBannerNow() {
		reconnectDebounce.reset();
		if (reconnectBanner != null) reconnectBanner.hideNow();
	}

	/**
	 * T78：消费一次探针结果。
	 *
	 * <p>{@code ok=0} / 空串 / {@code null} / 解析失败 ⇒ {@code UNKNOWN}（导航期静默，不累计）。
	 * 探针为真时再看**官方状态元素是否已经真的可见且不与横幅重叠**——是则抑制横幅，
	 * 同一条信息不显示两遍。
	 *
	 * <p>T90：观测值 = 探针结果 **OR** hook 上报的连接态（见下面那条判定）。
	 * 平板档 hook 严格 OFF ⇒ {@code hookConnState} 恒 null ⇒ 这一路完全不投票，
	 * 行为与 T90 之前逐字相同（平板仍是纯 DOM 探针）。
	 */
	private void handleReconnectProbe(String value) {
		if (destroyed || reconnectBanner == null) return;
		ReconnectBanner.Observed observed = ReconnectBanner.Observed.UNKNOWN;
		String detail = "";
		if (value != null && !value.isEmpty() && !"null".equals(value)) {
			try {
				JSONObject o = new JSONObject(value);
				if (o.optInt("ok", 0) == 1) {
					if (o.optInt("re", 0) != 1) {
						observed = ReconnectBanner.Observed.OK;
					} else {
						detail = officialStatusDetail(o);
						observed = detail.startsWith("SUPPRESS|")
							? ReconnectBanner.Observed.OK
							: ReconnectBanner.Observed.RECONNECTING;
					}
				}
			} catch (Exception e) {
				observed = ReconnectBanner.Observed.UNKNOWN;
			}
		}
		// T90：**两路 OR** —— 数据源 = hook 上报的连接态 ∪ 现有 DOM 探针。
		//   ① hook 说 reconnecting（且探针没这么说）⇒ 判重连。左栏收起（rail）时官方那条
		//      指示器不渲染、探针恒 re=0，这是唯一能让横幅出现的通道；
		//   ② 探针说 reconnecting ⇒ 照旧走它自己的抑制判定（几何 / tier 语义**未动**）；
		//   ③ hook 说 ok / ok-recovered ⇒ **不覆盖**探针的结论（wide 下探针能用元素级几何
		//      做抑制，比 hook 粗粒度状态更精确），也**不把 UNKNOWN 抬成 OK**
		//      （导航期静默不累计是既有语义，抬了就会把"连续为真/连续为假"跨页面累加）。
		if (hookConnState != null && "reconnecting".equals(hookConnState)
			&& observed != ReconnectBanner.Observed.RECONNECTING) {
			observed = ReconnectBanner.Observed.RECONNECTING;
			detail = (detail.isEmpty() ? "" : detail + " ") + "hook=reconnecting";
		}
		// 只在**日志去重键**变化时打一行，避免每 500ms 刷屏；这一行是设备侧"原生看到了什么"的唯一原始证据。
		// T86：键里除了观测值，还含**抑制判定**与**匹配层** —— 否则「官方那条可见且不重叠 ⇒ 抑制」
		// 这一步（observed 从 UNKNOWN/OK 到 OK 不变）在 logcat 里完全看不见，
		// 事后无法区分"没匹配上"与"按设计抑制了"。
		String key = probeLogKey(observed, detail);
		if (!key.equals(lastProbeKey)) {
			lastProbeKey = key;
			Log.i("dshr-reconnect", "probe=" + observed + " " + detail);
		}
		if (!reconnectDebounce.feed(observed)) return;
		if (reconnectDebounce.state() == ReconnectBanner.State.SHOWN) {
			reconnectBanner.show();
			Log.i("dshr-reconnect", "横幅显示（文案=" + ReconnectBanner.TEXT + "）");
		} else {
			reconnectBanner.hide();
			Log.i("dshr-reconnect", "横幅隐藏");
		}
	}

	/** T78/T86：上一次探针日志去重键，只为"变化时才打日志"。 */
	private String lastProbeKey = "";

	/**
	 * T86：探针日志的去重键 = 观测值 + **抑制判定** + **匹配层**。
	 *
	 * <p>为什么不能只用观测值：抑制（{@code SUPPRESS|…}）会被映射成 {@code Observed.OK}，
	 * 于是"官方那条本来就在视口里、横幅按设计让位"这一步的观测值跟前一次相同 ⇒ 不打日志 ⇒
	 * 现场只剩"没有横幅"，分不清是**没匹配上**还是**按设计抑制**。
	 *
	 * @param detail {@code officialStatusDetail} 的返回值，形如 {@code "SHOW|src=1 css=[…]"}；无匹配时为 {@code ""}
	 */
	private static String probeLogKey(ReconnectBanner.Observed observed, String detail) {
		if (detail == null || detail.isEmpty()) return observed.name();
		int bar = detail.indexOf('|');
		String verdict = bar < 0 ? detail : detail.substring(0, bar);
		String src = "";
		int at = detail.indexOf("src=");
		if (at >= 0) {
			int end = detail.indexOf(' ', at);
			src = end < 0 ? detail.substring(at) : detail.substring(at, end);
		}
		return observed.name() + "|" + verdict + "|" + src;
	}

	/**
	 * T78：官方那条重连文案是不是已经"用户看得见"（在视口内）且不与横幅**带区**重叠。
	 *
	 * <p>⚠️ 只有 {@code getClientRects().length > 0} 是不够的：侧栏用 {@code left:-320px}
	 * 收起时元素仍有布局盒、仍算"可见"（T68 §2.6 实测），但用户根本看不见。
	 * 探针回的是 CSS 像素矩形，这里按 WebView **实际内容宽度 / CSS 视口宽度**换算成设备像素
	 * （不用 density，缩放下才准），再与横幅在 rootLayout 里的矩形比对。
	 *
	 * <p><b>T86 缺口②</b>：比对对象从「横幅当前 rect」换成「横幅**将要占据的带区**」——
	 * 横幅 {@code GONE} 时 {@code getWidth()/getHeight()} 恒 0，拿它判重叠恒为「不重叠」，
	 * 于是只要探针能看见官方那条且在视口内就永远抑制，横幅**第一次显示不出来**（T83 §5 实测）。
	 * 带区 = 系统栏 top inset 起的整幅宽度 × 横幅高度
	 * （{@code ReconnectBanner.bandHeightPx}：已布局实高 &gt; 按内容测量 &gt; 40dp 兜底）。
	 *
	 * @return {@code "SUPPRESS|…"} 表示抑制横幅；{@code "SHOW|…"} 表示照常显示；
	 *         后缀是原始判据（进 logcat，便于事后对账）
	 */
	private String officialStatusDetail(JSONObject o) {
		if (webView == null || reconnectBanner == null) return "SHOW|no-webview";
		int vw = o.optInt("vw", 0);
		int vh = o.optInt("vh", 0);
		int webW = webView.getWidth();
		double cx = o.optDouble("x", 0);
		double cy = o.optDouble("y", 0);
		double cw = o.optDouble("w", 0);
		double ch = o.optDouble("h", 0);
		int[] ins = readSystemBarInsetsPx();
		int bandLeft = ins[0];
		int bandTop = ins[1];
		int rootW = rootLayout != null ? rootLayout.getWidth() : 0;
		int bandWidth = Math.max(0, (rootW > 0 ? rootW : webW) - ins[0] - ins[2]);
		int bandHeight = ReconnectBanner.bandHeightPx(reconnectBanner.getHeight(),
			reconnectBanner.measureContentHeight(),
			Math.round(ReconnectBanner.BAND_FALLBACK_DP * getResources().getDisplayMetrics().density));
		String raw = "src=" + o.optInt("src", 0)
			+ " css=[" + Math.round(cx) + "," + Math.round(cy) + ","
			+ Math.round(cw) + "," + Math.round(ch) + "] vp=" + vw + "x" + vh
			+ " band=[" + bandLeft + "," + bandTop + "," + bandWidth + "," + bandHeight + "]";
		if (vw <= 0 || vh <= 0 || webW <= 0) return "SHOW|" + raw + " reason=no-scale";
		double scale = (double) webW / (double) vw;
		int x = (int) Math.round(cx * scale);
		int y = (int) Math.round(cy * scale);
		int w = (int) Math.round(cw * scale);
		int h = (int) Math.round(ch * scale);
		boolean onScreen = ReconnectBanner.isOnScreen(
			(int) Math.round(cx), (int) Math.round(cy), (int) Math.round(cw), (int) Math.round(ch), vw, vh);
		// 页面内容原点 = WebView 在 rootLayout 里的左上角（T80 起让位走**外边距**，
		// 已体现在 getLeft/getTop 里）+ 自身 padding（恒 0，保留表达式以兼容历史形态）。
		int ox = webView.getLeft() + webView.getPaddingLeft() + x;
		int oy = webView.getTop() + webView.getPaddingTop() + y;
		boolean suppress = ReconnectBanner.shouldSuppress(onScreen, ox, oy, w, h,
			bandLeft, bandTop, bandLeft + bandWidth, bandHeight);
		return (suppress ? "SUPPRESS|" : "SHOW|") + raw + " device=[" + ox + "," + oy + "," + w + "," + h
			+ "] onScreen=" + onScreen;
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
			// 平板档的让位量直接取系统栏/挖孔，导航模式与横竖屏变化都要跟上。
			applyDeviceClassInsets();
			// T78：横幅的四向外边距与上面同一份取值（旋转/任务栏显隐/挖孔变化一起跟上）。
			applyReconnectBannerInsets();
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

	/**
	 * 设备档位的【唯一权威实现】（契约 3.1）：只看原生的 smallestScreenWidthDp，
	 * 不得在壳里改用 JS 视口宽度——部分机型 layout viewport 虚高（WEB-02 既有结论）。
	 * sw >= 600 → tablet（平板 / 折叠屏展开）；否则 phone。折叠/展开由系统改写
	 * Configuration，onConfigurationChanged 里重算即生效。
	 */
	private String deviceMode() {
		int sw = getResources().getConfiguration().smallestScreenWidthDp;
		return sw >= TABLET_SW_DP ? MODE_TABLET : MODE_PHONE;
	}

	private boolean isTabletClass() {
		return MODE_TABLET.equals(deviceMode());
	}

	/**
	 * 把原生判定的档位写进注入配置（契约 3.2 的 device 字段）。
	 * 必须排在注入 mobile.js 之前，否则 hook 首次执行读到的可能是旧值/空值。
	 * Object.assign 保留网关下发的 breakpoint。
	 */
	private void applyDeviceModeToPage(WebView view) {
		if (view == null) return;
		view.evaluateJavascript(
			"(function(){window.__DSHR_MOBILE__=Object.assign(window.__DSHR_MOBILE__||{},{device:'"
				+ deviceMode() + "'});})()",
			null);
	}

	/**
	 * 运行时切换（契约 3.3）：先写配置，再调 hook 暴露的幂等 API。
	 * 放在同一段脚本里，顺序天然确定；hook 未安装时该 API 只更新配置、不抛错。
	 * 折叠/展开与旋转都走这里——不重载 WebView、不碰隧道。
	 */
	private void syncDeviceModeToPage(WebView view) {
		if (view == null) return;
		String mode = deviceMode();
		view.evaluateJavascript(
			"(function(){window.__DSHR_MOBILE__=Object.assign(window.__DSHR_MOBILE__||{},{device:'" + mode
				+ "'});var s=window.__dshrSetDevice;if(typeof s==='function')s('" + mode + "');})()",
			null);
	}

	/**
	 * T27-B：清掉「半装」毒化守卫。
	 * mobile.js 的幂等守卫在 IIFE **第一行**就置位（__dshRemoteMobileInstalled），
	 * 而脚本末尾把样式挂进文档需要 documentElement 已存在（mobile-web.js:911
	 * 的 (document.head || document.documentElement).appendChild）。Page.reload 触发的
	 * onPageStarted 正好落在这个空档（实测抛
	 * 「TypeError: Cannot read properties of null (reading 'appendChild')」）：
	 * 守卫已置位、API 从未定义 ⇒ 此后**每一次**注入都是空操作，本文档再也装不上，
	 * 连自检第 1 轮的补注入也救不回来（实测 reload 后 hook 永久不收敛）。
	 * 这里只做一件事：发现「守卫已置位但 API 没定义」就清掉守卫，让下一次注入真正装上。
	 * 已正常装上的页面（API 存在）判 0、不动，零副作用。
	 * 耦合点：若日后 mobile.js 不再导出 __dshRemoteAndroidMobile，这里会误清守卫 →
	 * 变成「每次注入都重装」。改 mobile.js 的对外 API 时必须同步改这里。
	 */
	private static final String HOOK_STALE_GUARD_JS =
		"(function(){try{"
		+ "if(window.__dshRemoteMobileInstalled===true"
		+ "&&typeof window.__dshRemoteAndroidMobile==='undefined'){"
		+ "window.__dshRemoteMobileInstalled=false;return 1;}"
		+ "return 0;}catch(e){return -1;}})()";

	/**
	 * 注入移动适配脚本。所有注入点都必须经过这里，因此「先写档位配置」是结构性的：
	 * 配置写入、守卫自愈与脚本注入是同一个方法内相邻的三条 evaluateJavascript，
	 * 同线程按序执行，hook 首次执行时一定读得到正确档位。
	 */
	private void injectMobileAdaptation(WebView view) {
		applyDeviceModeToPage(view);
		view.evaluateJavascript(HOOK_STALE_GUARD_JS, null);
		view.evaluateJavascript(readMobileAdaptJs(), null);
	}

	/** T72：上次写入 WebView 的让位四向，只为让 dshr-inset 日志在变化时才打。 */
	private int lastAvoidL = -1, lastAvoidT = -1, lastAvoidR = -1, lastAvoidB = -1;

	/**
	 * 平板档位的系统栏让位（契约 3.6 / 验收 G5）：用 WebView 的**布局盒**（外边距）收缩内容视口，
	 * 官方布局拿到的是一个「本来就小一号」的视口——不写任何 DOM/CSS。
	 *
	 * <p><b>T80 起让位落「外边距」而不是「内边距」</b>：T79 在平板上抓到「原生账面 72/64 与
	 * dumpsys 逐值一致、页面却仍压进导航栏带 16px」，T80 做了决定性实验
	 * （把 top 让位从 72 放大到 372）：{@code webView.setPadding()} 让页面 {@code innerHeight}
	 * 仍为整屏 800、目标元素矩形逐字节不变、两张截图互相关最佳位移 **0px**；
	 * 而把同样的数字写到 WebView 的 {@code FrameLayout} 外边距上，
	 * 视口立刻变成 {@code (1600−72−64)/2 = 732}、内容恰好下移 72px（再加 300 就下移 300px）。
	 * 根因：内边距既不改 View 自身的测量尺寸、也不被 Chromium 用来推导渲染视口。
	 * 详见 {@link #setWebViewInsetsBox(int, int, int, int)} 与 {@code scratch/t80/report.md}。
	 *
	 * <p>手机档位恒为 0 让位，现有 edge-to-edge + --dshr-inset-* 透传完全不变；
	 * 本地壳页（uiState != WEB）自带同名 CSS 变量接收端，也不走这里，避免双重留白。
	 */
	private void applyDeviceClassInsets() {
		if (webView == null) return;
		boolean pad = isTabletClass() && uiState == UiState.WEB;
		if (!pad) {
			setWebViewInsetsBox(0, 0, 0, 0);
			return;
		}
		WindowInsets insets = getWindow().getDecorView().getRootWindowInsets();
		if (insets == null) {
			setWebViewInsetsBox(0, 0, 0, 0);
			return;
		}
		// T78：取值本体抽到 readSystemBarInsetsPx()，与重连横幅的四向外边距同源。
		// 语义与抽出来之前**逐值相同**（readSystemBarInsetsPx 的注释保留原 T72/T67 的逐方向并集依据）。
		int[] avoid = readSystemBarInsetsPx();
		int left = avoid[0], top = avoid[1], right = avoid[2], bottom = avoid[3];
		setWebViewInsetsBox(left, top, right, bottom);
		// T72：让位量本身**上 logcat**。T67 之所以只能做代码路径级证明、拿不到像素级证据，
		// 根因就是 padding 算完就丢、谁也看不见：这行日志让"系统栏占位 vs 应用留白"在真机上
		// 直接可对账（dshr-inset 标签）。只在平板会话档且四向变化时打，避免刷屏。
		if (pad && (left != lastAvoidL || top != lastAvoidT || right != lastAvoidR || bottom != lastAvoidB)) {
			lastAvoidL = left; lastAvoidT = top; lastAvoidR = right; lastAvoidB = bottom;
			Log.i("dshr-inset", "avoid l=" + left + " t=" + top + " r=" + right + " b=" + bottom
				+ " tablet=" + isTabletClass() + " uiState=" + uiState);
		}
	}

	/**
	 * T80：把让位四向写到 WebView 的**布局盒**（{@code FrameLayout} 外边距）上。唯一写入口。
	 *
	 * <p><b>为什么必须是布局盒</b>：外部测试两轮真机取证（T79 §4.1 / T80 §1）证明
	 * {@code webView.setPadding()} 对页面**完全无效**——padding 是 View **自己**的内边距，
	 * 父容器给 {@code MATCH_PARENT} 的是整屏，View 自身的测量尺寸一点没变，
	 * Chromium 也不拿它推导渲染视口。外边距则被父容器从 {@code MATCH_PARENT} 里扣掉
	 * ⇒ WebView 自身真的变小 ⇒ 页面拿到的就是「本来就小一号」的视口，且页面侧零写入。
	 *
	 * <p><b>不能与 setPadding 同时写</b>：两者都生效的设备上会叠加成双倍留白；
	 * 而 T80 已实测内边距既不改视口也不挪内容，留着只会误导下一个人。
	 *
	 * <p>幂等：四向未变时直接返回，不触发多余的 {@code requestLayout()}
	 * （{@code rootLayout} 上挂着 GlobalLayout 监听做 IME 兜底，无谓重排会把它拖成自激）。
	 */
	private void setWebViewInsetsBox(int left, int top, int right, int bottom) {
		if (webView == null) return;
		ViewGroup.LayoutParams raw = webView.getLayoutParams();
		FrameLayout.LayoutParams lp = (raw instanceof FrameLayout.LayoutParams)
			? (FrameLayout.LayoutParams) raw
			: new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
				FrameLayout.LayoutParams.MATCH_PARENT);
		if (lp.leftMargin == left && lp.topMargin == top
				&& lp.rightMargin == right && lp.bottomMargin == bottom) return;
		lp.setMargins(left, top, right, bottom);
		webView.setLayoutParams(lp);
	}

	/**
	 * {@code uiState} 的**唯一写入口**（T72）。
	 *
	 * <p><b>为什么必须收敛到这一个方法</b>：平板档的系统栏让位只有「重算 padding」这一个动作，
	 * 而 {@code webView.setVisibility(VISIBLE)} **不触发 insets 分发** ⇒ 冷启动 BOOTSTRAP 期
	 * 那次 insets 分发按门禁把 padding 写成 0 之后，**进入会话页这一刻没有任何新 insets 事件**
	 * 会把 padding 补上。T67 实测：4 条 {@code uiState→WEB} 路径里有 3 条各自记得补调，
	 * 唯独本地端口探测（FRP/隧道）那条没补 ⇒ 整会话 padding 恒 0，内容同时压状态栏、被任务栏盖住。
	 * 「每个调用点自己记得补」这种约定在 rc.2.1 到 rc.2.5 之间已经被证伪过一次。
	 *
	 * <p><b>结构上不可能再漏</b>：把赋值本身封进这个 setter，任何新的状态跃迁只要能编译通过，
	 * 就一定经过它；配合 {@code onResume} 的 post 兜底与 §4 的枚举式源码契约断言
	 * （枚举所有 {@code uiState = } 写入点、断言除本方法外没有第二个写入口），
	 * 「新增进会话路径漏调让位」从"靠人记得"变成"编译期 + 断言期双重兜住"。
	 */
	private void setUiState(UiState next) {
		uiState = next;
		applyDeviceClassInsets();
		if (next == UiState.WEB && webView != null) {
			// 冷启动首帧兜底：此刻 rootWindowInsets 可能还没分发/刚变（旋转、折叠、
			// 任务栏拉出都算），下一帧再算一次。setPadding 幂等，成本一次。
			webView.post(this::applyDeviceClassInsets);
		}
	}

	/**
	 * 「效果」判据脚本：一次性回读根类 / 鲸鱼 / 收敛 / 根元素全量 data-dshr-*。
	 * 全部包在 try 里，保证任何异常都以「未生效」呈现、绝不抛。
	 *
	 * **必须返回对象而不是 JSON 字符串**：evaluateJavascript 的回调拿到的是结果的
	 * JSON 编码——返回字符串会再被编码一层（外层带引号、内层引号被转义），
	 * 传给 new JSONObject() 会直接抛异常，把健康页面误判成「未生效」。
	 *
	 * 判据是【效果】而不是安装标志：hook 的 `window.__dshRemoteMobileInstalled`
	 * 在 mobile-web.js 的 IIFE 顶部（任何实际工作之前）就置位，拿它当判据在原理上
	 * 分不清「装上了」和「装上了但没生效」，于是「根类缺失 / 鲸鱼不可见」这类半吊子
	 * 状态会被判成健康、永远不补注（T16 缺陷 3 / T17 §0.D）。
	 * 鲸鱼判据与 hook 的 isVisible() 同源（getClientRects().length > 0）。
	 */
	private static final String ADAPT_EFFECT_JS =
		"(function(){try{"
		+ "var r=document.documentElement;"
		+ "var root=r.classList.contains('dshr-mobile');"
		+ "var w=document.getElementById('dshr-mobile-whale');"
		+ "var whale=!!(w&&w.getClientRects&&w.getClientRects().length>0);"
		// hook 主动收起鲸鱼的两个状态（右侧栏全屏 / Explorer 详情替换模式）不判为
		// 未生效：那两条 display:none!important 是 hook 自己打的，能读到这两个
		// data-dshr-* 就证明脚本已经跑过并写过痕迹。
		+ "var hidden=r.getAttribute('data-dshr-rightbar-fullscreen')==='1'"
		+ "||r.getAttribute('data-dshr-explorer-details')==='1';"
		+ "return {root:root,whale:whale,hidden:hidden,"
		+ "ready:r.getAttribute('data-dshr-ready')==='1',"
		+ "cls:r.className||'',href:(location&&location.href)||''};"
		+ "}catch(e){return {root:false,whale:false,hidden:false,err:String(e)};}})()";

	/** 自检轮数上限：有界重试，避免「永久不生效」时无限补注。 */
	private static final int ADAPT_PROBE_MAX_ROUNDS = 3;

	/** 首轮自检的延迟：留够时间让 DSH 前端起完再判「效果」。 */
	private static final long ADAPT_PROBE_FIRST_DELAY_MS = 6000L;

	/**
	 * T27-B：一次连接内「重排自检」的上限与节奏。
	 * 反例（独立对抗复核 §2.B）：reload / 会话内导航 / 回前台三条路径都绕过了
	 * scheduleAdaptationProbe（enterSessionPage 在 alreadyInSession 时提前 return），
	 * 于是页面一旦重载就再也无人补注——实测破坏效果 26.7s 未修复、自检日志 0 条。
	 * 现在这些路径都会重排，但**必须有界**，否则重定向循环会把自检排成永动机：
	 *   - 最小间隔 3s：一次导航会连着回调 onPageCommitVisible / doUpdateVisitedHistory /
	 *     onPageFinished 三个入口，不折叠就会把一次导航排成 3 次自检；
	 *   - 60s 滑动窗口内最多 4 次：重定向风暴下最多 4 次/分钟，不是无限。
	 * 平板档在 scheduleAdaptationProbe 里就返回（零痕迹，契约 3.5），不占预算。
	 */
	private static final long ADAPT_PROBE_MIN_INTERVAL_MS = 3000L;
	private static final long ADAPT_PROBE_ARM_WINDOW_MS = 60000L;
	private static final int ADAPT_PROBE_MAX_ARMS = 4;
	/** 本窗口内已排次数（滚动窗口，跨窗口归零）。 */
	private int adaptProbeArms = 0;
	private long adaptProbeWindowStartMs = 0L;
	private long lastAdaptProbeArmMs = 0L;
	private boolean adaptProbeCapLogged = false;

	/**
	 * 注入自检：页面加载数秒后确认移动适配**真的生效**了。
	 * 若始终未生效则退回实色状态栏模式——内容整体位于状态栏下方，绝不与系统栏重叠；
	 * 任何一轮生效就自动恢复透明状态栏沉浸模式。
	 *
	 * T27-B：除了首连窗口，**reload / 会话内导航 / 回前台**也会走到这里
	 * （那三条路径此前全部绕过，自检永不重排，页面一重载就再也无人补注）。
	 * 有界：最小间隔 ADAPT_PROBE_MIN_INTERVAL_MS 折叠一次导航的三个回调；
	 * ADAPT_PROBE_ARM_WINDOW_MS 窗口内最多 ADAPT_PROBE_MAX_ARMS 次（重定向风暴下
	 * 最多 4 次/分钟），不是永动机。
	 * 平板档**在这里就返回**：契约 3.5 要求零痕迹（无根类、无 data-dshr-*），
	 * 连定时器都不排——自检不得往页面写任何东西，跑它只会把平板模式搞坏。
	 */
	private void scheduleAdaptationProbe(WebView view) {
		if (view == null || isTabletClass()) return;
		long now = System.currentTimeMillis();
		if (now - lastAdaptProbeArmMs < ADAPT_PROBE_MIN_INTERVAL_MS) return;
		if (now - adaptProbeWindowStartMs > ADAPT_PROBE_ARM_WINDOW_MS) {
			adaptProbeWindowStartMs = now;
			adaptProbeArms = 0;
			adaptProbeCapLogged = false;
		}
		if (adaptProbeArms >= ADAPT_PROBE_MAX_ARMS) {
			if (!adaptProbeCapLogged) {
				adaptProbeCapLogged = true;
				Log.w("dshr-perf", "自检重排已达上限（" + ADAPT_PROBE_MAX_ARMS + " 次/"
					+ (ADAPT_PROBE_ARM_WINDOW_MS / 1000) + "s），本窗口内不再重排："
					+ "重新连接会恢复");
			}
			return;
		}
		adaptProbeArms += 1;
		lastAdaptProbeArmMs = now;
		Log.i("dshr-perf", "排自检（本连接第 " + adaptProbeArms + "/" + ADAPT_PROBE_MAX_ARMS
			+ " 次），延迟 " + ADAPT_PROBE_FIRST_DELAY_MS + "ms");
		view.postDelayed(() -> runAdaptationProbe(view, 1), ADAPT_PROBE_FIRST_DELAY_MS);
	}

	/**
	 * 第 round 轮「效果」自检。未达效果时：①先用不依赖 JS 定时器的同步修复入口
	 * （__dshRemoteAndroidMobile.syncViewport = applyWidthScope + syncDom，纯同步、
	 * 幂等、不重载页面）修一次；②第 1 轮再按既有策略补一次注入；③有界重试到
	 * ADAPT_PROBE_MAX_ROUNDS 轮为止。每一轮未达效果都打 dshr-perf 日志，绝不静默。
	 */
	private void runAdaptationProbe(final WebView view, final int round) {
		if (uiState != UiState.WEB || view.getVisibility() != View.VISIBLE) return;
		if (isTabletClass()) return;
		view.evaluateJavascript(ADAPT_EFFECT_JS, value -> {
			if (uiState != UiState.WEB || isTabletClass()) return;
			boolean effective = isAdaptationEffective(value);
			// 与原策略一致：未生效立即退回实色状态栏，后续任一轮生效就自动恢复沉浸。
			applySystemBarMode(effective);
			if (effective) return;
			Log.w("dshr-perf", "自检第 " + round + "/" + ADAPT_PROBE_MAX_ROUNDS
				+ " 轮：移动适配未生效 " + value);
			syncViewportNow(view);
			if (round == 1) {
				// 最后再补一次注入机会（hook 自带幂等守卫，已装上时是空操作）。
				injectMobileAdaptation(view);
				applyInsetsToPage(view);
			}
			if (round < ADAPT_PROBE_MAX_ROUNDS) {
				view.postDelayed(() -> runAdaptationProbe(view, round + 1), 2000);
			} else {
				Log.w("dshr-perf", "自检连续 " + ADAPT_PROBE_MAX_ROUNDS
					+ " 轮未生效，保持实色状态栏兜底：" + value);
			}
		});
	}

	/** 解析「效果」判据的返回值。任一字段缺失/解析失败一律判为未生效（保守）。 */
	private static boolean isAdaptationEffective(String json) {
		if (TextUtils.isEmpty(json)) return false;
		try {
			JSONObject o = new JSONObject(json);
			if (!o.optBoolean("root", false)) return false;
			return o.optBoolean("whale", false) || o.optBoolean("hidden", false);
		} catch (Exception e) {
			return false;
		}
	}

	/**
	 * 调 hook 暴露的同步修复入口（契约 3.3 的运行时切换同一入口）：
	 * syncViewport() = applyWidthScope() + syncDom()，纯同步、不吃 JS 定时器、幂等。
	 * hook 未装上时该属性不存在，判空在脚本里、静默跳过。
	 */
	private void syncViewportNow(WebView view) {
		if (view == null) return;
		try {
			view.evaluateJavascript(
				"(function(){var a=window.__dshRemoteAndroidMobile;"
				+ "if(a&&a.syncViewport)a.syncViewport();})()",
				null);
		} catch (Exception ignored) {
		}
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
			// 折叠/展开、旋转后按新档位即时生效（契约 3.1/3.3）：
			// 只改注入配置 + 调 hook 的幂等切换 API，绝不重载 WebView、绝不碰隧道。
			applyDeviceClassInsets();
			if (!isTabletClass()) {
				// 折回手机档时补一次注入：hook 在平板档可能整体早退，
				// 只靠 __dshrSetDevice 不保证脚本已装上（契约 3.3 的保守解读）。
				injectMobileAdaptation(webView);
			}
			syncDeviceModeToPage(webView);
			applyInsetsToPage(webView);
			syncViewportNow(webView);
			if (!isTabletClass()) {
				// 重新自检一次：档位切换不会触发页面加载，靠它把状态栏模式拉回正确值。
				scheduleAdaptationProbe(webView);
			}
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
		// 平板档位恒为沉浸态：hook 关闭、页面不知道自己拿的是「缩过」的视口，
		// 状态栏必须透明 + 让位，不能沿用手机档「注入失败退实色」的判定。
		boolean tabletSession = session && isTabletClass();
		boolean edge = !session || tabletSession || edgeToEdgeChrome;
		if (rootLayout != null) rootLayout.setBackgroundColor(session
			? (dark ? 0xFF141414 : Color.WHITE) : shellColor(R.color.shell_background));
		if (!session) {
			tintShell(homeScroll);
			tintShell(setupScroll);
		}
		// T80：平板档下状态栏/导航栏露出的是「让位外边距」那圈**父容器底色**（rootLayout 已钉成
		// 页面深浅色，见上），不再指望 WebView 自己的 padding 区；WebView 底色仍钉到页面深浅色，
		// 用来盖住页面首帧前的空白。
		if (tabletSession && webView != null) {
			webView.setBackgroundColor(dark ? 0xFF141414 : Color.WHITE);
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
		// 系统栏形态一变就同步平板档的 WebView 让位（导航模式切换/折叠都会走到这里）。
		applyDeviceClassInsets();
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
		// 错误页不是会话页：主框架失败后 Chromium 仍用【原 URL】回调这三个入口，
		// 若照常判成会话页就会 ①给错误页注入 hook、②置 uiState=WEB、③clearHistory()，
		// 于是之后所有网关失败被 showGatewayFailure 永久降级成 Toast、
		// 「重新连接」入口从此消失（T16 缺陷 2/3）。命中失败 URL 一律不进 WEB 态。
		if (!failedMainFrameUrl.isEmpty() && failedMainFrameUrl.equals(url)) {
			Log.w("dshr-perf", "跳过会话页判定（主框架失败后的错误页）：" + url);
			return;
		}
		// 换了 URL 就是另一个文档，重新拿到「未失败」的起点。
		failedMainFrameUrl = "";
		activeUrl = url;
		injectMobileAdaptation(view);
		if (uiState == UiState.HOME || uiState == UiState.EDIT) return;
		boolean alreadyInSession = uiState == UiState.WEB && sessionHistoryRooted;
		// DIAG-30s：首次进入会话=用户看到可用界面的时刻，total 减去前面各段
		// 即 DSH 前端启动+API 瀑布耗时。
		if (!alreadyInSession && connectStartMs > 0) {
			Log.i("dshr-perf", "enterSession t+"
				+ (System.currentTimeMillis() - connectStartMs) + "ms url=" + url);
		}
		hideSettings();
		setUiState(UiState.WEB);
		applySystemBars();
		if (webView != null && webView.getVisibility() != View.VISIBLE) {
			webView.setVisibility(View.VISIBLE);
		}
		if (alreadyInSession) {
			applyInsetsToPage(view);
			// T27-B：reload / 会话内导航此前在这里提前 return，自检再也排不上
			// （实测重载后破坏效果 26.7s 未修复、自检日志 0 条）。此处补排：
			// 页面刚重新加载，谁也不知道 hook 有没有收敛成功。
			scheduleAdaptationProbe(view);
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
		setUiState(UiState.WEB);
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

	/**
	 * 主动拆页（stopLoading / 换壳）时短暂抑制网关错误回调。
	 *
	 * 窗口从 1200ms 收紧到 400ms：它唯一需要覆盖的是「我们刚 stopLoading 的那次导航
	 * 被 Chromium 取消」产生的 ERR_ABORTED，而该回调就在同一个消息循环里送达，
	 * 400ms 已有大量余量。原来 1200ms 的窗口比实测首个主框架错误的到达时间（t+89ms）
	 * 长一个数量级，整条失败反馈被吞掉，用户只看到 Chromium 原始错误页（T16 缺陷 1）。
	 *
	 * 更重要的是窗口长度**不再决定用户看到什么**：主框架错误（onReceivedError 与
	 * 主框架 5xx）已在各自回调里结构性绕过本标志并先行清零，所以
	 * 「首个主框架错误必定到达 App 的失败壳」与本窗口取值无关。
	 */
	private void suppressGatewayErrorsBriefly() {
		suppressGatewayErrors = true;
		final int epoch = ++suppressGatewayEpoch;
		if (webView != null) {
			webView.postDelayed(() -> {
				if (epoch == suppressGatewayEpoch) suppressGatewayErrors = false;
			}, 400);
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
		// 活会话中途掉线只提示、不把用户从正在看的内容里拽走——这是有意设计。
		// 缺陷 3 的「永久降级成 Toast」发生在**连接阶段**：错误页曾被 enterSessionPage
		// 误判成会话页而置成 WEB（已由 failedMainFrameUrl 拦下），失败壳因此仍在，
		// 「重新连接」入口不丢。连接阶段不会进 WEB 态，故这里不会把首次失败吃掉。
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
	 * 自签证书固定：键按【配置档身份】存（cert_prof_&lt;profileId&gt;），地址键
	 * （cert_fp_&lt;host&gt;:&lt;port&gt;）**只**服务非配置档连接（直连/局域网节点）。
	 * 判定与写回全在 CertPin.verify 里（纯函数、可单测）；命中 → 直接放行；
	 * 变更 → 弹确认并强提示 MITM 风险，用户信任后记录指纹并重载
	 * （同一 handler 不能二次 proceed）。
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
		final String fp = fingerprint;
		// T23-A/T27-A：配置档身份优先，且**只**看该配置档自己的键——没有就 TOFU，
		// 不回退共享地址键（那是别的配置档/直连语境的信任，读它会误报证书已变更）。
		// 没有配置档身份（直连/局域网节点）时才走地址键；两处都没有才走 TOFU。
		final CertPin.Decision decision = CertPin.verify(
			key -> prefs().getString(key, null),
			activeProfileId, base.getHost(), effectivePort(base), base.getPort(), fp);
		final String key = decision.label;
		final String stored = decision.stored;
		final boolean changed = decision.action == CertPin.Action.CHANGED;
		if (decision.action == CertPin.Action.TRUSTED) {
			if (connectStartMs > 0) {
				Log.i("dshr-perf", "sslPinned t+"
					+ (System.currentTimeMillis() - connectStartMs) + "ms host=" + key);
			}
			handler.proceed();
			return;
		}
		Log.i("dshr-perf", "sslDecision host=" + key + " changed=" + changed
			+ " profile=" + (activeProfileId.isEmpty() ? "-" : activeProfileId)
			+ " " + decision.describe());
		awaitingCertificateDecision = true;
		handler.cancel();

		StringBuilder msg = new StringBuilder();
		msg.append(key).append("\n\n证书指纹 (SHA-256)\n").append(prettyFingerprint(fp));
		if (changed) {
			msg.insert(0, "警告：该地址的证书与上次记录不同！若不是你本人更换了网关或证书，请取消——这可能是一次中间人攻击。\n\n");
		}
		new AlertDialog.Builder(this)
			.setTitle(changed ? "证书已变更！" : (stored.isEmpty() ? "信任此服务器？" : "证书校验失败"))
			.setMessage(msg.toString())
			.setPositiveButton(changed ? "仍要更新信任" : "信任并继续", (dialog, which) -> {
				awaitingCertificateDecision = false;
				// 写回键与判定同源（CertPin 决定）：有配置档身份就只写配置档键，
				// 不再覆盖共享的地址键——否则会把另一个配置档的信任冲掉。
				prefs().edit().putString(decision.key, fp).apply();
				Log.i("dshr-perf", "证书信任已记录 " + decision.describe());
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
			// T23-A：配置档维度的锁定键也要一起清，否则「清除本机授权数据」会留下
			// 半套信任——地址键没了、配置档键还在，下一次连接照样直接放行。
			if (key.startsWith(KEY_CERT_PREFIX)
				|| key.startsWith(CertPin.PROFILE_PREFIX)
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
		if (requestCode == REQ_FILE_CHOOSER) {
			// 注意：**不**再要求 fileCallback != null 才处理。原来那个条件意味着
			// 回调已被清掉（重复弹选择器等）时结果被静默丢弃，诊断也无从谈起。
			ValueCallback<Uri[]> cb = fileCallback;
			fileCallback = null;
			if (cb != null) {
				// 解析 + 可读性自检 + 必要时复制进缓存都要读文件，2~5MB 的图片在
				// UI 线程上做足以 ANR。整段搬到后台线程，UI 线程只负责回填 callback。
				final Intent resultData = data;
				try {
					bgExecutor.execute(() -> resolveChooserResult(resultCode, resultData, cb));
				} catch (RejectedExecutionException e) {
					// 线程池已关（Activity 正在销毁）：只能当取消处理，但必须让页面
					// 的 file input 复位，否则页面会一直卡在"选择中"。
					Log.w(TAG, "chooser resolve rejected: " + e);
					cb.onReceiveValue(null);
					setChooserDiag("解析未执行：后台线程已关闭（Activity 正在销毁）");
				}
			} else {
				Log.w(TAG, "chooser result with no callback, resultCode=" + resultCode);
				setChooserDiag("结果回来了但回调已丢失（resultCode=" + resultCode + "）");
			}
			return;
		}
		super.onActivityResult(requestCode, resultCode, data);
	}

	// ---------- T39：文件选择器结果解析 / 可读性自检 / 兜底缓存 ----------

	/**
	 * T39：在后台线程上把选择器结果变成 {@code Uri[]}，并顺手做可读性自检。
	 * 全包 try/catch 绝不抛（一个异常就会让页面的 file input 永远复位不了），
	 * 任何一步失败都落到"给页面 null + 记诊断 + 必要时 Toast"这条有用户可见反馈的路上。
	 *
	 * <p>三级解析，覆盖两种已知的 OEM 失败模式：
	 * <ol>
	 *   <li>{@code FileChooserParams.parseResult(resultCode, data)} —— AOSP 正路。
	 *       AOSP 的实现内部就是 {@code data.getClipData()} 优先、否则
	 *       {@code data.getData()}；小米等 OEM 有时 RESULT_OK 但两者皆空，
	 *       于是这里返回 null/空数组。AVD 上 txt 走通过正是走的这一支。</li>
	 *   <li>parseResult 空 ⇒ 手工再取一遍 {@code getData()} 与 {@code getClipData()}，
	 *       把 OEM 只填 clipData、或 resultData 被中途清空的情况捞回来。</li>
	 *   <li>仍为空 ⇒ **不静默**：区分"用户按了取消"与"系统说成功却没给 URI"，
	 *       后者正是小米症状的指纹，给用户明确文案。</li>
	 * </ol>
	 */
	private void resolveChooserResult(int resultCode, Intent data, ValueCallback<Uri[]> cb) {
		Uri[] out = null;
		String diag;
		boolean needToast = false;
		String toastMsg = null;
		try {
			StringBuilder sb = new StringBuilder();
			sb.append("resultCode=").append(resultCode)
				.append(resultCode == RESULT_OK ? "(OK)" : "(非OK)")
				.append(" · data=").append(data == null ? "空" : "有");

			if (resultCode != RESULT_OK) {
				// 取消：这是**正常**路径（用户按了返回/取消），照 AOSP 语义回 null，
				// 但仍记一行，免得"取消"和"系统没给 URI"在诊断里长得一样。
				diag = sb.append(" · 判定=用户取消").toString();
			} else {
				int clipCount = data != null && data.getClipData() != null
					? data.getClipData().getItemCount() : 0;
				Uri single = data != null ? data.getData() : null;
				sb.append(" · clipData=").append(clipCount)
					.append(" · getData=").append(single == null ? "空" : shortUri(single));

				// 第 1 级：parseResult 正路。
				List<Uri> uris = new ArrayList<>();
				try {
					Uri[] parsed = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
					if (parsed != null) {
						for (Uri u : parsed) {
							if (u != null && !uris.contains(u)) uris.add(u);
						}
					}
				} catch (Throwable t) {
					sb.append(" · parseResult异常=").append(t.getClass().getSimpleName());
				}
				int fromParse = uris.size();

				// 第 2 级：parseResult 空 → 手工兜底 getData() / getClipData()。
				if (uris.isEmpty() && data != null) {
					if (single != null) uris.add(single);
					android.content.ClipData clip = data.getClipData();
					if (clip != null) {
						for (int k = 0; k < clip.getItemCount(); k++) {
							Uri cu = clip.getItemAt(k).getUri();
							if (cu != null && !uris.contains(cu)) uris.add(cu);
						}
					}
				}

				if (uris.isEmpty()) {
					// 第 3 级：全拿不到。RESULT_OK 却没 URI = 系统选择器的 bug，
					// 这就是"选完什么都不显示"最典型的指纹，必须让用户看见。
					diag = sb.append(" · 判定=成功但无URI").toString();
					Log.w(TAG, "RESULT_OK but no URI obtainable: " + diag);
					toastMsg = "文件已选中，但系统没有返回文件内容，请换一张再试";
					needToast = true;
				} else {
					StringBuilder per = new StringBuilder();
					int copied = 0, unreadable = 0;
					List<Uri> finalUris = new ArrayList<>();
					for (int i = 0; i < uris.size(); i++) {
						Uri u = uris.get(i);
						per.append(i == 0 ? "" : "；").append("#").append(i + 1)
							.append(" ").append(shortUri(u));
						Uri delivered = makeReadable(u, per);
						if (delivered == null) {
							// 彻底读不到：不把这个不可读的 URI 交给 WebView
							// （否则就是"0 字节静默"的老症状），记下来并计数。
							unreadable++;
						} else {
							if (!delivered.equals(u)) copied++;
							finalUris.add(delivered);
						}
					}
					int zeroBytes = countZeroBytes;
					countZeroBytes = 0;
					// 完整 URI（含文件名）只进 logcat：支持要定位"到底是哪个文件读不到"时用得上，
					// 而屏幕上那行是脱敏的（T41-F1）。
					Log.i(TAG, "picked uris(logcat only): " + uris + " · 交付=" + finalUris.size() + "/" + uris.size());
					if (finalUris.isEmpty()) {
						diag = sb.append(" · 判定=全部读不到").append(" · ").append(per).toString();
						toastMsg = "读不到所选文件（权限或文件已失效），请重选";
						needToast = true;
					} else {
						// 读不到几个也要说出来：远程用户只看这一行，
						// "选 3 张只上来 2 张"这种部分失败必须能被一眼看到。
						diag = sb.append(" · 判定=可用").append(" · parseResult=").append(fromParse)
							.append(" · 走缓存=").append(copied)
							.append(" · 空文件=").append(zeroBytes)
							.append(" · 读不到=").append(unreadable)
							.append(" · ").append(per).toString();
						if (copied > 0) {
							toastMsg = "已通过本地缓存读取 " + copied + " 个文件";
							needToast = true;
						}
					}
					out = finalUris.toArray(new Uri[0]);
				}
			}
		} catch (Throwable t) {
			// 兜底之兜底：绝不让异常逃出去卡住页面的 file input。
			Log.e(TAG, "resolve crashed", t);
			diag = "解析异常=" + t.getClass().getSimpleName() + "：" + t.getMessage();
			out = null;
			toastMsg = "选择文件时出错：" + t.getClass().getSimpleName();
			needToast = true;
		}

		setChooserDiag(diag == null ? "无结果" : diag);
		Log.i(TAG, "resolve done: " + chooserDiag);
		final Uri[] finalOut = out;
		final boolean toastIt = needToast;
		final String finalToast = toastMsg;
		runOnUiThread(() -> {
			try {
				cb.onReceiveValue(finalOut);
			} catch (Throwable t) {
				Log.e(TAG, "onReceiveValue threw", t);
			}
			if (toastIt && finalToast != null) toast(finalToast);
			refreshUiDiagLine();
		});
	}

	/**
	 * T39：供 {@link #makeReadable} 上报"读到 0 字节"用的线程内计数。
	 * 只有 {@code dshr-bg} 单线程执行器会碰它，故无需同步。
	 */
	private int countZeroBytes = 0;

	/**
	 * T39：把一个选择器 URI 变成"交给 WebView 一定读得到"的 URI，并顺带做可读性自检。
	 *
	 * <p>三条路径：
	 * <ol>
	 *   <li><b>能读且 &gt;0 字节</b>：原样返回。改动最小，也不占双份存储。</li>
	 *   <li><b>能读但 0 字节</b>：复制进私有缓存，由 {@link ChooserCacheProvider} 交付。
	 *       有些 OEM 选择器给的 URI 在我们这边打开就是一个空流，但 provider 侧其实有内容；
	 *       复制这一步顺带把"空"这件事和"读不到"区分开并记进诊断。</li>
	 *   <li><b>读不到</b>（SecurityException / FileNotFoundException / 其它）：先换
	 *       {@code openFileDescriptor} 再试一次（部分 provider 只实现了
	 *       openAssetFile，openInputStream 失败而 openFileDescriptor 能成）；
	 *       仍失败则记异常类名并返回 null —— 由调用方给用户可见反馈，
	 *       <b>绝不</b>把一个自己都读不到的 URI 交给 WebView 复现静默空附件。</li>
	 * </ol>
	 *
	 * @param diag 追加写诊断片段（每个 URI 的可读性与字节数都进这里）
	 * @return 可交给 WebView 的 URI；读不到时返回 null
	 */
	private Uri makeReadable(Uri uri, StringBuilder diag) {
		ContentResolver cr = getContentResolver();
		long bytes = -1L;
		String err = null;
		try (InputStream in = cr.openInputStream(uri)) {
			if (in == null) {
				err = "openInputStream返回空";
			} else {
				bytes = 0L;
				byte[] buf = new byte[16 * 1024];
				int n;
				while (bytes <= CHOOSER_PROBE_CAP
						&& (n = in.read(buf)) > 0) {
					bytes += n;
				}
			}
		} catch (Throwable t) {
			err = t.getClass().getSimpleName();
		}

		if (err == null && bytes > 0L) {
			diag.append(" 可读=").append(bytes).append("B");
			return uri;
		}

		// 走到这里：要么读不到（err != null），要么读到 0 字节。
		// 先换 openFileDescriptor 再试一次——部分 provider 只实现 openAssetFile。
		if (err != null) {
			ParcelFileDescriptor pfd = null;
			try {
				pfd = cr.openFileDescriptor(uri, "r");
				if (pfd != null) {
					android.os.ParcelFileDescriptor.AutoCloseInputStream ac =
						new android.os.ParcelFileDescriptor.AutoCloseInputStream(pfd);
					pfd = null; // 交给 ac 关闭
					byte[] buf = new byte[16 * 1024];
					int n;
					long total = 0L;
					while (total <= CHOOSER_PROBE_CAP && (n = ac.read(buf)) > 0) {
						total += n;
					}
					err = null;
					bytes = total;
				} else {
					err = "openFileDescriptor返回空";
				}
			} catch (Throwable t) {
				err = t.getClass().getSimpleName();
			} finally {
				if (pfd != null) {
					try { pfd.close(); } catch (Throwable ignored) { }
				}
			}
			if (err == null && bytes > 0L) {
				diag.append(" 可读(重试)=").append(bytes).append("B");
				return uri;
			}
		}

		if (err == null && bytes == 0L) {
			countZeroBytes++;
			diag.append(" 读到0字节");
		} else {
			diag.append(" 读不到=").append(err);
		}
		// 完整 URI 只进 logcat（T41-F1：屏幕那行只允许 scheme://authority）。
		Log.w(TAG, "not directly readable: " + uriForLog(uri) + " err=" + err + " bytes=" + bytes);

		// 兜底：复制进 App 私有缓存，再由 ChooserCacheProvider 交付。
		// 读不到时复制也会失败——这不是可以"绕过"的问题（我们没有别的途径拿到字节），
		// 所以失败就如实返回 null，让上层给用户可见反馈，而不是硬塞一个同样读不到的 URI。
		Uri cached = copyToChooserCache(uri, diag);
		if (cached != null) {
			diag.append(" →已缓存");
			return cached;
		}
		diag.append(" →缓存也失败");
		return null;
	}

	/**
	 * T39：把 URI 内容复制进 App 私有缓存目录，返回自研 provider 的 URI。
	 * 复制失败返回 null（不抛），由调用方决定如何反馈。
	 */
	private Uri copyToChooserCache(Uri src, StringBuilder diag) {
		File dir = null;
		File out = null;
		try {
			dir = ChooserCacheProvider.cacheDir(this);
			String name = displayNameOf(src);
			out = new File(dir, name);
			long total = 0L;
			try (InputStream in = getContentResolver().openInputStream(src);
				 OutputStream os = new FileOutputStream(out)) {
				if (in == null) {
					diag.append(" 缓存读空");
					return null;
				}
				byte[] buf = new byte[32 * 1024];
				int n;
				while ((n = in.read(buf)) > 0) {
					total += n;
					if (total > CHOOSER_CACHE_MAX) {
						diag.append(" 缓存超限");
						return null;
					}
					os.write(buf, 0, n);
				}
			}
			diag.append(" 缓存=").append(total).append("B");
			Log.i(TAG, "copied to chooser cache: " + out.getName() + " " + total + "B");
			return ChooserCacheProvider.uriFor(out);
		} catch (Throwable t) {
			diag.append(" 缓存异常=").append(t.getClass().getSimpleName());
			Log.w(TAG, "copy to chooser cache failed", t);
			if (out != null) { try { out.delete(); } catch (Throwable ignored) { } }
			return null;
		}
	}

	/**
	 * 取原始文件名。查不到（缺权限 / provider 不支持该列）时按"选择器-<时间戳>-<序号>"
	 * 生成一个**带扩展名**的名字：没有扩展名 ⇒ MIME 认不出 ⇒ WebView 可能当
	 * application/octet-stream 处理，页面就分不出这是图片。
	 */
	private String displayNameOf(Uri uri) {
		String fallbackExt = "";
		try {
			String mime = getContentResolver().getType(uri);
			if (mime != null) {
				int slash = mime.indexOf('/');
				if (slash > 0 && slash < mime.length() - 1) {
					fallbackExt = "." + mime.substring(slash + 1).toLowerCase(Locale.ROOT);
				}
			}
		} catch (Throwable ignored) { }
		String name = "";
		try (Cursor c = getContentResolver().query(uri,
				new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE},
				null, null, null)) {
			if (c != null && c.moveToFirst()) {
				int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
				if (i >= 0 && !c.isNull(i)) name = c.getString(i);
			}
		} catch (Throwable t) {
			Log.w(TAG, "display name query failed: " + t.getClass().getSimpleName());
		}
		if (TextUtils.isEmpty(name)) {
			name = "picker-" + System.currentTimeMillis() + fallbackExt;
		}
		// 缓存目录按单文件名寻址：去掉分隔符与 ..，保证 provider 侧的白名单校验能过。
		name = name.replace("/", "_").replace("\\", "_");
		while (name.contains("..")) name = name.replace("..", "_");
		if (name.isEmpty() || ".".equals(name) || "..".equals(name)) {
			name = "picker-" + System.currentTimeMillis() + fallbackExt;
		}
		return name;
	}

	/**
	 * 诊断用的短 URI：**只允许出现 {@code scheme://authority}**，其余一律脱敏。
	 *
	 * <p>T41-F1（T40 反例，F1）：旧实现是 {@code scheme://authority + "/…" + getLastPathSegment()}，
	 * 而 downloads / media provider 的 documentId 本身就是 {@code raw:<绝对路径>} ——
	 * T40 在 AVD 上实测，屏幕那行直接打出
	 * {@code raw:/storage/emulated/0/Download/normal.txt}（出现两次）。这行的设计用途恰恰是
	 * "远程用户截图发给支持"，等于把用户存储目录结构 + 完整文件名发出去。</p>
	 *
	 * <p>现在只补一个**稳定短标识**（同一 URI 恒等 ⇒ 支持仍能判断"是不是同一个文件"）
	 * 外加可选扩展名（够判断类型）。路径段、用户目录、文件名一律**不上屏**。
	 * 完整 URI 只留在 logcat（{@link #uriForLog}），那是本机排障口径、用户看不到。</p>
	 */
	private static String shortUri(Uri uri) {
		if (uri == null) return "空";
		String s = uri.getScheme() + "://" + uri.getAuthority();
		// 刻意**不**再补一个 "/"：authority 之后一个斜杠都不出现，"绝无路径"这句话
		// 才能被一条简单的断言钉住（scripts/test-device-class.mjs 的 T41 断言就查这一点）。
		return s + " [脱敏#" + redactedTagOf(uri) + "]";
	}

	/** logcat 专用：完整 URI 不上屏。T41-F1 要求脱敏的是"屏幕那行"，本地日志仍要能排障。 */
	private static String uriForLog(Uri uri) {
		return uri == null ? "空" : uri.toString();
	}

	/**
	 * 脱敏标识：{@code <8 位短哈希> [.<扩展名>]}（{@code 脱敏#} 与方括号由
	 * {@link #shortUri} 外面包，本方法只产出内容部分）。
	 *
	 * <p>扩展名**只**从 documentId 里最后一个 {@code /} 之后的那一段取，于是
	 * {@code raw:/a/Dir.v2/name} 这种"目录名带点"只会得到"无扩展名"，
	 * 不会把目录名片段误当扩展名漏出去；纯数字（{@code msf:1000000026} 这类 provider 内部 id）
	 * 一律不认，免得把 id 片段当扩展名上屏。</p>
	 */
	private static String redactedTagOf(Uri uri) {
		String ext = "";
		String seg = uri.getLastPathSegment();
		if (seg != null && !seg.isEmpty()) {
			int slash = seg.lastIndexOf('/');
			String tail = slash >= 0 ? seg.substring(slash + 1) : seg;
			int dot = tail.lastIndexOf('.');
			// 必须是"非首字符的最后一个点"：".gitignore" 与无扩展名都不产出。
			if (dot > 0 && dot < tail.length() - 1) {
				StringBuilder sb = new StringBuilder();
				for (int i = dot + 1; i < tail.length() && sb.length() < 8; i++) {
					char c = tail.charAt(i);
					if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
						sb.append(Character.toLowerCase(c));
					}
				}
				String cand = sb.toString();
				boolean hasLetter = false;
				for (int i = 0; i < cand.length(); i++) {
					char c = cand.charAt(i);
					if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) { hasLetter = true; break; }
				}
				if (hasLetter) ext = "." + cand;
			}
		}
		return shortHashOf(uri.toString()) + (ext.isEmpty() ? "" : " " + ext);
	}

	/** FNV-1a 32bit → 8 位十六进制。同一输入恒等，且不可逆回原文。 */
	private static String shortHashOf(String s) {
		int h = 0x811c9dc5;
		for (int i = 0; i < s.length(); i++) {
			h ^= s.charAt(i);
			h *= 0x01000193;
		}
		return String.format(Locale.ROOT, "%08x", h);
	}

	/**
	 * T39：T39 专用 Toast 助手。沿用既有风格（中文、`原因：异常类名` 句式、LENGTH_LONG），
	 * 不新增任何 UI 控件——"读不到文件"这种事必须让用户看见，但不值得为它加一个按钮。
	 */
	private void toast(String message) {
		if (destroyed) return;
		Toast.makeText(this, message, Toast.LENGTH_LONG).show();
	}

	/** 写文件选择器诊断行并刷新连接设置页那行只读诊断。 */
	private void setChooserDiag(String s) {
		chooserDiag = s == null ? "" : s;
		runOnUiThread(() -> refreshUiDiagLine());
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
				// D6.1：只有「本次由返回键路径进入设置」才退后台；其余入口
				// （通知动作 / 长按鲸鱼等）仍回会话。
				// 读取即消费：退后台前清零，标记不会带到下一次进入。
				// T65：去掉 `&& isTabletClass()`，两档同一判据（见 settingsViaBackKey 注释）。
				if (settingsViaBackKey) {
					settingsViaBackKey = false;
					moveTaskToBack(true);
					return;
				}
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
	 * 在会话根改为打开 App 连接设置（D6 ①，<b>两档一致</b>）；设置页再按一次才退到后台。
	 *
	 * <p>T65：改前 {@code if (isTabletClass())} 把「打开连接设置」限死在平板档，
	 * 手机档直接落到 {@code moveTaskToBack(true)} 退到桌面，与设置页文案承诺的
	 * 「系统返回键继续」不一致（T48/T58/T59 三轮复现）。平板档判据本身一字未改。
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
		// 走到这里就是「会话根」：上面已判定没有官方弹层要关（JS 回调没关掉任何东西）、
		// 没有侧栏要收（同一个回调）、WebView 也没有同网关的上一页可回。
		// D6 ①：不装移动 hook 的平板档页面上没有长按鲸鱼入口，这里是兜底；
		// 改为打开连接设置页；再按一次由 handleAppBack() 的 HOME 分支决定
		// （有活会话就回会话，没有才退到后台）。showConnectionSettings() 不杀隧道、
		// 不丢 WebView 页面，设置页自身的返回行为一字未改。
		//
		// T65：这一段**不再按档位分叉**——手机档也走「打开连接设置」而不是退到桌面。
		// 右栏打开态不受影响：sidebar 收掉时上面那个 JS 回调返回 true，
		// finishWebBack() 根本不会被调用（T43/T47 已验证的语义原样保留）。
		//
		// 记下本次是「返回键路径」进来的：设置页的返回键据此退到后台（D6.1），
		// 而不是走 HOME 分支回会话——那会变成会话⇄设置死循环。
		// 若此时没有活会话（fromSession 为 false），showConnectionSettings() 内部的
		// clearResumeSession() 会把标记清掉——那种情况返回键本就走 super.onBackPressed()。
		settingsViaBackKey = true;
		showConnectionSettings();
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

		/**
		 * T22-D：接住 hook 的页面适配诊断上报（mobile-web.js reportUiDiag）。
		 * 在 WebView 的 JS 线程上被调用，故这里只做「解析 → 存字段 → 投递一次 UI 更新」：
		 * 解析全包 try/catch 绝不抛，UI 更新走 runOnUiThread 绝不阻塞主线程。
		 * hook 侧已用 typeof 判空，桥缺失时静默跳过；桥在时也不得把异常带回页面。
		 */
		@JavascriptInterface
		public void setUiDiag(String json) {
			String summary;
			try {
				summary = formatUiDiag(json);
			} catch (Throwable ignored) {
				return;
			}
			uiDiagRaw = json == null ? "" : json;
			// T90：同一份载荷里的 wsState 还是**重连横幅的第二个数据源**（rail 下 DOM 探针
			// 探不到任何东西时唯一能用的那条）。这里只做一次纯字符串解析，绝不抛。
			hookConnState = parseUiDiagWsState(json);
			// hook 侧已按**判重键**（JSON.stringify 去掉 ts）去抖：载荷带 Date.now()，
			// 若拿整份 payload 判重则同状态永远不相等；去掉 ts 后状态未变就不重复过桥。
			// 这里再加一层按**摘要**去重：即使 hook 侧判重键因故失效（例如旧版 hook
			// 脚本，或将来新增字段导致判重口径漂移），繁忙页面上报也不会刷屏。
			if (!summary.equals(uiDiagSummary)) {
				// T64：消息里带上方法名 setUiDiag。
				// 原先只打「hook 诊断上报 {…}」，**整条消息不含 setUiDiag 子串** ——
				// 于是排查时最自然的 `logcat | grep setUiDiag` 永远 0 命中，
				// 会被误读成「hook 从未上报」（T58 §9-5 即此误判：其自存 logcat 里
				// 「诊断上报」11 条、「setUiDiag」0 条，上报其实一直正常）。
				// 保留原中文前缀（既有 grep 习惯不变），只**追加**方法名 token。
				Log.i("dshr-perf", "setUiDiag hook 诊断上报 " + uiDiagRaw);
			}
			uiDiagSummary = summary;
			runOnUiThread(() -> refreshUiDiagLine());
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
