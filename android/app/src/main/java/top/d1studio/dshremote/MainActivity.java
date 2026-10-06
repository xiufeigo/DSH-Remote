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
	/**
	 * T104：连接设置页的「打洞策略」二选一（打洞优先 / 只用中转）。
	 * 与既有卡片同一套控件与配色（styledButton + card），不新造控件类型。
	 */
	private Button stratP2pBtn, stratRelayBtn;
	/** T104：二选一下方那行「为什么某一档不可用」的说明（可用性由电脑端形态决定）。 */
	private TextView strategyNote;
	/** T104：编辑中的档位（保存时落进配置组；不可用的档会在渲染时被收敛到可用那一档）。 */
	private String editingStrategy = VisitorConfig.STRATEGY_P2P;
	/** T104：编辑中配置组的电脑端形态（导入链接带来的；空 = 未知）。 */
	private String editingPcMode = "";
	private TextView tvTunnelState;
	private Button resumeSessionBtn;
	private String editingProfileId = "";
	private WebView webView;
	private ValueCallback<Uri[]> fileCallback;
	/**
	 * T78：重连状态探针的**防抖状态机**（连续 2 次真才"显示" / 连续 3 次假才"隐藏" /
	 * UNKNOWN 不计数）。**只允许经 {@link #hideReconnectBannerNow()} 清零**，
	 * 避免上一页的累计带到新页面。
	 *
	 * <p><b>T109</b>：横幅的显示层已删（用户口径「去了吧，少一半耗电」），但这个防抖器
	 * **留着**——它现在只服务两件与显示无关的事：
	 * <ol>
	 *   <li>{@link #probeIntervalMs()}：确认"仍在断开态"时保持 500ms 快档；</li>
	 *   <li>{@link #runStuckRescue} 的观测量（仍按原判据给 OK/RECONNECTING/UNKNOWN）。</li>
	 * </ol>
	 * T108 的合并探针与自适应节拍一个字未动，删除的只是"把状态画出来"这一层。
	 */
	private final ReconnectBanner.Debouncer reconnectDebounce = new ReconnectBanner.Debouncer();
	/**
	 * T96：原生侧**卡住自救**判定器（分级：温和 nudge → 受控重载）。
	 *
	 * <p>为什么必须有它：平板档 hook 严格 OFF ⇒ 包装 WebSocket 观测**根本没装**，
	 * 全套自愈（400ms 二次确认 + 1s 断开巡检 + nudge）在 hook 里、平板档一次都不跑；
	 * 原生探针虽然**看得见**官方的「重新连接中」（实测 {@code probe=OK SUPPRESS|src=1 …}
	 * 与页面 {@code data-phase="connecting"} 同刻在场），但没有任何东西消费它。
	 * 实测（emulator-5700 平板档）：网关硬杀再拉起后页面卡在官方 Reconnecting **100s+**，
	 * 同刻页面内 {@code fetch('/__dsh_remote__/health')} = **200 / 64ms** ⇒ 卡的不是网络，是没人踹。
	 *
	 * <p>判据来源是**同一个** 500ms 只读探针（不新增第二套判据、不新增定时器），
	 * 只是吃的必须是**原始真相**（{@code re=1}）而不是"官方那条已可见 ⇒ 抑制横幅"之后的映射值。
	 */
	private final StuckRescue.Decider stuckRescue = new StuckRescue.Decider();
	/** T96：升级层（受控重载）**必须先过链路闸**——网关 HTTP 侧通不通。 */
	private volatile boolean rescueLinkOk = false;
	/** T96：链路探针是否在飞（一次只发一条，绝不叠加）。 */
	private volatile boolean rescueLinkProbeInFlight = false;
	/** T96：判定器已要求重载、正在等链路探针回话。 */
	private boolean rescueReloadArmed = false;
	/** T96：升级意图发起的时刻（看门狗用）。 */
	private long rescueReloadArmedAt = 0;
	/** T96：链路探针发起时刻（探针自己也要有超时，否则一次卡住会把后续升级全挡掉）。 */
	private volatile long rescueLinkProbeAt = 0;
	/** T96：等链路回话的最长时间；超时即撤回本次升级（配额回滚），绝不留"静默挡死"这条路。 */
	private static final long RELOAD_ARM_TIMEOUT_MS = 15000L;
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
	 * hook 每次装上都经 {@code reportUiDiag()} 推一次当前状态，所以新文档必然有一次刷新。
	 *
	 * <p><b>T109（S1·陈旧上界）</b>：改前这里**只增不减**——值只在下一次 {@code setUiDiag}
	 * 到达时被覆盖，而四条清零点（{@code onPageStarted} 除外）一条都不清它 ⇒ 一次假的
	 * {@code reconnecting} 会把"正在重连"**永久**钉在判据里（T106 静态审计 S1）。
	 * 现在配一个**陈旧上界** {@link #HOOK_CONN_STATE_MAX_AGE_MS}：超过 N 毫秒没收到新推送，
	 * 这个值就不再参与投票（读的地方一律走 {@link #freshHookConnState()}）。
	 * 与 hook 侧 T112 的"断开态 1s 重推 + 恢复立刻推 + open 撤闩"**配对**：
	 * 正常断开时推送每 1s 来一次，永远不陈旧；推送链路真坏了也不会把状态钉死。
	 * {@code volatile}：写在 WebView 的 JS 桥线程、读在主线程（{@code reconnectPollTick}）。
	 */
	private volatile String hookConnState = null;
	/** T109：{@link #hookConnState} 的写入时刻（ms，0 = 从未写入）。与它同写同清，见各赋值点。 */
	private volatile long hookConnStateAt = 0L;
	/**
	 * T109：hook 连接态推送的**陈旧上界**（ms）。
	 *
	 * <p>取 20000 的账：
	 * <ul>
	 *   <li>**下界**要容得下"正常但没有翻转"的静默期：健康态兜底探针周期是 5s
	 *       （{@link #PROBE_IDLE_MS}，T117 起两档合并成这一个），快档窗口 8s
	 *       （{@link #PROBE_FAST_WINDOW_MS}）；
	 *       20s = 4 拍兜底 + 2.5 个快档窗口，不会在正常静默里误判为陈旧；</li>
	 *   <li>**上界**要短到"一次假 reconnecting 不会把用户钉死"：T112 在 hook 侧对断开态
	 *       每 1s 重推一次 ⇒ 真断开时推送**永远新鲜**，20s 陈旧等价于"连续 20 次重推都没到"，
	 *       那时链路侧已经出了别的问题，退回 UNKNOWN（不投票）比继续投假票更安全；</li>
	 *   <li>与 hook 自身的退避上限（指数退避到数十秒）无关：这里的判据是**推送有没有到**，
	 *       不是**页面有没有在重连**——两者混用就会把"退避中"误当成"没在重连"。</li>
	 * </ul>
	 */
	private static final long HOOK_CONN_STATE_MAX_AGE_MS = 20000L;
	/** T109：陈旧上界触发时只打一行日志（避免每拍刷屏），值一变就复位。 */
	private volatile boolean hookConnStateStaleLogged = false;
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
	/**
	 * T94：系统栏让位后露出的那两条（状态栏带 / 底部手势条带）**实际用的颜色**。
	 *
	 * <p>背景（用户报的"白条"）：T80 把让位落成 WebView 的**外边距**之后，那两条画的是
	 * 父容器 {@code rootLayout} 的底色，而它的取值一直是**硬编码**的
	 * {@code dark ? 0xFF141414 : Color.WHITE}。手机档有 hook 经
	 * {@code setPageDark} 把真实深浅推上来，所以碰巧对；**平板档 hook 严格 OFF**
	 * （契约 3.5），没人推 ⇒ {@code pageDark} 永远停在 {@code isSystemDark()} 上。
	 * 页面主题与系统主题不一致时（DSH 侧手选深色/浅色、系统却是另一套），
	 * 那两条就与页面**反色**：实测页面 #1B1B1C 而两条 #FFFFFF（见 scratch/t94/report.md §1）。
	 *
	 * <p>所以这里存**页面自己画出来的颜色**（只读探针 {@link #PAGE_BG_PROBE_JS} 采样，
	 * 见 {@link #requestPageBackground()}），{@link #PAGE_BG_NONE} 表示"还没取到"——
	 * 取不到时**逐值退回**改动前的硬编码取值，绝不因为探针失败而改变行为。
	 */
	private static final int PAGE_BG_NONE = 0;
	private int pageBgTop = PAGE_BG_NONE;
	private int pageBgBottom = PAGE_BG_NONE;
	/** T94：探针轮询是否在推进（onResume 起、onPause 停）。 */
	private boolean pageBgPolling = false;
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
	 * 原生这份是文件选择器链路，混进去会破坏那条契约断言，故在 diagSnapshotText() 里拼接。
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
		// T94：退后台即停页面背景轮询（后台不读页面；回前台 onResume 重启并立即补读一次）。
		stopPageBgPolling();
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
		// T78：回前台重启重连状态轮询（onPause 停掉的那条）。
		startReconnectPolling();
		// T96：回前台是**新起点**——退后台期间连接可能已经死了（页面侧 JS 被 pauseTimers 冻住），
		// 所以回前台后第一次读到「正在重连」就允许温和层**立刻**动作，不等 TIER1_AFTER_MS，
		// 更不等 hook 那条（平板档根本没有 hook 自愈）。判据合并在 stuckRescue 里。
		stuckRescue.onForeground();
		// T90：顺便**补读一次** hook 的连接态（只读、一次性）：后台期间 pauseTimers 冻住了
		// 页面侧 JS，翻转事件未必推得过来（见 refreshHookConnState 注释）。放在
		// startReconnectPolling 之后：先让轮询恢复，再补这一读，横幅下一拍就能用上新值。
		refreshHookConnState();
		// T94：回前台重启页面背景轮询，并**立即补读一次**——退后台期间用户可能在
		// 页面里改了主题（或系统深浅色变了），首帧就得是新的页面色。
		startPageBgPolling();
		requestPageBackground();
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
		// T78：停掉重连状态轮询（rootLayout 随 Activity 一起销毁）。
		stopReconnectPolling();
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
		// T115：与用户口径「系统栏改走安卓原生透明」一致——这里不再涂 shell 底色。
		// 本行原来写 shellColor(R.color.shell_background)（不透明 #F2F3F6），虽然紧随其后的
		// applySystemBars() 会把它覆盖掉（那条路径逐状态重算），但「代码字面」与「原生透明」
		// 相反，API 30–34 上若哪天这条覆盖路径被绕开就会真的涂成不透明色。
		getWindow().setNavigationBarColor(Color.TRANSPARENT);
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

		// T117：**设置页那行可见诊断块整块删除**（用户口径原话：「请你顺手把你之前加的那些测试用的
		// 内容删了吧，免得徒增耗电。比如这串诊断字样」——指的就是下面这段 9 行计数器/键值对）。
		// 采集与记账**一个字没删**（PinnedFetch 并发闸、StaticDiskCache 落盘缓存、TunnelPath 路径
		// 记账、探针拍数全都照跑），只是不再往屏上画；同样的信息改由 logcat 标签 {@link #DIAG_TAG}
		// 输出，且**只在值变化时打**（见 {@link #emitDiagLog}）。取回方式见 android/README.md。
		// 保留的是**人话级提示**（tvTunnelState：「隧道仍在运行…」）与失败原因/重试入口。

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

		// ── T104：打洞策略人工二选一 ─────────────────────────────────────────
		// 用户要的是「自由选择打洞还是中转」。两档的**含义**必须写在脸面上，
		// 代价也要说清（只用中转：建连更快更确定，但数据经过 VPS）。
		// 哪一档成立由**电脑端形态**决定（来自导入链接的 mode），不成立的档
		// 按用户要求「如实标注/禁用 + 给出理由」，绝不做成"看起来能点、点了连不上"。
		LinearLayout strategyCard = card(d);
		strategyCard.addView(cardTitle("打洞策略（二选一）", d));
		strategyCard.addView(hintText("打洞优先：先试 P2P 直连，5 秒打不通就自动回退中转。"
			+ "只用中转：不试打洞，直接经 VPS 中转——建连更快更确定，但数据经过 VPS。", d));
		LinearLayout strategyRow = new LinearLayout(this);
		strategyRow.setOrientation(LinearLayout.HORIZONTAL);
		stratP2pBtn = styledButton("打洞优先", true, d);
		stratP2pBtn.setOnClickListener(v -> setEditingStrategy(VisitorConfig.STRATEGY_P2P));
		strategyRow.addView(stratP2pBtn, new LinearLayout.LayoutParams(0, dp(44, d), 1f));
		stratRelayBtn = styledButton("只用中转", false, d);
		stratRelayBtn.setOnClickListener(v -> setEditingStrategy(VisitorConfig.STRATEGY_RELAY));
		LinearLayout.LayoutParams relayParams = new LinearLayout.LayoutParams(0, dp(44, d), 1f);
		relayParams.leftMargin = dp(8, d);
		strategyRow.addView(stratRelayBtn, relayParams);
		strategyCard.addView(strategyRow);
		strategyNote = new TextView(this);
		strategyNote.setTextSize(13);
		strategyNote.setTag("muted");
		strategyNote.setLineSpacing(0, 1.25f);
		strategyNote.setPadding(0, dp(8, d), 0, 0);
		strategyCard.addView(strategyNote);
		box.addView(strategyCard, cardParams(d));

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

	// ---------- T104：打洞策略二选一 ----------

	/**
	 * 用**当前表单里的电脑端形态**造一个临时 Profile，只为了问一件事：
	 * 「这一档在你这台电脑上成立吗」。判据只有一处（ProfileStore 的可用性矩阵），
	 * UI 与写进 toml 的档位因此不会各说一套。
	 */
	private ProfileStore.Profile editingProfileView() {
		ProfileStore.Profile p = new ProfileStore.Profile();
		p.pcMode = VisitorConfig.normalizePcMode(editingPcMode);
		p.mode = ProfileStore.modeForPcMode(p.pcMode);
		p.strategy = VisitorConfig.normalizeStrategy(editingStrategy);
		return p;
	}

	private void setEditingStrategy(String value) {
		editingStrategy = VisitorConfig.normalizeStrategy(value);
		renderStrategyChoice();
	}

	/**
	 * 画出二选一的选中态 + 可用性说明。
	 *
	 * <p>不成立的那一档会**被收敛到成立的那一档**（而不是"选中但禁用"）：用户切回来
	 * 保存时不会存下一个自相矛盾的组合，写进 toml 的也就是屏上显示的那一档。
	 * 电脑端形态 = entry 时两档都不成立：两个按钮都禁用，并给出**可执行的**下一步
	 * （去电脑端改形态再重新导入），不假装能用。
	 */
	private void renderStrategyChoice() {
		if (stratP2pBtn == null || stratRelayBtn == null) return;
		ProfileStore.Profile view = editingProfileView();
		boolean p2pOk = ProfileStore.p2pAvailable(view);
		boolean relayOk = ProfileStore.relayAvailable(view);
		// T104：收敛只在**选的那一档不成立**时发生（判据收在 ProfileStore.coerceStrategy 一处，
		// 与写进 toml 的档位同源）。成立时绝不改动用户的选择——第一版在这里写成
		// 「p2p 成立就强制回 p2p」，结果 xtcp 电脑端上点「只用中转」会被立刻弹回去，
		// 人工二选一形同虚设（设备级验证当场抓到，见 scratch/t104/report.md §3.2）。
		editingStrategy = ProfileStore.coerceStrategy(view, editingStrategy);
		applyChoiceStyle(stratP2pBtn, VisitorConfig.STRATEGY_P2P.equals(editingStrategy));
		applyChoiceStyle(stratRelayBtn, VisitorConfig.STRATEGY_RELAY.equals(editingStrategy));
		stratP2pBtn.setEnabled(p2pOk);
		stratRelayBtn.setEnabled(relayOk);
		stratP2pBtn.setAlpha(p2pOk ? 1f : 0.4f);
		stratRelayBtn.setAlpha(relayOk ? 1f : 0.4f);
		String pc = view.pcMode;
		String note;
		if (!p2pOk && !relayOk) {
			note = "电脑端形态：entry（公网入口）—— 它不注册任何访客隧道代理，这两档都用不上。"
				+ "请到电脑端「设置 → 插件 → DSH Remote → 隧道形态」改成 xtcp（可打洞、失败自动回退）"
				+ "或 stcp（只用中转），再重新扫码导入。";
		} else if (!p2pOk) {
			note = "电脑端形态：stcp —— 它只注册了中转代理、没有 P2P 代理，"
				+ "「打洞优先」不成立，已固定为「只用中转」。";
		} else if ("xtcp".equals(pc)) {
			note = "电脑端形态：xtcp —— 同时注册了 P2P 与中转两条代理，两档都可用。";
		} else if ("entry".equals(pc)) {
			note = "电脑端形态：entry（公网入口）—— 两档都不适用（见上方说明）。";
		} else {
			note = "电脑端形态：未知（这个配置组是手工填的，不是扫码导入）—— 按 xtcp 处理，两档都可用；"
				+ "连上之后诊断行会给出本次实际走的路径。";
		}
		if (strategyNote != null) strategyNote.setText(note);
	}

	/** T104：二选一按钮的选中态配色（与 styledButton 的 primary/secondary 同一套）。 */
	private void applyChoiceStyle(Button button, boolean selected) {
		float d = getResources().getDisplayMetrics().density;
		GradientDrawable background = new GradientDrawable();
		background.setCornerRadius(10 * d);
		if (selected) {
			background.setColor(0xFF1B66FF);
			button.setTextColor(0xFFFFFFFF);
		} else {
			background.setColor(0xFFFFFFFF);
			background.setStroke(Math.max(1, dp(1, d)), 0xFFD9DBE0);
			button.setTextColor(0xFF1B1B1F);
		}
		button.setBackground(background);
		button.setTag(selected ? "primary-button" : "secondary-button");
	}

	private ScrollView insetScroll(View child) {
		ScrollView scroll = new ScrollView(this);
		scroll.addView(child);
		scroll.setBackgroundColor(0xFFF2F3F6);
		scroll.setVisibility(View.GONE);
		// ── T109（P1-1）：设置页必须**消费**触摸 ───────────────────────────────
		// 改前这两个页面（homeScroll / setupScroll）都是 MATCH_PARENT 的 ScrollView，
		// 自身不可点、内容又不滚动 ⇒ 落在"没有控件的地方"（标题、卡片间隙）的那次
		// ACTION_DOWN 一路返回 false，ViewGroup 继续往下层兄弟派发 ⇒ 落到背后的 WebView
		// （V1 实测：长按鲸鱼进设置页后，点标题处 = 背后鲸鱼位置，抽屉被 toggle
		// expanded 0→1，设置页自己纹丝不动：scratch/v1/whale-tap-after.json）。
		//
		// 修法只加这一行：clickable 的 View 在 onTouchEvent 里对 ACTION_DOWN 返回 true
		// ⇒ 这次手势被本 View 吃掉，不再回溯到兄弟节点。
		// 为什么**不破坏**既有点击控件与滚动：
		//   · 子 View 派发顺序在 ViewGroup.dispatchTouchEvent 里**先于**自身 onTouchEvent
		//     （先给能接的 child，谁都不要才轮到自己）⇒ 按钮/输入框的点击一个字都不变；
		//   · ScrollView 的滚动走 onInterceptTouchEvent + onTouchEvent 的既有路径，
		//     与 clickable 无关（clickable 只决定"没人要时要不要自己吃掉"）。
		scroll.setClickable(true);
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
		// T94：回首页（离开会话）⇒ 作废页面采样色，重新用壳底色（applySystemBars 会读会话态）。
		resetPageBackground();
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
			// T102：文案**不再承诺系统返回键**。
			//
			// 改前这里按「本次是不是从返回键路径进来」的那个一次性标记分两支：返回键路径进来的
			// 那一支只承诺上方按钮，其余入口那一支多承诺了一句「系统返回键也能继续」。T102 取消了
			// 「返回键进设置页」，设置页只剩显式入口（平板长按品牌区 / 设置按钮 / 通知动作 /
			// AppBridge.openSettings），而返回键语义与「本次怎么进来的」已经无关，再按入口分叉
			// 就是**把行为差异写进文案**（历史上正是这条分歧导致 T48/T58/T59/T65 反复踩坑）。
			// 因此收敛成**唯一一句**：只承诺上方按钮。少承诺不会误导（返回键在这里仍回会话，
			// 见 handleAppBack() 的 HOME 分支），多承诺才会。
			tvTunnelState.setText("隧道仍在运行。点上方「返回当前会话」继续，无需重新连接。");
		}
		if (homeScroll != null) homeScroll.setVisibility(View.VISIBLE);
		if (setupScroll != null) setupScroll.setVisibility(View.GONE);
		// T117：进设置页 = 用户主动排查时刻 ⇒ 无条件打一份完整诊断快照（绕过最小间隔闸）。
		// 这就是"屏上那 9 行"的替代品：`adb logcat -s dshr-diag` 看得到同一份内容。
		emitDiagLog("settings", true);
		applySystemBars();
	}

	/**
	 * T117：**诊断输出的唯一落点 = logcat**（{@link #DIAG_TAG}），设置页不再画它。
	 *
	 * <p>背景（用户口径原话）：「请你顺手把你之前加的那些测试用的内容删了吧，免得徒增耗电。
	 * 比如这串诊断字样」——T22-D 加的那行只读诊断（页面适配诊断 / 文件选择 / 并发峰值 /
	 * 落盘缓存 / 未拦 / 打洞策略 / 本次隧道 / 重连探针 共 9 行）整块从 UI 上删除。
	 *
	 * <p>**注意**：那串字本身几乎不耗电（静态文本，只在设置页可见时绘制一次）；真正在耗电的是
	 * 它最后一行暴露的**兜底探针节拍**（改前平板档 `节拍 1000ms`）。那次改动见
	 * {@link #PROBE_IDLE_MS} 的账。这里做的是第二件事：把"信息"从屏上搬到 logcat，
	 * 排查能力不降（原来只有设置页可见的用户能读到，现在 `adb logcat -s dshr-diag` 就够）。
	 *
	 * <p>三段内容与改前上屏的那份**逐字同源**（{@link #formatUiDiag} 的 9 字段 + 文件选择 +
	 * {@link PinnedFetch#statsSummary()} + {@link StaticDiskCache#statsSummary()} +
	 * {@link #staticPassthroughSummary()} + {@link #strategyDiagLine()} + {@link #reconnectDiagLine()}），
	 * 采集与记账一处未改。
	 *
	 * <p><b>只在值变化时打</b>（避免刷屏，也不给"省电"这件事加回一条新开销）：
	 * <ul>
	 *   <li>判重键 = 整段文本，但把两个**时间类单调量**归一化掉——`拍数 N`（每拍 +1）与
	 *       `陈旧 <N>s`（每秒 +1）。它们本身不携带新信息，却会让"值变化"变成"每拍必变"
	 *       （改前是 1s 一拍 ⇒ 每秒一行）。归一化只影响**打不打**，打的永远是**完整原文**
	 *       （含真实拍数与真实陈旧秒数）。</li>
	 *   <li>被 throttled 掉的变化不会丢：文本是**全量快照**，下一次真变化（或任何
	 *       {@code userTriggered} 打点，如打开设置页、文件选择出结果）打的仍是当时的完整值。</li>
	 *   <li>{@code userTriggered=true} 的调用点绕过最小间隔闸：那是用户主动要看的时刻。</li>
	 * </ul>
	 */
	private void emitDiagLog(String trigger, boolean userTriggered) {
		String text = diagSnapshotText();
		String key = text.replaceAll("陈旧 [0-9]+s", "陈旧 Ns").replaceAll("拍数 [0-9]+", "拍数 N");
		long now = System.currentTimeMillis();
		if (key.equals(lastDiagLogKey)) return;
		if (!userTriggered && now - lastDiagLogAt < DIAG_LOG_MIN_INTERVAL_MS) return;
		lastDiagLogKey = key;
		lastDiagLogAt = now;
		Log.i(DIAG_TAG, "trigger=" + trigger + " " + text);
	}

	/**
	 * T117：诊断快照全文（**只读**，不产生任何副作用；设置页那行与 logcat 那行改前/改后同源）。
	 * 各段之间的分隔符从改前的 `\n`（上屏）换成 `" | "`（logcat 单行），内容一字未改；
	 * 段内自带的换行（`strategyDiagLine()` 是两行）也在末尾统一折成空格
	 * ⇒ logcat 里恒为**一条**记录（实测抓到过被 `\n` 拆成两行）。
	 */
	private String diagSnapshotText() {
		String summary = uiDiagSummary;
		String base = TextUtils.isEmpty(summary) ? "页面适配诊断：未上报（连上会话后由页面回报）" : summary;
		String chooser = TextUtils.isEmpty(chooserDiag) ? "文件选择：未选择过" : "文件选择：" + chooserDiag;
		return (base + " | " + chooser + " | " + PinnedFetch.statsSummary()
			+ " | " + StaticDiskCache.statsSummary()
			+ " | " + staticPassthroughSummary()
			+ " | " + strategyDiagLine()
			+ " | " + reconnectDiagLine()).replace('\n', ' ');
	}

	/** T117：诊断 logcat 标签（`adb logcat -s dshr-diag:I`）。 */
	private static final String DIAG_TAG = "dshr-diag";
	/** T117：两次**非用户触发**诊断行之间的最小间隔（ms）——上限 60 行/分，杜绝刷屏。 */
	private static final long DIAG_LOG_MIN_INTERVAL_MS = 1000L;
	/** T117：上一次打出去的判重键（时间类单调量已归一化）。 */
	private String lastDiagLogKey = "";
	/** T117：上一次打出去的时刻（最小间隔闸用）。 */
	private long lastDiagLogAt = 0L;

	/**
	 * T104：诊断里那两行「打洞策略 / 本次实际路径」——用户要"能看出这次到底走了哪条"。
	 *
	 * <p>两个数据源，都不许编：
	 * <ul>
	 *   <li>第一段 = **配置真值**：当前生效配置组里那一档（经形态收敛后真正会写进 toml 的档），
	 *       外加电脑端形态（导入链接里的 mode）。形态未知就写"未知"，不冒充 xtcp。</li>
	 *   <li>第二段 = **实际路径真值**：{@link TunnelPath} 从 frpc 自己的日志里认出来的
	 *       打洞成功 / 5s 超时回退中转；没有可辨识的判据就写「尚未判定」——
	 *       **查不到可靠信号时只显示配置策略，绝不把配置当事实**。</li>
	 * </ul>
	 */
	private String strategyDiagLine() {
		ProfileStore.Profile active = ProfileStore.getActive(prefs());
		String pc = active == null ? "" : VisitorConfig.normalizePcMode(active.pcMode);
		String pcLabel = pc.length() > 0 ? pc : "未知";
		String configLabel;
		if (active == null) {
			configLabel = "无配置组";
		} else if (ProfileStore.tunnelUnavailable(active)) {
			configLabel = "两项都不适用（电脑端是 entry 形态，没有访客代理）";
		} else {
			configLabel = TunnelPath.strategyLabel(ProfileStore.effectiveStrategy(active));
		}
		return "打洞策略（配置）：" + configLabel + " · 电脑端形态 " + pcLabel
			+ "\n" + TunnelPath.summary();
	}

	/**
	 * 把 hook 的诊断 JSON 折成一行文案。字段名与 hook 的 collectUiDiag() 同源，
	 * 任何字段缺失都显示「未上报」而不是省略——缺字段本身就是要说出来的信息。
	 * 解析失败返回空串，由 diagSnapshotText() 落回「未上报」。
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
			// T104：新建配置组没有电脑端形态信息（手工填的）⇒ 形态未知，两档都摆出来，
			// 默认打洞优先（与改前行为逐字一致）。
			editingPcMode = "";
			editingStrategy = VisitorConfig.STRATEGY_P2P;
		} else {
			editingProfileId = existing.id;
			etName.setText(existing.name);
			etServer.setText(existing.serverAddr);
			etCport.setText(existing.serverPort > 0 ? String.valueOf(existing.serverPort) : "7000");
			etTunnel.setText(TextUtils.isEmpty(existing.tunnelName)
				? ProfileStore.DEFAULT_TUNNEL_NAME : existing.tunnelName);
			etToken.setText(existing.authToken);
			etSk.setText(existing.secretKey);
			editingPcMode = VisitorConfig.normalizePcMode(existing.pcMode);
			editingStrategy = VisitorConfig.normalizeStrategy(existing.strategy);
		}
		// 渲染必须在表单值就位之后：可用性判据吃的是编辑中这一档的电脑端形态。
		renderStrategyChoice();
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
		// T104：形态与策略一起落盘。
		// mode 由**电脑端形态**决定（stcp 形态的电脑端只注册了 `<名>`(stcp) 一条代理，
		// 访客也必须是 stcp 才连得上）；改前这里无条件写 DEFAULT_MODE，
		// 会把扫码导入的 stcp 配置组在"编辑一次"之后改回 xtcp ⇒ 从此连不上。
		p.mode = ProfileStore.modeForPcMode(editingPcMode);
		p.pcMode = VisitorConfig.normalizePcMode(editingPcMode);
		p.strategy = VisitorConfig.normalizeStrategy(editingStrategy);
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
		// T104：链接里的 mode 就是**电脑端形态**。stcp 形态下访客也必须用 stcp
		// （否则会拿着 xtcp 访客去找一条不存在的 xtcp 代理）；entry/未知沿用历史 xtcp。
		p.pcMode = VisitorConfig.normalizePcMode(c.pcMode);
		p.mode = ProfileStore.modeForPcMode(p.pcMode);
		// T104：新导入的配置组默认「打洞优先」（与改前行为逐字一致）；若电脑端是 stcp 形态，
		// 编辑器/连接时的可用性矩阵会把它如实收敛成「只用中转」。
		p.strategy = VisitorConfig.STRATEGY_P2P;
		p.tunnelName = ProfileStore.normalizeTunnelName(c.serverName);
		// T23-A：二维码里的网关自签指纹必须随配置组一起存下来。改前这里没拷，
		// Profile 也没有该字段 ⇒ 指纹在导入那一刻就被丢弃，后续首连前的「预置指纹」
		// 分支永远不成立（每次都退回 TOFU）。
		p.fingerprint = CertPin.normalizeFingerprint(c.fingerprint);
		ProfileStore.upsert(prefs(), p);
		ProfileStore.setActiveId(prefs(), p.id);
		// T117：导入/扫码成功 = 一次**授权数据写入**，顺手把 cookie 存储刷盘
		// （同一个洞口：写完就 force-stop 不该丢东西）。日志理由见 flushDeviceCookies。
		flushDeviceCookies("importLink");
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
			// T104：存活隧道还必须**同一档策略**才算能复用。"切了档但端口还活着"若照样复用，
			// 用户会看到新选项被选中、实际跑的却还是旧档（frpc 的 toml 没换），切档名不副实。
			// 策略不一致就当作"没有存活隧道"⇒ 重启隧道（与换配置组连接同一条路径）。
			String tunnelStrategy = prefs().getString(ProfileStore.KEY_TUNNEL_STRATEGY, "");
			boolean sameStrategy = cfg.effectiveStrategy().equals(tunnelStrategy);
			int reusePort = 0;
			if (profile.id.equals(tunnelProfile) && sameStrategy) {
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
	private static final String STATIC_CACHE_ASSETS_PREFIX = "/assets/";

	/**
	 * T109：{@code /plugins/} 组合包的**精确**路径（{@code /plugins} 与 {@code /plugins/} 两种写法）。
	 *
	 * <p>改前这里是 {@code path.startsWith("/plugins/")} 的**前缀**匹配，而浏览器侧
	 * {@code pwa.ts} 的白名单是同一条语义的**精确**匹配
	 * （{@code FINGERPRINTED_PATH = /^\/plugins\/?$/}，T49 定下的）。前缀匹配让原生比 SW
	 * 多吞了一整类路径：{@code /plugins/events}（SSE 长连接）也被判进白名单 ⇒
	 * 打到 {@link PinnedFetch}（15s 读超时 / 45s 总预算，且**读满整体才返回**）⇒
	 * 事件流永远回不来，用户体感"掉线后半天回不来"。收成精确路径后与 SW 判定重合，
	 * 恢复「一侧判定 = 另一侧判定」这条既有不变量。
	 */
	private static final String STATIC_CACHE_PLUGIN_BUNDLE = "/plugins";

	/**
	 * T109：**流式 / SSE 端点**——永不接管。判据是路径，写在白名单之外，与
	 * {@link #STATIC_CACHE_ASSETS_PREFIX} 同级生效（在 {@link #isStaticCachePath} 的第一行）。
	 *
	 * <p>为什么单独列：这类端点**语义上就是长连接**，接管的代价不是"慢一点"而是
	 * "永远不回来"（{@link PinnedFetch} 读满整体才返回）。网关侧对应的排除见
	 * {@code packages/gateway/src/proxy.ts:169}（{@code content-type} 含
	 * {@code text/event-stream} 不压缩）。两处都是"按端点类别放行"，不是按路径前缀猜。
	 */
	private static final String[] STREAMING_PATHS = {"/plugins/events"};

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
	/** T109：流式/SSE 放行计数（`/plugins/events` 或 `Accept: text/event-stream`）。 */
	private final java.util.concurrent.atomic.AtomicInteger passthroughStream =
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
			+ " · 非本网关 " + passthroughOrigin.get()
			+ " · SSE " + passthroughStream.get();
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
		// ⑤ 静态白名单（{@code /assets/} 目录段 + 精确 {@code /plugins}）。
		// T109：白名单**之前**先挡流式/SSE——路径名单（`/plugins/events`）与协议标记
		// （Accept: text/event-stream）两条任一命中就放行。放行计数在
		// passthroughStream 里单列，验收要能读到"SSE 一次都没被接管"。
		if (isStreamingPath(path) || isEventStreamRequest(request)) {
			passthroughStream.incrementAndGet();
			return null;
		}
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

	/**
	 * T65 静态白名单判定（{@code /assets/} 目录段 + {@code /plugins} 组合包精确路径）。
	 * WebViewClient 与 ServiceWorkerClient 两条通道共用。
	 *
	 * <p>T109 两处收紧（与浏览器侧 {@code pwa.ts} 同语义）：
	 * <ol>
	 *   <li>{@code /plugins/} 由**前缀**改**精确**（见 {@link #STATIC_CACHE_PLUGIN_BUNDLE}）；
	 *   <li>流式端点（{@link #STREAMING_PATHS}）**先**被否掉——即使将来有人把它加回白名单，
	 *       这一条也仍然成立（判据在函数第一行，不依赖白名单内容）。</li>
	 * </ol>
	 */
	private static boolean isStaticCachePath(String path) {
		if (path == null || path.isEmpty()) return false;
		if (isStreamingPath(path)) return false;
		if (path.startsWith(STATIC_CACHE_ASSETS_PREFIX)) return true;
		return STATIC_CACHE_PLUGIN_BUNDLE.equals(path)
			|| (STATIC_CACHE_PLUGIN_BUNDLE + "/").equals(path);
	}

	/**
	 * T109：这条路径是不是**流式/SSE 端点**（长连接，接管即空等）。
	 *
	 * <p>纯函数、无 Android 依赖，由 {@code android/tests/T109StreamingPathTest.java} 逐条钉死；
	 * 判定与 {@link #isStaticCachePath} 同源（同一份 {@link #STREAMING_PATHS}）。
	 */
	static boolean isStreamingPath(String path) {
		if (path == null) return false;
		for (String p : STREAMING_PATHS) {
			if (p.equals(path)) return true;
		}
		return false;
	}

	/**
	 * T109：请求头 {@code Accept} 里带 {@code text/event-stream} ⇒ 这是一次 SSE 请求，放行。
	 *
	 * <p>为什么路径判据之外还要这一条：{@code /plugins/events} 只是**当前**那一个端点，
	 * 而 {@code Accept: text/event-stream} 是 SSE 的**协议级**标记（与网关侧
	 * {@code proxy.ts} 认 {@code content-type: text/event-stream} 同一类判据）。
	 * 将来上游换端点名，路径名单会漂，这一条不会。两条都只做**放行**，不做任何接管。
	 */
	private static boolean isEventStreamRequest(WebResourceRequest request) {
		try {
			Map<String, String> headers = request.getRequestHeaders();
			if (headers == null) return false;
			String accept = headers.get("Accept");
			if (accept == null) {
				for (Map.Entry<String, String> e : headers.entrySet()) {
					if (e.getKey() != null && "accept".equalsIgnoreCase(e.getKey())) {
						accept = e.getValue();
						break;
					}
				}
			}
			return accept != null && accept.toLowerCase(Locale.US).contains("text/event-stream");
		} catch (Exception ignored) {
			return false;
		}
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
				// T109：时刻戳同时清零（否则上一条推送的"新鲜度"会跨文档续命）。
				hookConnState = null;
				hookConnStateAt = 0L;
				hookConnStateStaleLogged = false;
				// T94：同理作废上一页采样到的页面底色——新文档首帧不该沿用旧页的颜色
				//（新文档就绪后由轮询/enterSessionPage 重采）。
				resetPageBackground();
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
				// T96：新文档也是自救判定的新起点（断开 episode 重开；**重载配额跨文档保留**，
				// 所以受控重载本身不会被自己的新文档洗掉计数 ⇒ 不会变成无限重载）。
				stuckRescue.onDocumentChanged();
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
		// T109：`installReconnectBanner()` 已删——根布局里现在只有 WebView 一个子节点
		// （homeScroll / setupScroll 那两个原生页是另外挂的、平时 GONE）。
	}

	/*
	 * T109：横幅的**显示层**整层删除（用户口径原话「把重连横幅去了吧，这样可以少一半的耗电」）。
	 * 原来的「把原生重连横幅挂进根布局」那个安装方法、它的 inset 外边距方法、Bar 本体、
	 * 出入场动画与 R.id.dshrReconnectBanner 一起没了。
	 * 删掉之后 readSystemBarInsetsPx() 的调用者只剩平板让位那一处——取值本体一个字没动。
	 * 喂给 StuckRescue 的采样（合并探针 + T108 自适应节拍）与状态呈现（设置页只读诊断行
	 * reconnectDiagLine()）都不受影响；回归钉在 android/test-reconnect-banner.ps1 的 T109 臂里。
	 */

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

	/**
	 * T109：横幅的 inset 外边距随显示层一起删除。
	 *
	 * <p>删掉之后 {@link #readSystemBarInsetsPx()} 的调用者只剩平板让位那一处
	 * ——**取值本体一个字没动**（T72/T79/T80 的「唯一写入口 + 调用链」结构照旧），
	 * 只是它现在只服务一个消费者。{@code installImeInsetHandling} 里的
	 * {@code applyReconnectBannerInsets()} 调用点也就地去掉了（见那里）。
	 */

	/**
	 * T108：**快档窗口**长度。进入页面（onResume / 新文档提交）、收到 hook 的连接态推送、
	 * 或探针自己看到「正在重连」时开一个；窗口内按 {@link ReconnectBanner#POLL_INTERVAL_MS}
	 * （500ms）跑，窗口外按健康态兜底周期跑。
	 */
	private static final long PROBE_FAST_WINDOW_MS = 8000L;

	/**
	 * T108/T117/**Users**：**健康态兜底周期（1 分钟）**。
	 *
	 * <p>T108 的分档是「有推送通道 5s（{@code PROBE_IDLE_HOOK_MS}）/ 无推送通道 1s」；
	 * T117 先把无通道那一档从 1000ms 放宽到 5000ms 并**合并成一个常量**；
	 * 随后按用户口径进一步放宽到 **60s**：
	 * <blockquote>"兜底探针改成按分钟计吧，然后在后台的时候不触发，只有在前台才会触发探针，这样才是真省电。"</blockquote>
	 *
	 * <p><b>三条账</b>：
	 * <ol>
	 *   <li><b>耗电账</b>：兜底探针 = 一次 {@code evaluateJavascript} + 页面侧 DOM 扫描
	 *       （{@code PROBE_JS}，开销随 DOM 线性增长）。实测（T117 装置、长会话档 9000+ 节点）：
	 *       <b>1s 档 60 拍/分 → 5s 档 12 拍/分，CPU 624.9 → ~210 ms/分</b>；
	 *       60s 档按同口径推算 ≈ **1 拍/分**。
	 *       ⚠️ 60s 这一档**没有单独的真机计时**（T117 实测的是 5s 档）——真机可用 logcat
	 *       {@code dshr-diag} 行里的拍数对账。</li>
	 *   <li><b>后台账</b>：后台**根本不跑**——{@code onPause()} 停轮询并 {@code pauseTimers()}，
	 *       T108 实测后台 **0 拍/分**（这里不依赖 60s 这个值）。</li>
	 *   <li><b>及时性账</b>：60s 只决定"**在页面里干等时**多久发现断开"；而
	 *       "**切后台再回来**"这条主场景由 {@code onResume} → {@link #armProbeFastWindow}
	 *       立刻开 **500ms** 快档 ⇒ 仍是 ~1s 级发现。{@link StuckRescue} 的阈值
	 *       （温和 2×8s / 升级 12s / 链路闸）**一个字没改**。</li>
	 * </ol>
	 *
	 * <p>刻意**没有**把快档窗口 {@link #PROBE_FAST_WINDOW_MS} 开大来"补偿"（那反而更耗电），
	 * 也没有删掉"进会话/回前台立刻补一拍"（那是关键的及时性）。
	 */
	private static final long PROBE_IDLE_MS = 60000L;

	/** T108：快档窗口截止时刻（0 = 不在窗口内）。 */
	private long probeFastUntil = 0L;
	/** T108：下一次把「配色采样」并进合并探针的时刻（0 = 下一拍就采）。 */
	private long nextBgSampleAt = 0L;

	/** T108：开（或延长）快档窗口。只增不减，幂等。 */
	private void armProbeFastWindow(long ms) {
		probeFastUntil = Math.max(probeFastUntil, System.currentTimeMillis() + ms);
	}

	/**
	 * T108：当前节拍周期。三个"快档"条件（任一成立就是 500ms）：
	 * <ol>
	 *   <li>在快档窗口内（刚进页面 / 刚收到推送 / 刚看到重连）；</li>
	 *   <li>hook 说正在重连（新鲜度上界内）；</li>
	 *   <li>防抖器已判"仍在断开态"（与改前一样保持 500ms）。</li>
	 * </ol>
	 * <p>T117：其余（健康态）**只有一档 5s**（{@link #PROBE_IDLE_MS}）——改前按
	 * "有没有推送通道"分成 5s / 1s 两档，那条 1s 档是所有平板的常态、也是本任务要解决的耗电点。
	 * 探针的**采样链、判据、防抖、自救喂数**一个字未改，改的只有"多久跑一拍"。
	 */
	private long probeIntervalMs() {
		if (System.currentTimeMillis() < probeFastUntil) return ReconnectBanner.POLL_INTERVAL_MS;
		if ("reconnecting".equals(freshHookConnState())) return ReconnectBanner.POLL_INTERVAL_MS;
		if (reconnectDebounce.state() == ReconnectBanner.State.SHOWN) return ReconnectBanner.POLL_INTERVAL_MS;
		return PROBE_IDLE_MS;
	}

	/** T78：启动重连状态轮询（幂等）。T108：回前台是一次"进入"，开快档窗口。 */
	private void startReconnectPolling() {
		if (rootLayout == null || destroyed || reconnectPolling) return;
		reconnectPolling = true;
		armProbeFastWindow(PROBE_FAST_WINDOW_MS);
		rootLayout.removeCallbacks(reconnectPollTick);
		rootLayout.postDelayed(reconnectPollTick, probeIntervalMs());
	}

	/** T78：停止重连状态轮询（幂等）。 */
	private void stopReconnectPolling() {
		reconnectPolling = false;
		if (rootLayout != null) rootLayout.removeCallbacks(reconnectPollTick);
	}

	/**
	 * T78：轮询节拍。守卫照抄既有会话页判据（{@code uiState == WEB && webView 可见}）：
	 * 不满足即立即收起横幅并清零计数，不推进状态机。
	 *
	 * <p>T108：周期由 {@link #probeIntervalMs()} 动态给：健康态 5s 兜底，
	 * 快档（刚进页面 / 收到推送 / 已判重连）500ms。
	 */
	private final Runnable reconnectPollTick = new Runnable() {
		@Override
		public void run() {
			if (destroyed) return;
			pollReconnectOnce();
			if (reconnectPolling && rootLayout != null) rootLayout.postDelayed(this, probeIntervalMs());
		}
	};

	/**
	 * T78：跑一次只读探针。回调里的空值/异常**一律记 UNKNOWN**，既不显示也不累计。
	 *
	 * <p>T90：探针之外**再 OR 一路 hook 上报的状态**（见 {@link #hookConnState}）——
	 * 左栏收起时 DOM 探针恒探不到，rail 下的唯一信号是 hook 那条 WebSocket 观测。
	 *
	 * <p>T108：配色到点的那些拍走 {@link #MERGED_PROBE_JS}（两条探针一次求值），
	 * 没到点的那拍只送横幅探针（配置色那段的开销不白付）。
	 */
	private void pollReconnectOnce() {
		if (destroyed) return;
		if (uiState != UiState.WEB || webView == null || webView.getVisibility() != View.VISIBLE) {
			hideReconnectBannerNow();
			return;
		}
		long now = System.currentTimeMillis();
		boolean wantBg = pageBgPolling && now >= nextBgSampleAt;
		if (wantBg) nextBgSampleAt = now + PAGE_BG_POLL_INTERVAL_MS;
		try {
			if (wantBg) {
				webView.evaluateJavascript(MERGED_PROBE_JS, this::handleMergedProbe);
			} else {
				webView.evaluateJavascript(ReconnectBanner.PROBE_JS, this::handleReconnectProbe);
			}
		} catch (Exception e) {
			if (wantBg) handleMergedProbe(null);
			else handleReconnectProbe(null);
		}
	}

	/**
	 * T108：拆合并探针的返回值。两半各自喂给**既有**消费函数（判据、抑制、防抖、
	 * 自救、配色应用一个字都没动）：{@code b} 原样交给 {@link #handleReconnectProbe}，
	 * {@code g} 交给 {@link #handlePageBackgroundResult}。
	 *
	 * <p>空值/异常：两半都按"读不到"处理（横幅记 UNKNOWN、配色保留上一次的值），
	 * 与两条独立探针各自的失败语义逐字一致。
	 */
	private void handleMergedProbe(String value) {
		if (destroyed) return;
		if (value == null || value.isEmpty() || "null".equals(value)) {
			handleReconnectProbe(null);
			return;
		}
		try {
			JSONObject o = new JSONObject(value);
			JSONObject b = o.optJSONObject("b");
			JSONObject g = o.optJSONObject("g");
			handleReconnectProbe(b == null ? null : b.toString());
			if (g != null) handlePageBackgroundResult(g.toString());
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
					// T109：补读同样是一次**推送**（只是请求-应答式），刷新新鲜度戳。
					hookConnStateAt = System.currentTimeMillis();
				});
		} catch (Exception ignored) { /* 读不到就不投票 */ }
	}

	/**
	 * T108：hook 推来一次**连接态翻转**（手机档；平板档 hook 严格 OFF ⇒ 永不进这里）。
	 *
	 * <p>做三件**只增不减**的事，任何一个都不改变既有判据：
	 * <ol>
	 *   <li>开快档窗口 ⇒ 接下来 8s 按 500ms 跑（翻转的确认窗口最需要密采样）；</li>
	 *   <li>把配色采样的欠账清零 ⇒ 下一拍顺路重采一次（页面侧主题收敛与连接态上报同源）；</li>
	 *   <li>把那拍补到现在（{@code postDelayed(…, 0)}）——**不等兜底周期**，所以手机档的
	 *       横幅时延 ≈ 推送时延 + SHOW_STREAK 的一拍，与改前（每 500ms 轮询）持平或更快。</li>
	 * </ol>
	 */
	private void onHookConnStateFlip() {
		if (destroyed) return;
		armProbeFastWindow(PROBE_FAST_WINDOW_MS);
		nextBgSampleAt = 0L;
		if (!reconnectPolling || rootLayout == null) return;
		rootLayout.removeCallbacks(reconnectPollTick);
		rootLayout.postDelayed(reconnectPollTick, 0L);
	}

	/** T78：把防抖清零（onPageCommitVisible / 退后台 / 离开会话页）。T109：横幅显示层已删，只清状态。 */
	private void hideReconnectBannerNow() {
		reconnectDebounce.reset();
	}

	/**
	 * T109：**新鲜**的 hook 连接态；陈旧（超过 {@link #HOOK_CONN_STATE_MAX_AGE_MS} 没收到
	 * 新推送）一律当 {@code null}（= 不投票 = UNKNOWN）。
	 *
	 * <p>这是 {@link #hookConnState} 的**唯一读法**（投票与节拍都用它）。
	 * 刻意**不**用在 {@link #hookSelfHealLive()} 里：那条问的是"桥/脚本到底装没装过"
	 * （历史事实，不该被新鲜度抹掉），而这条问的是"此刻该不该按它投票"（时效）。
	 * 两者混用会让健康态静默 20s 后误判成"hook 不在场" ⇒ 兜底探针从 5s 掉到 1s，
	 * 正好与"去横幅省电"的目标相反。
	 */
	private String freshHookConnState() {
		String value = hookConnState;
		if (value == null) return null;
		long at = hookConnStateAt;
		if (at <= 0L) return null;
		long age = System.currentTimeMillis() - at;
		if (age <= HOOK_CONN_STATE_MAX_AGE_MS) return value;
		if (!hookConnStateStaleLogged) {
			hookConnStateStaleLogged = true;
			Log.i("dshr-reconnect", "hookConnState 陈旧 age=" + age + "ms > "
				+ HOOK_CONN_STATE_MAX_AGE_MS + "ms（值=" + value + "）⇒ 本轮起视为 UNKNOWN，"
				+ "不再 OR 进判据；下一条推送到达即恢复");
		}
		return null;
	}

	/**
	 * T96：hook 的自愈这一侧是不是**真的在跑**（决定原生让不让位）。
	 *
	 * <p>两个条件同时成立才算"在场"：① 非平板档（平板档 hook 严格 OFF，
	 * {@code installWsStateWatch()} 第一行就 return false，观测没装）；
	 * ② hook 至少经既有 JS 桥推过一次诊断（{@code hookConnState != null}）——
	 * 只用档位判会让"桥/脚本其实没装"的手机档白等 {@link StuckRescue#TIER2_AFTER_HOOK_MS}。
	 */
	private boolean hookSelfHealLive() {
		return !isTabletClass() && hookConnState != null;
	}

	/**
	 * T96：喂一次观测给自救判定器并执行动作（分级）。
	 *
	 * @param pageReconnecting 页面/ hook 的**原始真相**：此刻确实处于「正在重连」
	 * @param observed         横幅那套语义下的观测值（可能因为"官方那条已可见"被抑制成 OK）
	 */
	private void runStuckRescue(boolean pageReconnecting, ReconnectBanner.Observed observed) {
		StuckRescue.Observed o;
		if (pageReconnecting) {
			o = StuckRescue.Observed.RECONNECTING;
		} else if (observed == ReconnectBanner.Observed.OK) {
			o = StuckRescue.Observed.OK;
		} else {
			o = StuckRescue.Observed.UNKNOWN;
		}
		StuckRescue.Action action = stuckRescue.observe(o, System.currentTimeMillis(), hookSelfHealLive());
		// T96：**升级层全程必须留痕**——实测踩过"一声不响"的坑：链路探针线程若因闸门/回调丢失
		// 迟迟不回来，`rescueLinkProbeInFlight` 一直为 true，后面每次升级都被静默挡掉，
		// 现场只有"什么都没发生"（见 report §3.4 的真机时间线）。加看门狗 + 逐条日志后，
		// 这条路要么动手、要么在 logcat 里说清楚为什么不动手。
		if (rescueReloadArmed && System.currentTimeMillis() - rescueReloadArmedAt > RELOAD_ARM_TIMEOUT_MS) {
			rescueReloadArmed = false;
			rescueLinkProbeInFlight = false;
			stuckRescue.abortReload();
			Log.w("dshr-rescue", "tier2 看门狗：链路探针 " + RELOAD_ARM_TIMEOUT_MS
				+ "ms 未回话 ⇒ 放弃本次升级（撤回配额，等下一轮）");
		}
		if (action == StuckRescue.Action.NUDGE) {
			runStuckNudge();
		} else if (action == StuckRescue.Action.RELOAD) {
			// 先查链路：通了才重载（断链上重载会把页面打成浏览器错误页，实测见 report §3）。
			rescueReloadArmed = true;
			rescueReloadArmedAt = System.currentTimeMillis();
			rescueLinkOk = false;
			Log.i("dshr-rescue", "tier2 升级意图（stuckFor=" + stuckRescue.stuckForMs(rescueReloadArmedAt)
				+ "ms reloads=" + stuckRescue.reloads() + "/" + StuckRescue.MAX_RELOADS + "）⇒ 先查链路");
			startRescueLinkProbe();
		}
	}

	/**
	 * T96 温和层：派发 {@code offline}→{@code online} 瞬态对。
	 *
	 * <p>**零痕迹**：只派事件，不写 DOM / 不换全局 / 不导航（真机逐字节 DOM 对照见
	 * scratch/t96/report.md §5）。作用是把上游正在睡的那一跳退避当场掐断并把 attempt 归零。
	 */
	private void runStuckNudge() {
		if (destroyed || webView == null) return;
		long stuck = stuckRescue.stuckForMs(System.currentTimeMillis());
		Log.i("dshr-rescue", "tier1 nudge 派发 offline→online（nudges=" + stuckRescue.nudges()
			+ " stuckFor=" + stuck + "ms hookLive=" + hookSelfHealLive() + "）");
		try {
			webView.evaluateJavascript(StuckRescue.NUDGE_JS, value -> {
				if (destroyed) return;
				Log.i("dshr-rescue", "tier1 nudge 结果=" + normaliseJsonString(value));
			});
		} catch (Exception e) {
			Log.w("dshr-rescue", "tier1 nudge 派发失败 " + e);
		}
	}

	/**
	 * T96 升级层：**受控重载**当前会话文档（等价用户手动重开 App，但不动进程、不掉会话）。
	 *
	 * <p>真值依据（scratch/t96/tablet-reload.json）：卡住态下 {@code Page.reload}
	 * （== {@code WebView.reload()}）**1.6s** 恢复，且
	 * {@code localStorage["dsh.sessions.current"]} 原样保留 ⇒ **回到同一会话**、
	 * 不落 workspace chooser（重载前后 sessionId 逐字相同）。
	 *
	 * <p><b>链路闸（必须先过）</b>：网关还断着就重载，主框架直接
	 * {@code net::ERR_CONNECTION_CLOSED} ⇒ 页面被打成浏览器错误页（实测见
	 * scratch/t96/tablet-rescue-fg-v1.json）。所以重载前由 {@link #startRescueLinkProbe()}
	 * 先问一次"网关的 HTTP 还在吗"，**只有通了才重载**。
	 *
	 * <p>四道门（任一不成立就不动）：① 会话页（非本地壳/配对页/网关错误页）；
	 * ② 主框架没有处于失败态（失败反馈由既有 {@code showGatewayFailure} 负责，不自救）；
	 * ③ {@code uiState == WEB}（用户在原生设置页时绝不抢）；④ 判定器的配额与间隔 + 链路探针已通。
	 */
	private void runStuckReload() {
		if (destroyed || webView == null) return;
		if (uiState != UiState.WEB) return;
		String url = webView.getUrl();
		if (!isSessionUrl(url) || isLocalShellUrl(url)) return;
		if (!failedMainFrameUrl.isEmpty()) return;
		if (!rescueLinkOk) {
			Log.i("dshr-rescue", "tier2 受控重载被链路闸拦下（链路不通，宁可不重载）");
			return;
		}
		long stuck = stuckRescue.stuckForMs(System.currentTimeMillis());
		Log.i("dshr-rescue", "tier2 受控重载 url=" + url + " stuckFor=" + stuck
			+ "ms reloads=" + stuckRescue.reloads() + "/" + StuckRescue.MAX_RELOADS);
		// 重载后旧观测一律作废：横幅不许活过这次动作（新文档 onPageCommitVisible 还会再清一次）。
		hideReconnectBannerNow();
		stuckRescue.onDocumentChanged();
		try {
			webView.reload();
		} catch (Exception e) {
			Log.w("dshr-rescue", "tier2 受控重载失败 " + e);
		}
	}

	/**
	 * T96：链路探针 —— 网关的 HTTP 侧现在通不通（**纯原生、零页面痕迹**）。
	 *
	 * <p>为什么不能靠页面：平板档 hook 严格 OFF、页面侧没有任何可写的地方（零痕迹契约），
	 * 而"能不能重载"必须由原生自己判断。这里用 {@link PinnedFetch}（既有可信链 + pin 语义 +
	 * 并发闸门）在**后台线程**取一次 {@code /__dsh_remote__/health}：
	 * 只判"服务器有没有回话"，任何状态码（含 404/405）都算通 —— 我们要证明的是
	 * HTTP 链路活着，不是这个端点存在。
	 *
	 * <p>开销：只在**升级层已被判定器要求重载**的那一刻发一次（卡住态下最多每 12s 一次），
	 * 健康态一次都不发。
	 */
	private void startRescueLinkProbe() {
		long now = System.currentTimeMillis();
		if (rescueLinkProbeInFlight) {
			// 看门狗（第二次防线）：只在探针**确实在飞**时挡；超时的一律当死掉重发。
			if (now - rescueLinkProbeAt > RELOAD_ARM_TIMEOUT_MS) {
				rescueLinkProbeInFlight = false;
				Log.w("dshr-rescue", "链路探针超时 " + RELOAD_ARM_TIMEOUT_MS + "ms ⇒ 重发一次");
			} else {
				return;
			}
		}
		if (destroyed || webView == null) {
			Log.w("dshr-rescue", "链路探针跳过：destroyed 或 webView 为空");
			return;
		}
		String pageUrl = webView.getUrl();
		if (!isSessionUrl(pageUrl) || isLocalShellUrl(pageUrl)) {
			Log.w("dshr-rescue", "链路探针跳过：当前不是会话页 url=" + pageUrl);
			return;
		}
		final Uri uri;
		try {
			uri = Uri.parse(pageUrl);
		} catch (Exception e) {
			Log.w("dshr-rescue", "链路探针跳过：URL 解析失败 " + pageUrl);
			return;
		}
		final String scheme = uri.getScheme();
		final String host = uri.getHost();
		final int port = uri.getPort();
		if (scheme == null || host == null) {
			Log.w("dshr-rescue", "链路探针跳过：URL 缺少 scheme/host " + pageUrl);
			return;
		}
		final String healthUrl = scheme + "://" + host + (port > 0 ? ":" + port : "") + "/__dsh_remote__/health";
		rescueLinkProbeInFlight = true;
		rescueLinkProbeAt = now;
		final String profileId = activeProfileId;
		Log.i("dshr-rescue", "链路探针发起 " + healthUrl);
		Thread t = new Thread(() -> {
			boolean ok = false;
			int status = 0;
			try {
				PinnedFetch.Result r = PinnedFetch.get(healthUrl, host, port > 0 ? port : 443,
					profileId, certPinStore(), "rescue");
				if (r != null && r.status > 0) {
					ok = true;
					status = r.status;
				}
			} catch (Throwable ignored) {
				ok = false;
			}
			final boolean okF = ok;
			final int statusF = status;
			if (rootLayout != null) rootLayout.post(() -> onRescueLinkProbe(okF, statusF));
		}, "dshr-rescue-link");
		t.setDaemon(true);
		t.start();
	}

	/** 链路探针回话（主线程）：通了才真重载，不通就撤回这次重载意图。 */
	private void onRescueLinkProbe(boolean ok, int status) {
		rescueLinkProbeInFlight = false;
		rescueLinkOk = ok;
		Log.i("dshr-rescue", "链路探针 " + (ok ? "通" : "不通") + " status=" + status
			+ " armed=" + rescueReloadArmed);
		if (!rescueReloadArmed) return;
		rescueReloadArmed = false;
		if (ok) {
			runStuckReload();
		} else {
			// 撤回：不消耗配额、episode 归零 ⇒ 链路一回来第一拍就能重新动手。
			stuckRescue.abortReload();
			Log.i("dshr-rescue", "tier2 撤回（链路不通期间绝不重载：会把页面打成浏览器错误页）");
		}
	}

	/**
	 * T78：消费一次探针结果。
	 *
	 * <p>{@code ok=0} / 空串 / {@code null} / 解析失败 ⇒ {@code UNKNOWN}（导航期静默，不累计）。
	 *
	 * <p>T90：观测值 = 探针结果 **OR** hook 上报的连接态（见下面那条判定）。
	 * 平板档 hook 严格 OFF ⇒ {@code hookConnState} 恒 null ⇒ 这一路完全不投票，
	 * 行为与 T90 之前逐字相同（平板仍是纯 DOM 探针）。
	 *
	 * <p><b>T109（去横幅）</b>：这里不再有任何 `show()/hide()` —— 横幅的显示层整层删除。
	 * 保留的是"采样 + 判据 + 记账"：观测值仍喂 {@link ReconnectBanner.Debouncer}
	 * （它现在只决定 T108 快档节拍与自救观测量），原始真相仍喂 {@link #runStuckRescue}。
	 * <p>T117：状态呈现从"设置页那行只读诊断"改为 **logcat 一行**（{@link #emitDiagLog}，
	 * 标签 {@link #DIAG_TAG}），且只在观测值真的变了时才打。
	 */
	private void handleReconnectProbe(String value) {
		if (destroyed) return;
		ReconnectBanner.Observed observed = ReconnectBanner.Observed.UNKNOWN;
		String detail = "";
		// T96：**原始真相**（探针 re=1）单独留一份。自救判定必须吃它：
		// 页面确实处于"正在重连"是事实，与"要不要给用户画一条横幅"是两件事。
		boolean pageReconnecting = false;
		if (value != null && !value.isEmpty() && !"null".equals(value)) {
			try {
				JSONObject o = new JSONObject(value);
				if (o.optInt("ok", 0) == 1) {
					if (o.optInt("re", 0) != 1) {
						observed = ReconnectBanner.Observed.OK;
					} else {
						pageReconnecting = true;
						// T109：T86 那套"官方那条与横幅带区重不重叠 ⇒ 要不要抑制"的几何判据
						// 随横幅一起删除（没有横幅就没有"同一条信息画两遍"这回事）。
						// 保留的 detail 仍带**匹配层**与元素矩形：它是设备侧"原生看到了什么"
						// 的唯一原始证据，事后对账全靠它。
						detail = "src=" + o.optInt("src", 0)
							+ " css=[" + Math.round(o.optDouble("x", 0)) + ","
							+ Math.round(o.optDouble("y", 0)) + ","
							+ Math.round(o.optDouble("w", 0)) + ","
							+ Math.round(o.optDouble("h", 0)) + "]"
							+ " vp=" + o.optInt("vw", 0) + "x" + o.optInt("vh", 0);
						observed = ReconnectBanner.Observed.RECONNECTING;
					}
				}
			} catch (Exception e) {
				observed = ReconnectBanner.Observed.UNKNOWN;
			}
		}
		// T90：**两路 OR** —— 数据源 = hook 上报的连接态 ∪ 现有 DOM 探针。
		//   ① hook 说 reconnecting（且探针没这么说）⇒ 判重连。左栏收起（rail）时官方那条
		//      指示器不渲染、探针恒 re=0，这是唯一能用的一路；
		//   ② 探针说 reconnecting ⇒ 照旧（几何抑制已随横幅删除，语义见上）；
		//   ③ hook 说 ok / ok-recovered ⇒ **不覆盖**探针的结论，也**不把 UNKNOWN 抬成 OK**
		//      （导航期静默不累计是既有语义，抬了就会把"连续为真/连续为假"跨页面累加）。
		//
		// T109（S1）：`hookConnState` 那半句是**源码契约**要求的字面量（T90 的"必须 OR
		// hook 这一路"），`freshHookConnState()` 那半句才是 T109 新加的**陈旧上界**：
		// 两条必须同时成立才投票 —— 值还在，且最近 20s 内真的收到过推送。
		// 只有前者 ⇒ 一次假 reconnecting 永久钉死（正是 T106 §S1 的静态审计结论）。
		if ("reconnecting".equals(hookConnState) && "reconnecting".equals(freshHookConnState())) {
			pageReconnecting = true;
			if (observed != ReconnectBanner.Observed.RECONNECTING) {
				observed = ReconnectBanner.Observed.RECONNECTING;
				detail = (detail.isEmpty() ? "" : detail + " ") + "hook=reconnecting";
			}
		}
		// T108：探针自己看到「正在重连」⇒ 立刻切快档。兜底周期（T117 起统一 5s）只负责"发现"，
		// 一旦发现就回到 500ms，把 SHOW_STREAK=2 的第二拍缩短到 500ms ——
		// 于是"发现并确认断开态"的时延 = 一拍兜底 + 一拍快档（最坏 5.5s），
		// 而不是"两拍兜底"（10s）。改前平板档是 1s 兜底 ⇒ 最坏 1.5s，
		// 那 4s 的发现延迟就是 T117 用 12 拍/分换来的代价，见 {@link #PROBE_IDLE_MS} 的账。
		if (pageReconnecting || observed == ReconnectBanner.Observed.RECONNECTING) {
			armProbeFastWindow(PROBE_FAST_WINDOW_MS);
		}
		reconnectProbeCount += 1;
		lastProbeObserved = observed;
		// T96：自救判定。吃**原始真相**；放在防抖的早退**之前**：
		// "要不要踹一脚"与"该不该画一条"是两件事（横幅已删，但这条纪律照旧）。
		runStuckRescue(pageReconnecting, observed);
		// 只在**日志去重键**变化时打一行，避免每 500ms 刷屏；这一行是设备侧"原生看到了什么"的
		// 唯一原始证据。T109：去重键 = 观测值 + 匹配层/几何，抑制那一维随横幅删除。
		String key = observed.name() + "|" + detail;
		if (!key.equals(lastProbeKey)) {
			lastProbeKey = key;
			Log.i("dshr-reconnect", "probe=" + observed + " " + detail);
			// T117：观测值**真的变了**才顺路打一份诊断快照（值变化时才打，零稳态开销）。
			emitDiagLog("probe", false);
		}
		// T109：只推进防抖状态机（`state()` 供 probeIntervalMs 快档与诊断行使用），
		// 不再有任何与显示相关的动作。
		reconnectDebounce.feed(observed);
	}

	/** T78/T86：上一次探针日志去重键，只为"变化时才打日志"。 */
	private String lastProbeKey = "";

	/** T109：探针累计拍数（设置页诊断行展示，替代横幅成为"原生在采样"的证据）。 */
	private int reconnectProbeCount = 0;
	/** T117 测量插桩（临时，最终字节里没有）：探针派发计数。 */
	/** T109：最近一次探针观测值（设置页诊断行展示）。 */
	private volatile ReconnectBanner.Observed lastProbeObserved = ReconnectBanner.Observed.UNKNOWN;

	/**
	 * T109：**设置页诊断行**里的"重连/探针"那一段——横幅删除后状态的唯一可见面。
	 *
	 * <p>四项各自对应一个可被追问的问题：
	 * <ol>
	 *   <li><b>hook 连接态</b>：页面侧 WebSocket 观测现在报什么（{@code null} = 未上报）；
	 *       带 {@code (陈旧)} 后缀表示超过了 {@link #HOOK_CONN_STATE_MAX_AGE_MS} 没收到新推送
	 *       ⇒ 已经不参与判据（S1 的上界可见化，不用翻 logcat）；</li>
	 *   <li><b>上次断线</b>：复用 {@code formatUiDiag} 同一份 {@code lastDisconnectAt}；</li>
	 *   <li><b>探针</b>：累计拍数 + 最近一次观测值 + 当前节拍（ms）——三者一起才能自证
	 *       "T108 的合并探针还在跑、而且跑在正确的档位上"；</li>
	 *   <li><b>快档</b>：还在快档窗口内与否（节拍的动态来源）。</li>
	 * </ol>
	 * 纯只读文本，不新增任何可点控件。
	 */
	private String reconnectDiagLine() {
		String raw = hookConnState;
		String hook;
		if (raw == null) {
			hook = "未上报";
		} else {
			long age = hookConnStateAt <= 0L ? -1L : System.currentTimeMillis() - hookConnStateAt;
			boolean stale = age < 0 || age > HOOK_CONN_STATE_MAX_AGE_MS;
			hook = raw + (stale ? "（陈旧 " + (age < 0 ? "?" : (age / 1000) + "s") + " ⇒ 不投票）" : "");
		}
		String last = "无";
		try {
			JSONObject o = TextUtils.isEmpty(uiDiagRaw) ? null : new JSONObject(uiDiagRaw);
			if (o != null) {
				Object v = o.opt("lastDisconnectAt");
				if (v instanceof Number && ((Number) v).longValue() > 0) last = "有";
				else if (v instanceof String && !TextUtils.isEmpty((String) v)) last = (String) v;
			}
		} catch (Exception ignored) {
		}
		boolean fast = System.currentTimeMillis() < probeFastUntil;
		return "重连探针：hook=" + hook + " · 上次断线 " + last
			+ " · 拍数 " + reconnectProbeCount + " · 最近 " + lastProbeObserved
			+ " · 节拍 " + probeIntervalMs() + "ms" + (fast ? "（快档窗口内）" : "");
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
			// T109：横幅的 inset 外边距随显示层删除 ⇒ 这里不再需要「同一份取值喂第二处」。
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
	 * 把状态栏/导航栏 inset 换算成 CSS 像素写入页面（--dshr-inset-top / --dshr-inset-bottom，
	 * T115 起再带上 --dshr-inset-left / -right）。
	 * 远端 DSH 页面由注入的 mobile.js 消费，本地壳页面自带同名接收端。
	 * 状态栏透明（edge-to-edge）后页面内容下移让出系统栏、背景延伸到栏后，
	 * 状态栏颜色与页面一致，实现安卓默认沉浸效果。
	 * 键盘用 translationY 抬起整页，WebView 高度不变，CSS 底 inset 始终按导航栏，
	 * 不要随 IME 清零，否则会再触发一次页面重排。
	 *
	 * <p><b>T115：平板档的取值口径与 {@link #applyDeviceClassInsets()} **逐值同源**</b>
	 * （都用 {@link #readSystemBarInsetsPx()} 的四向并集）。两个写点写同一个 API，口径不同
	 * 就会变成「谁后跑谁赢」的竞态——实测抓到了：本方法的 statusBars 口径写 24px，
	 * 而让位入口的并集口径写 36px，最终页面上剩下 24px（该 AVD 的 captionBar 是 72px 高，
	 * statusBars 只有 48px，并集取 max ⇒ 36 CSS px）；若页面停在 24px，内容会压在
	 * captionBar 那一层里。
	 * 手机档口径**逐值不变**（statusBars / navigationBars / DisplayCutout），
	 * 它的 --dshr-inset-* 行为已被真机取证，不动。
	 */
	private void applyInsetsToPage(WebView view) {
		if (view == null) return;
		WindowInsets insets = getWindow().getDecorView().getRootWindowInsets();
		if (insets == null) return;
		float density = getResources().getDisplayMetrics().density;
		int top;
		int bottom;
		int left;
		int right;
		if (isTabletClass()) {
			int[] avoid = readSystemBarInsetsPx();
			left = Math.round(avoid[0] / density);
			top = Math.round(avoid[1] / density);
			right = Math.round(avoid[2] / density);
			bottom = Math.round(avoid[3] / density);
		} else {
			int topPx;
			int bottomPx;
			int leftPx = 0;
			int rightPx = 0;
			if (Build.VERSION.SDK_INT >= 30) {
				topPx = insets.getInsets(WindowInsets.Type.statusBars()).top;
				bottomPx = insets.getInsets(WindowInsets.Type.navigationBars()).bottom;
			} else {
				topPx = insets.getSystemWindowInsetTop();
				bottomPx = insets.getStableInsetBottom();
			}
			if (Build.VERSION.SDK_INT >= 28) {
				DisplayCutout cut = insets.getDisplayCutout();
				if (cut != null) {
					leftPx = cut.getSafeInsetLeft();
					rightPx = cut.getSafeInsetRight();
				}
			}
			top = Math.round(topPx / density);
			bottom = Math.round(bottomPx / density);
			left = Math.round(leftPx / density);
			right = Math.round(rightPx / density);
		}
		writeInsetsToPage(view, top, bottom, left, right);
	}

	/**
	 * 页面 inset 的**唯一写入口**（T115）：把四向（CSS px）交给页面。
	 * 与 {@link #applyInsetsToPage(WebView)} 共用同一段 JS，两条来源（系统栏口径 /
	 * 避让四向口径）写的是同一个 API，页面上不会出现两个写点打架。
	 */
	private void writeInsetsToPage(WebView view, int top, int bottom, int left, int right) {
		if (view == null) return;
		view.evaluateJavascript(
			"(function(){var s=window.__dshRemoteInsets;if(s&&typeof s.set==='function')s.set("
				+ top + "," + bottom + "," + left + "," + right + ");})()",
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
	 * 平板档位的系统栏让位（契约 3.6 / 验收 G5）。
	 *
	 * <p><b>T115（用户口径「系统栏走安卓原生透明 + 页面自己让位」）：让位改由页面自己做。</b>
	 * 本方法仍是**唯一让位入口**（触发时机不变：setUiState / onResume / 系统栏变化 / 旋转折叠），
	 * 但它现在做两件事，而且顺序有语义：
	 * <ol>
	 *   <li>{@link #setWebViewInsetsBox(int, int, int, int)} <b>恒写 0</b>：WebView 覆盖全窗，
	 *       状态栏/导航栏后面显示的是**页面自己画的像素**，不再是父容器底色——
	 *       这正是「平板两条带与页面有 6 级色差硬缝」的根治点（带 = 页面，不可能再有缝）。</li>
	 *   <li>把四向（CSS px）写进页面 {@code --dshr-inset-*}，由 hook 的**平板作用域 CSS**
	 *       让内容（不是背景）让开系统栏。</li>
	 * </ol>
	 *
	 * <p><b>为什么不再用外边距</b>：T80 的实验结论（外边距改 View 尺寸 ⇒ 页面视口真的收缩）
	 * 依然成立，但它的**代价**在平板档是结构性的：WebView 一缩，系统栏后面那圈就只剩
	 * 父容器底色一种颜色，而平板官方布局在贴边那一行本来就是**两色**
	 * （左侧栏 {@code --dsw-specific-sidebar-fill} / 会话面板 {@code --dsw-alias-bg-base}）。
	 * 单色带不可能同时对上两色 ⇒ 面板那一侧必留缝。T115 实测：2560 宽里 1919 px（75.0%）
	 * 与页面差 ΔRGB=(6,5,4)。页面自己让位时带就是页面本身，ΔRGB=0 是构造性的。
	 *
	 * <p><b>手机档逐值不变</b>：那里本来就恒 0 让位 + {@code --dshr-inset-*} 透传，
	 * 本方法只是把同一形态推广到平板档；本地壳页（uiState != WEB）不写页面，避免双重留白。
	 */
	private void applyDeviceClassInsets() {
		if (webView == null) return;
		// ① 让位恒落「页面自己」：WebView 四向外边距一律 0（全窗覆盖）。
		setWebViewInsetsBox(0, 0, 0, 0);
		boolean pad = isTabletClass() && uiState == UiState.WEB;
		if (!pad) return;
		WindowInsets insets = getWindow().getDecorView().getRootWindowInsets();
		if (insets == null) return;
		// T78：取值本体抽到 readSystemBarInsetsPx()（掩码含 systemBars|displayCutout|tappableElement，
		// 任务栏报成 tappableElement 时也兜得住）。T115 起这四向不再进外边距，而是进页面。
		int[] avoid = readSystemBarInsetsPx();
		float density = getResources().getDisplayMetrics().density;
		int left = Math.round(avoid[0] / density);
		int top = Math.round(avoid[1] / density);
		int right = Math.round(avoid[2] / density);
		int bottom = Math.round(avoid[3] / density);
		// ② 内容让位交给页面：四向 CSS px 写进 --dshr-inset-*（同一个 API，与 applyInsetsToPage 同源）。
		writeInsetsToPage(webView, top, bottom, left, right);
		// T72：让位量本身**上 logcat**。T67 之所以只能做代码路径级证明、拿不到像素级证据，
		// 根因就是 padding 算完就丢、谁也看不见：这行日志让"系统栏占位 vs 应用留白"在真机上
		// 直接可对账（dshr-inset 标签）。T115 起同时打「原生像素四向」与「页面 CSS 四向」
		// 以及布局盒取值，谁在让位一眼可辨。只在平板会话档且四向变化时打，避免刷屏。
		if (left != lastAvoidL || top != lastAvoidT || right != lastAvoidR || bottom != lastAvoidB) {
			lastAvoidL = left; lastAvoidT = top; lastAvoidR = right; lastAvoidB = bottom;
			Log.i("dshr-inset", "avoid(px) l=" + avoid[0] + " t=" + avoid[1] + " r=" + avoid[2] + " b=" + avoid[3]
				+ " page(css) l=" + left + " t=" + top + " r=" + right + " b=" + bottom
				+ " box=0,0,0,0 tablet=" + isTabletClass() + " uiState=" + uiState);
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
	 * <p><b>T115：这个方法是「全窗覆盖」的写入口，当前唯一调用值就是 0,0,0,0。</b>
	 * 平板档的让位已改由页面承担（见 {@link #applyDeviceClassInsets()}）——因为外边距方案
	 * 的代价是系统栏后面只剩父容器一种底色，而平板官方布局贴边那一行本来是两色，
	 * 单色带必然留缝。本方法保留下来是因为它仍是**唯一**能改 WebView 布局盒的地方：
	 * 换设备档位（平板↔手机、折叠展开、旋转）时必须有一条确定性的路径把外边距收回 0，
	 * 否则上一次让位会残留在新档位上。
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
			// T94：系统深浅色变化 ⇒ 页面（跟随系统时）底色跟着变 ⇒ 立刻只读重采一次。
			requestPageBackground();
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

	// ---------- T94：让位后露出的那两条，跟页面同色（沉浸） ----------

	/**
	 * T94：**只读**页面背景探针。取「贴着系统栏那条边、页面实际画出来的颜色」。
	 *
	 * <p>为什么不能读 {@code body} 的背景色：DSH 的 {@code html} 背景是透明的、
	 * {@code body} 是 #FFFFFF/#151517，而用户看到的那条"灰底"其实是**左栏容器**自己的底色
	 * （浅色 #F9FAFB / 深色 #1B1B1C，实测见 scratch/t94/report.md §1）——
	 * 读 body 只会拿回改动前就已经硬编码的那个值，等于没读。
	 * 所以这里从 {@code elementFromPoint} 命中的元素**逐层向上合成**
	 * {@code background-color}（含 alpha 混色），得到的就是该点**真实的可见底色**。
	 *
	 * <p>采样点：(2,2) 与 (2, h-3)，即内容盒的左上/左下角——正是两条带**正下方**那一列。
	 * 两条带整宽只有一种颜色，而页面在平板上是「左栏 + 主列」两段底色，
	 * 取左栏那一列是**刻意**的：用户的症状就是"左侧栏灰底、上下却白"。
	 * 主列那侧的残差在实测里 ≤7/255（≈2.7%），肉眼不可辨；选择理由与残差数字见报告 §3.4。
	 *
	 * <p>只读：本探针不 setAttribute / 不写 style / 不建节点，平板档零痕迹（契约 3.5）不受影响。
	 * 返回**对象**而不是 JSON 字符串——evaluateJavascript 会把字符串结果再编码一层，
	 * 那样 {@code new JSONObject(value)} 直接抛异常（同 officialStatusDetail 的注释）。
	 */
	private static final String PAGE_BG_PROBE_JS = "(function(){try{"
		+ "var p=function(c){var m=/^rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:\\s*[,/]\\s*([\\d.%]+))?\\s*\\)$/.exec(String(c||''));"
		+ "if(!m)return null;var r=m[4];var a=r===undefined?1:(r.indexOf('%')>=0?parseFloat(r)/100:parseFloat(r));return[+m[1],+m[2],+m[3],a];};"
		+ "var b=function(t,o){var a=t[3];return[t[0]*a+o[0]*(1-a),t[1]*a+o[1]*(1-a),t[2]*a+o[2]*(1-a),1];};"
		+ "var bg=function(el){return el?p(getComputedStyle(el).backgroundColor):null;};"
		+ "var e=function(x,y){var el=document.elementFromPoint(x,y);var s=[];"
		+ "while(el){var c=bg(el);if(c&&c[3]>0)s.push(c);el=el.parentElement;}"
		+ "if(!s.length){var ht=bg(document.documentElement);if(ht&&ht[3]>0)s.push(ht);"
		+ "var bd=bg(document.body);if(bd&&bd[3]>0)s.push(bd);}"
		+ "if(!s.length)return null;var o=s[s.length-1];for(var i=s.length-2;i>=0;i--)o=b(s[i],o);"
		+ "return[Math.round(o[0]),Math.round(o[1]),Math.round(o[2])];};"
		+ "var h=innerHeight|0;"
		+ "var k=function(ys){for(var i=0;i<ys.length;i++){var v=e(2,ys[i]);if(v)return v;}return null;};"
		+ "var t=k([2,h>>4,h>>2,h>>1]);var bo=k([Math.max(0,h-3),h-(h>>4),h>>1]);"
		+ "return {t:t,b:bo,d:!!(document.body&&document.body.hasAttribute('data-ds-dark-theme'))};"
		+ "}catch(x){return {};}})()";

	/**
	 * T108：**合并探针**——一次 {@code evaluateJavascript} 同时取回横幅判据与页面配色。
	 *
	 * <p>为什么能合并：两条探针本来就是**同源同只读**的两个 IIFE（各自返回一个对象），
	 * 这里只在外面套一层壳、把两个返回值装进 {@code {b:…,g:…}}，**没有复制任何判据**
	 * （{@code ReconnectBanner.PROBE_JS} 与 {@link #PAGE_BG_PROBE_JS} 仍是唯一真相源）。
	 * 收益：需要采样配色的那一拍从 **2 次跨进程求值压成 1 次**（改前是两条独立定时器：
	 * 横幅 500ms + 配色 1500ms ⇒ 每秒 2.67 次求值）。
	 *
	 * <p>⚠️ **声明位置必须在 {@link #PAGE_BG_PROBE_JS} 之后**：用简单名引用"文本上更晚声明的
	 * static final 字段"属于 JLS 8.3.3 的 illegal forward reference，编译直接报
	 * {@code 错误: 非法的前向引用}（本轮实测踩到，见 report §4.0）。所以这个常量放在这里，
	 * 紧跟 {@code PAGE_BG_PROBE_JS}。
	 */
	private static final String MERGED_PROBE_JS =
		"(function(){try{var b=" + ReconnectBanner.PROBE_JS + ";var g=" + PAGE_BG_PROBE_JS
			+ ";return {b:b,g:g};}catch(e){return {b:{ok:0}};}})()";

	/**
	 * T94：轮询间隔。主题可能在页面里随时被改（官方设置面板手选浅色/深色）⇒ 只能定期只读重采。
	 *
	 * <p><b>T108：从「1.5s 常开轮询」改成「事件驱动优先 + 低频兜底」</b>。三个**事件**入口
	 * 直接把 {@code nextBgSampleAt} 清零 ⇒ 下一拍立刻重采（不必等兜底周期）：
	 * <ol>
	 *   <li>{@code onResume}（回前台，用户可能在后台改过主题/系统深浅色）；</li>
	 *   <li>{@code onPageCommitVisible}（新文档，首帧底色就该是新的）；</li>
	 *   <li>hook 的连接态推送（同一份 {@code setUiDiag} 载荷里带着页面侧主题收敛的结果）；</li>
	 * </ol>
	 * 兜底周期取 {@code 3000ms}：它在**快档（500ms）**下是每 6 拍采一次、在**平板兜底（1000ms）**
	 * 下是每 3 拍采一次，两种节奏下都比改前的 1.5s 密（旧值 1500ms 在 500ms 拍上根本不是整数倍，
	 * 与横幅探针各跑各的 ⇒ 每秒 2.67 次跨进程求值）。主题跟随的最坏时延因此从 1.5s 放宽到
	 * {@code 3000ms + 一拍}（实测真值见 scratch/t108/report.md §4.2），事件路径仍是即时。
	 */
	private static final long PAGE_BG_POLL_INTERVAL_MS = 3000L;

	/** T94：读一次页面背景色。只读、幂等、失败静默。 */
	private void requestPageBackground() {
		if (webView == null || destroyed) return;
		if (uiState != UiState.WEB || webView.getVisibility() != View.VISIBLE) return;
		try {
			webView.evaluateJavascript(PAGE_BG_PROBE_JS, this::handlePageBackgroundResult);
		} catch (Exception ignored) { /* 取不到 ⇒ 保留上一次的值 */ }
	}

	/**
	 * T94：消费一次探针结果。空 / {@code null} / 缺 {@code t} ⇒ **什么都不做**
	 * （保留上一次取到的颜色，避免主题切换瞬间闪回白条）。
	 */
	private void handlePageBackgroundResult(String value) {
		if (destroyed || value == null || value.isEmpty() || "null".equals(value)) return;
		int top;
		int bottom;
		boolean dark;
		try {
			JSONObject o = new JSONObject(value);
			top = packRgb(o.optJSONArray("t"));
			if (top == PAGE_BG_NONE) return;
			bottom = packRgb(o.optJSONArray("b"));
			dark = o.optBoolean("d", pageDark);
		} catch (Exception e) {
			return;
		}
		if (bottom == PAGE_BG_NONE) bottom = top;
		if (top == pageBgTop && bottom == pageBgBottom && dark == pageDark) return;
		Log.i("dshr-immersive", "page-bg top=" + hexOf(top) + " bottom=" + hexOf(bottom)
			+ " dark=" + dark + " tablet=" + isTabletClass() + " uiState=" + uiState);
		pageBgTop = top;
		pageBgBottom = bottom;
		pageDark = dark;
		applySystemBars();
	}

	/** T94：`[r,g,b]` → {@code 0xFFRRGGBB}；缺失/越界各通道夹到 0..255，缺数组返回 NONE。 */
	private static int packRgb(org.json.JSONArray a) {
		if (a == null || a.length() < 3) return PAGE_BG_NONE;
		int r = Math.max(0, Math.min(255, a.optInt(0, 0)));
		int g = Math.max(0, Math.min(255, a.optInt(1, 0)));
		int b = Math.max(0, Math.min(255, a.optInt(2, 0)));
		return 0xFF000000 | (r << 16) | (g << 8) | b;
	}

	/** T94：日志用 {@code #RRGGBB}（不回落到 float 格式，避免默认 Locale 插逗号）。 */
	private static String hexOf(int color) {
		return String.format(java.util.Locale.US, "#%06X", color & 0xFFFFFF);
	}

	/**
	 * T94：会话档那两条要画成的颜色。探针没取到 ⇒ **逐值退回**改动前的硬编码取值
	 * （{@code dark ? 0xFF141414 : Color.WHITE}），保证探针失败时的行为与改动前一致。
	 */
	private int sessionBarColor(boolean dark) {
		if (uiState == UiState.WEB && pageBgTop != PAGE_BG_NONE) return pageBgTop;
		return dark ? 0xFF141414 : Color.WHITE;
	}

	/**
	 * T94：启动页面背景采样（幂等）。T108：不再自带定时器——它只置一个"该采"的闸，
	 * 真正的采样由重连探针那一拍顺路合并（见 {@link #MERGED_PROBE_JS}），
	 * 于是**每秒跨进程求值次数**由两条定时器并成一条。
	 *
	 * <p>生命周期与改前逐字相同：{@code onResume} 起 / {@code onPause} 停
	 * （T94ImmersiveTest 的源码契约钉的就是这两个入口的调用点）。
	 */
	private void startPageBgPolling() {
		if (rootLayout == null || destroyed || pageBgPolling) return;
		pageBgPolling = true;
		nextBgSampleAt = 0L;   // 起的那一刻就欠一拍，合并探针下一拍立刻带上配色
	}

	/** T94：停止页面背景采样（幂等）。T108：只落闸，没有定时器要停。 */
	private void stopPageBgPolling() {
		pageBgPolling = false;
	}

	/** T94：换了文档就作废上一页取到的颜色（一次导航的首帧不该沿用旧页底色）。 */
	private void resetPageBackground() {
		pageBgTop = PAGE_BG_NONE;
		pageBgBottom = PAGE_BG_NONE;
		nextBgSampleAt = 0L;   // T108：新文档 ⇒ 下一拍立刻重采（首帧底色必须对）
	}

	private void applySystemBars() {
		boolean session = uiState == UiState.WEB;
		boolean dark = session ? pageDark : isSystemDark();
		// 平板档位恒为沉浸态：hook 关闭、页面不知道自己拿的是「缩过」的视口，
		// 状态栏必须透明 + 让位，不能沿用手机档「注入失败退实色」的判定。
		boolean tabletSession = session && isTabletClass();
		boolean edge = !session || tabletSession || edgeToEdgeChrome;
		// T94：三条都取**同一个**值 ⇒ 系统栏区域与页面连成一片。
		//   ① rootLayout 是那两条真正的底（T80 把让位落成 WebView 外边距之后，露出的就是它）；
		//   ② 窗口状态栏/导航栏色也钉成它（三者一致）——有些形态系统**忽略**着色
		//      （API 35 + targetSdk 34 实测：手势导航下 navigationBarColor 本就不生效，
		//      见 scratch/t94/report.md §1.3），那时就靠 ① 兜住，像素一样是对的。
		// 探针没取到颜色时 sessionBarColor() 逐值退回改动前的硬编码取值。
		int strip = sessionBarColor(dark);
		boolean sampled = session && pageBgTop != PAGE_BG_NONE;
		if (rootLayout != null) rootLayout.setBackgroundColor(session
			? strip : shellColor(R.color.shell_background));
		if (!session) {
			tintShell(homeScroll);
			tintShell(setupScroll);
		}
		// T80：平板档下状态栏/导航栏露出的是「让位外边距」那圈**父容器底色**（rootLayout 已钉成
		// 页面底色，见上），不再指望 WebView 自己的 padding 区；WebView 底色仍钉到页面底色，
		// 用来盖住页面首帧前的空白。
		if (tabletSession && webView != null) {
			webView.setBackgroundColor(strip);
		}
		// 只在适配已启用的会话中透明：各列 CSS inset 留空间，背景画到手势条下。
		// T94：取到页面真实底色后，底部这条也用页面色（= 页面自己画在那里的颜色）；
		// 取不到时逐值退回改动前的「沉浸则透明 / 否则实色」。
		int nav = sampled ? pageBgBottom : (edge ? Color.TRANSPARENT : (dark ? 0xFF141414 : Color.WHITE));
		// T115：平板会话档让位已改由页面自己承担（WebView 覆盖全窗）⇒ 状态栏/导航栏交还给
		// 页面自己的像素，原生两条栏**真的透明**（用户口径「系统栏改走安卓原生透明」）。
		// 这里是显式覆盖而不是改写上面那两条取值式：T94 的「三条一致」契约在手机档与
		// 本地壳页仍然逐字保留（那边页面本来就不覆盖系统栏区，靠取色对齐）。
		if (tabletSession) nav = Color.TRANSPARENT;
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
			getWindow().setStatusBarColor(sampled ? strip : Color.TRANSPARENT);
			flags |= View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
			if (Build.VERSION.SDK_INT >= 28) {
				attrs.layoutInDisplayCutoutMode =
					WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
			}
		} else {
			getWindow().setStatusBarColor(sampled ? strip : (dark ? 0xFF141414 : Color.WHITE));
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
		// T115：平板会话档两条栏一律透明（页面自己画到栏后，原生不得再盖一层不透明色）。
		// 放在 if/else 之后覆盖两条分支，避免改写 T94 断言钉住的那两条取值式。
		if (tabletSession) getWindow().setStatusBarColor(Color.TRANSPARENT);
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
	 * T117：把 WebView 的 cookie 存储**立刻**刷到磁盘（带一行日志，便于事后对账）。
	 *
	 * <p>为什么必须有它：网关的设备凭据 {@code dr_device} 是**配对成功那一刻**由网关
	 * Set-Cookie 下发的 HttpOnly cookie；WebView 默认把它先留在内存、随后批量落盘。
	 * 改前唯一的落盘点在 {@code onPause}（退后台）⇒ <b>前台直接 force-stop 就整条丢掉</b>，
	 * 下一次进来网关认不出设备、又跳回配对页（用户侧表现为"明明配对过还要再配一次"）。
	 *
	 * <p>落点选在两种"写入成功"之后：
	 * <ul>
	 *   <li>{@link #enterSessionPage}：配对成功后落到会话文档 = 配对成功的**可观测点**；</li>
	 *   <li>{@link #handleImportIntent}：导入链接把配置组写进 SharedPreferences 之后。</li>
	 * </ul>
	 * 都是低频事件（一次会话一次），不是周期调用；{@code flush()} 本身是批量的、不阻塞调用线程。
	 */
	private void flushDeviceCookies(String reason) {
		try {
			CookieManager.getInstance().flush();
			Log.i("dshr-perf", "cookie flush ok（" + reason + "）");
		} catch (Exception e) {
			Log.w("dshr-perf", "cookie flush 失败（" + reason + "）：" + e);
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
		// T117：**配对成功的落点就是这里** —— 用户在配对页提交一次性码之后，网关用
		// Set-Cookie 下发 dr_device（HttpOnly）并 302 到会话页，于是本方法在会话文档上被调用。
		// 此刻立刻 flush 一次 WebView 的 cookie 存储：否则 cookie 只在内存里，
		// "前台直接 force-stop（不经 onPause 那条 flush）"会让它整条丢掉 ⇒ 下次进来又落回配对页。
		// 实测（本任务装置，2/2 复现）：改前强杀后点直连节点落 `__dsh_remote__/pair`；
		// 加了这一句之后落会话页 `/`。flush() 是批量的、不阻塞调用线程，只在"进会话"这类
		// 低频时刻调用，不做周期调用。
		flushDeviceCookies("enterSession");
		applySystemBars();
		// T108：进会话是"一次进入"——开快档窗口（进会话后前 8s 按 500ms 跑，
		// 保证「刚进页面就断」这一档与改前同速发现），并欠一次配色采样。
		armProbeFastWindow(PROBE_FAST_WINDOW_MS);
		// T94：进会话立刻只读采一次页面底色（否则首帧会先用退回色，等下一次轮询才纠正）。
		requestPageBackground();
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
		// T94：回到仍存活的会话文档：底色沿用文档现值（不重置），补读一次即可。
		requestPageBackground();
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

	/**
	 * 「这个 URI 是不是**当前网关自己**」——只按 **主机 + 端口 + 同族协议** 判。
	 *
	 * <p><b>T109（P0-3·发布阻塞）</b>：改前这一行的协议判定是
	 * {@code "http".equals(scheme) || "https".equals(scheme)}，于是 {@code wss://} 恒 false。
	 * {@link #handleSslError} 的第一道闸就是 {@code !isActiveGatewayUri(...) ⇒ handler.cancel()}，
	 * 而 WebSocket 的 TLS 握手错误**也**走 {@code onReceivedSslError}（{@code error.getUrl()}
	 * 给的正是 {@code wss://…}）⇒ 每一次**冷**握手都被静默 cancel，只有 Chromium 复用
	 * 一条已经建好的热 https 连接时才连得上。真机表现就是「换网/长时间空闲后 mux 连不上，
	 * 而且毫无线索」（无日志、无弹窗）。
	 *
	 * <p><b>为什么只松协议这一维、不放松整体策略</b>：这条判定是**信任边界的门**——
	 * 它决定「要不要用本网关的证书 pin / 要不要放行这个 TLS 错误」。放松主机或端口等于
	 * 把任意第三方 origin 拉进 pin 语义（MITM 面直接打开）；放松协议的全部代价只是承认
	 * 「{@code wss://host:port} 与 {@code https://host:port} 是同一个端点的两种传输形态」
	 * ——RFC 6455 的 WebSocket 握手本来就是 HTTP/HTTPS 的升级（`Upgrade: websocket`），
	 * 同一 host:port 上的 ws↔http / wss↔https 是**同一台服务器**，这不是新信任，是承认既有事实。
	 * 因此这里只把「web 族」从 {http, https} 扩到 {http, https, ws, wss}，
	 * 且**要求两端安全级别一致**（明文族 {http, ws} ↔ 加密族 {https, wss}）：
	 * 明文 {@code ws://} 不会因为这条被当成 {@code https://} 网关的同一个端点。
	 */
	private boolean isActiveGatewayUri(Uri uri) {
		if (TextUtils.isEmpty(activeUrl) || uri == null) return false;
		try {
			Uri base = Uri.parse(activeUrl);
			String scheme = uri.getScheme();
			return isGatewaySchemeFamily(scheme)
				&& sameGatewaySecurityLevel(base.getScheme(), scheme)
				&& TextUtils.equals(base.getHost(), uri.getHost())
				&& effectivePort(base) == effectivePort(uri);
		} catch (Exception ignored) {
			return false;
		}
	}

	/** T109：web 族协议（同一台服务器上的两种传输形态）。{@code null} 一律不是。 */
	private static boolean isGatewaySchemeFamily(String scheme) {
		return "http".equals(scheme) || "https".equals(scheme)
			|| "ws".equals(scheme) || "wss".equals(scheme);
	}

	/** T109：加密族 = {https, wss}；明文族 = {http, ws}。跨族不算同一个端点。 */
	private static boolean isSecureGatewayScheme(String scheme) {
		return "https".equals(scheme) || "wss".equals(scheme);
	}

	/** T109：两端的**安全级别**必须一致（https↔wss 可以，http↔wss 不行）。 */
	private static boolean sameGatewaySecurityLevel(String a, String b) {
		return isGatewaySchemeFamily(a) && isGatewaySchemeFamily(b)
			&& isSecureGatewayScheme(a) == isSecureGatewayScheme(b);
	}

	/**
	 * T109：从 URL 里安全地取 scheme（只用于日志）。
	 *
	 * <p>为什么不直接用 {@code Uri.parse(url).getScheme()}：{@code handleSslError} 是
	 * **异常路径**，日志本身绝不能再抛（抛了就把真正的失败原因盖掉了）。所以这里只做
	 * 一次字符串切分：`scheme:` 之前那段，非法输入返回 {@code "-"}。
	 */
	private static String schemeOf(String url) {
		if (TextUtils.isEmpty(url)) return "-";
		int colon = url.indexOf(':');
		if (colon <= 0) return "-";
		return url.substring(0, colon).toLowerCase(Locale.US);
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
		// T109：wss 与 https 同为 443、ws 与 http 同为 80（RFC 6455 §3：默认端口随底层传输）。
		// 少了这半行，`wss://host/`（省略端口）会被算成 80 ⇒ 与 `https://host:443/` 的网关
		// 判成两个端点，P0-3 那类"网关自己不算网关"的误判又会从另一条缝里钻回来。
		return isSecureGatewayScheme(uri.getScheme()) ? 443 : 80;
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
			// T109：**每一次 cancel 都要留痕**。改前这里（以及下面"非网关 URI"那一支）
			// 是完全静默的——现场只有"连不上"，连"谁把它取消了"都查不出来。
			Log.w("dshr-ssl", "SslError cancel：上一次证书决定尚未落地（awaitingCertificateDecision）"
				+ ", url=" + error.getUrl() + ", primaryError=" + error.getPrimaryError());
			handler.cancel();
			return;
		}
		String errorUrl = error.getUrl();
		if (TextUtils.isEmpty(errorUrl) || !isActiveGatewayUri(Uri.parse(errorUrl))) {
			// T109（P0-3 的诊断面）：这条路径改前是**纯静默 cancel**，于是
			// 「wss:// 被误判成非网关 ⇒ WebSocket 冷握手被取消」在真机上没有任何线索。
			// 现在把三件事一次说清：被判为非网关的 URL、当前网关 URL、底层错误码，
			// 事后一条 logcat 就能区分「不是本网关（设计如此）」与「应该是本网关但判错了」。
			Log.w("dshr-ssl", "SslError cancel：非当前网关 URI ⇒ 不 proceed"
				+ ", url=" + errorUrl + ", active=" + activeUrl
				+ ", primaryError=" + error.getPrimaryError());
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
			// T109（P0-3 的验收钩子）：放行也要留痕，且**必须带上 scheme**。
			// 为什么非打不可：cancel 那两支现在都有日志了，可"放行"这一支原本一条都没有
			// ⇒ 事后无法回答"WebSocket 的 wss 握手到底有没有走到这里"。P0-3 的因果链正是
			// 「wss 到达 handleSslError → 被 isActiveGatewayUri 判成非网关 → cancel」，
			// 有了这一行，设备侧一次冷握手就能直接对上：`scheme=wss` 出现即证明
			// WS 的 TLS 握手确实走这条路径（改前它在下一行就被静默 cancel 掉了）。
			Log.i("dshr-ssl", "SslError 放行：本网关 URI ⇒ proceed"
				+ ", scheme=" + (TextUtils.isEmpty(errorUrl) ? "-" : schemeOf(errorUrl))
				+ ", url=" + schemeOf(errorUrl) + "://" + base.getHost() + ":"
				+ effectivePort(base) + " (pin=" + decision.source + ")");
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
			emitDiagLog("chooser", true);
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

	/** 写文件选择器诊断（T117 起只进 logcat，不再上屏）。 */
	private void setChooserDiag(String s) {
		chooserDiag = s == null ? "" : s;
		runOnUiThread(() -> emitDiagLog("chooser", true));
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
				// T102：设置页的返回键**只有一条** —— 回会话（隧道/页面都还在，不重连）。
				// 改前这里先看 `settingsViaBackKey`：为 true（会话根按返回键进设置）就退到后台
				// —— 那是为了防止「会话 ⇄ 设置」死循环。返回键已不再进设置页（见 finishWebBack()），
				// 死循环的成因消失，这个判据与它的字段一并删除（无死代码残留）。
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
			// T102：**返回键不再进 App 连接设置页**（两档一致）。
			//
			// 判据只问一件事：**除左抽屉之外**还有没有要收的东西（弹层 / 官方右栏）？
			//   有 → 走既有桥（与手机档同一条通道，T43/T47「右栏打开态只关右栏」逐字保留）；
			//   无 → 直接 finishWebBack() ⇒ 会话根落到 moveTaskToBack(true) 退到后台。
			//
			// 为什么不改桥本身：桥在 hook 里（mobile-web.js，并行任务正在改，本次一个字节都不能碰），
			// 且桥的「关左抽屉」是**最后一个**分支（前面依次是 sheet / explorer / dialog / 右栏）。
			// 所以"先确认前几个分支都没东西可关 ⇒ 跳过整次调用"与"调用后恰好只走到最后一个分支
			// 再把它当作什么都没关"在语义上等价，而跳过的代价是**左抽屉保持展开**。
			if (isTabletClass()) {
				webView.evaluateJavascript(TABLET_BACK_OVERLAY_PROBE_JS, value -> {
					if (value != null && value.contains("none")) {
						finishWebBack();
						return;
					}
					// 'overlay'（有弹层/右栏）与任何异常、空回话都退回**既有语义**（fail-safe：
					// 宁可多收一次弹层，也不把"该关的弹层"漏过去）。
					closeOverlaysThenFinish();
				});
				return;
			}
			closeOverlaysThenFinish();
			return;
		}
		super.onBackPressed();
	}

	/**
	 * 会话内返回（**只剩一件事**）：先关官方弹层/侧栏（由 JS 处理，见
	 * {@link #closeOverlaysThenFinish()}）；再仅在同一网关内 goBack；
	 * 到会话根、且没有任何东西可收 ⇒ {@code moveTaskToBack(true)} **退到后台**。
	 *
	 * <p><b>T102</b>：本方法末尾不再打开连接设置页（T65「手机档也进设置页」与
	 * T99「平板档一次返回进设置页」两条都被本任务取消 —— 进设置页只保留显式入口）。
	 * 历史演变：T43/T47 起会话根就是「先关右栏/弹层，没得关就退到后台」（**原始语义**）；
	 * T65 改成手机档进设置页；T99 改成平板档也进设置页、且平板档此处不再收官方左抽屉。
	 * 本任务把末尾那一跳改回退后台，另两条成果**都保留**（桥通道与「不看左抽屉」一字未动）。
	 *
	 * <p>方法名保留 {@code finishWebBack}（历史名，改动面最小）：现在的含义是
	 * 「会话内返回处理到底」——要么 goBack、要么退到后台。
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
		// 没有侧栏要收（同一个回调，或平板档探针已确认无弹层）、WebView 也没有同网关的上一页可回。
		//
		// T102：**退到后台**（任务仍在 Recents、隧道与进程都活着，与 CONNECTING 分支同一条既有路径），
		// 不再跳去 App 连接设置页（改前末尾那句调用已整句删除）。
		// 因此这里也不会再有「会话根 → 设置 → 返回 → 会话」的死循环，
		// 那个一次性标记（settingsViaBackKey）已随本次改动删除。
		// 右栏/弹层打开态不受影响：桥收掉了东西时回调返回 true，本方法根本不会被调用
		// （T43/T47 已验证的语义原样保留）。
		moveTaskToBack(true);
	}

	/**
	 * T99 起：会话页返回键的「收弹层」通道 —— 就是 T43/T47 起就有的那条 hook 返回键桥。
	 *
	 * <p>抽成方法**只为复用**（手机档 / 平板档+有弹层两条路径同一条），JS 字面量**逐字节未改**
	 * （`!value.contains("true")` 才继续走 {@link #finishWebBack()} 的判据也没动）。
	 * 桥的收拢顺序：sheet → Explorer 详情 → 模态弹框 → 官方右栏 → **最后才**官方左抽屉；
	 * 因此"桥返回 true"既可能是收了右栏（要留在会话页），也可能是收了左抽屉（T99 起平板档
	 * 不该发生——平板档只在探针确认有非左抽屉弹层时才会调到这里）。
	 *
	 * <p>T102：本方法**一字未改**（收弹层语义保留）；变的只是它下游
	 * {@link #finishWebBack()} 在"什么都没收到"时退后台，而不是进设置页。
	 */
	private void closeOverlaysThenFinish() {
		if (webView == null) return;
		webView.evaluateJavascript(
			"(function(){var bridge=window.__dshRemoteAndroidMobile;return !!(bridge&&bridge.closeSidebarIfExpanded&&bridge.closeSidebarIfExpanded());})()",
			value -> {
				if (value == null || !value.contains("true")) finishWebBack();
			}
		);
	}

	/**
	 * T99：平板档返回键的**只读**前置探针 —— 「除左抽屉外还有东西要收吗」。
	 *
	 * <p>返回三个取值（`evaluateJavascript` 回话是 JSON 字符串，故原生侧用 {@code contains} 判）：
	 * <ul>
	 *   <li>{@code none}：没有任何弹层/右栏要收 ⇒ 原生**不调桥**，直接 {@link #finishWebBack()}
	 *       （T102 起落到「会话根 ⇒ 退后台」；左抽屉保持展开，绝不会被当作"要收的东西"）。</li>
	 *   <li>{@code overlay}：有 sheet / Explorer 详情 / 模态弹框 / 官方右栏 ⇒ 调既有桥收它，
	 *       仍在会话页（T43/T47 右栏语义原样保留）。</li>
	 *   <li>{@code error}：探针自身异常 ⇒ 原生按"非 none"处理，退回既有桥（fail-safe）。</li>
	 * </ul>
	 *
	 * <p>四个判据与 hook 桥的前四个分支**同源同序**（`[data-dshr-sheet-panel]` 可见、
	 * `data-dshr-explorer-details=1`、可见的 `[role="dialog"][aria-modal="true"]`、
	 * `[data-sidebar-right-panel][data-sidebar-right-open]` 且 `aria-hidden!=true`），
	 * 可见性口径与 hook 的 {@code isVisible()} 一致（{@code getClientRects().length>0}）。
	 * 顺序在这里**不影响正确性**（只要"有任意一个"就返回 overlay），但保持一致便于对账。
	 *
	 * <p>纯只读：不写 DOM/CSS/存储、不派发事件、不注册监听、不起定时器
	 * （由 {@code android/tests/T99BackKeyTest.java} 的只读性断言钉住）。
	 */
	private static final String TABLET_BACK_OVERLAY_PROBE_JS = "(function(){try{"
		+ "var vis=function(n){return !!(n&&n.getClientRects&&n.getClientRects().length>0);};"
		+ "var sheet=document.querySelector('[data-dshr-sheet-panel]');"
		+ "if(sheet&&vis(sheet))return 'overlay';"
		+ "if(document.documentElement.getAttribute('data-dshr-explorer-details')==='1')return 'overlay';"
		+ "var ds=document.querySelectorAll('[role=\"dialog\"][aria-modal=\"true\"]');"
		+ "for(var i=0;i<ds.length;i++){if(vis(ds[i]))return 'overlay';}"
		+ "var rp=document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open]');"
		+ "if(rp&&rp.getAttribute('aria-hidden')!=='true')return 'overlay';"
		+ "return 'none';}catch(e){return 'error';}})()";

	private final class AppBridge {
		@JavascriptInterface
		public void openSettings() {
			runOnUiThread(() -> showConnectionSettings());
		}

		@JavascriptInterface
		public void setPageDark(boolean dark) {
			runOnUiThread(() -> {
				applyPageDark(dark);
				// T108：页面侧主题**翻转**才会过桥（hook 的 syncPageTheme 自带 lastPageDark 去重）
				// ⇒ 这是一条真正的事件源：立刻只读重采一次页面底色，**不等兜底周期**。
				// 改前靠 1.5s 常开轮询发现，改后靠这条事件（兜底 3s 只兜"事件没来"的漏）。
				requestPageBackground();
			});
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
			String previousConnState = hookConnState;
			hookConnState = parseUiDiagWsState(json);
			// T109：**每一次推送都刷新时刻戳**（不只是翻转时）——陈旧上界判的是
			// "推送链路还有没有在说话"，不是"状态有没有变"。健康态下 hook 也会按
			// 兜底节拍重复上报同一状态，那些重复正是"链路还活着"的证据。
			hookConnStateAt = System.currentTimeMillis();
			if (hookConnState != null && !hookConnState.equals(previousConnState)) {
				// 值真的换了 ⇒ 陈旧告警的"只报一次"闸复位，下一次陈旧还能报出来。
				hookConnStateStaleLogged = false;
			}
			// T108：**推送即真相**——连接态真的翻转时（hook 侧按去抖键只在翻转时上报），
			// 原生不再等下一拍兜底：立刻切快档 + 补办一拍，横幅时延由推送决定。
			// 只在这个字段**真的变化**时才投递（同状态重复上报不会产生任何额外工作）。
			if (hookConnState != null && !hookConnState.equals(previousConnState)) {
				// ⚠️ 必须写成 lambda 而不是 `this::onHookConnStateFlip`：这里的 `this` 是
				// 内部类 AppBridge（不是 MainActivity），方法引用会绑定错对象、编译直接报
				// "方法引用无效"（本轮实测踩到，见 report §4.0 的构建自证）。
				runOnUiThread(() -> onHookConnStateFlip());
			}
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
			// T117：诊断不再上屏 ⇒ 这里改成往 logcat 打一份（**非**用户触发，走最小间隔闸 +
			// 值变化判重；hook 侧本来就去抖，所以这里通常什么都不打）。
			runOnUiThread(() -> emitDiagLog("setUiDiag", false));
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
