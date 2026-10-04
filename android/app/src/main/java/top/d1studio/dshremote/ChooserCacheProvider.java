package top.d1studio.dshremote;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * T39：WebView 文件选择器的**兜底 ContentProvider**（自研极简，零依赖，只用框架 API）。
 *
 * <p>为什么需要它：WebView 的 {@code onReceiveValue(Uri[])} 拿到 {@code content://} 后，
 * 由浏览器侧在本进程内经 {@code ContentResolver} 打开 URI 再把字节交给渲染进程。
 * 当 OEM 选择器返回的 URI 读不了（缺 grant / 0 字节 / provider 行为异常）时，
 * 页面拿到的是 0 字节，于是「选完什么都没多」——**全程无任何报错**。
 * 我们把内容先复制进 App 私有缓存，再由本 provider 以一个**我们自己完全掌控、
 * 必然可读、名称与大小都准确**的 URI 交给 WebView，把这条静默链路截断。
 *
 * <p>安全模型：
 * <ul>
 *   <li>{@code android:exported="false"} —— 只允许本进程访问。对外不对开。</li>
 *   <li>{@code android:grantUriPermissions="true"} —— 保留框架按 URI 授权的能力，
 *       便于将来需要把某个缓存文件分享给别的进程时不必改 manifest。</li>
 *   <li>{@link #getFileForUri} 对文件名做白名单校验（只允许单段、禁止 {@code ..} 与分隔符），
 *       杜绝 {@code content://…/chooser/../../databases/x} 这类路径穿越。</li>
 * </ul>
 *
 * <p>零依赖：本类只 import {@code android.*} 与 {@code java.io.*}，
 * 不引入任何三方库（仓库为手写 build.ps1 的零依赖构建，见 build.ps1 头注释）。
 */
public class ChooserCacheProvider extends ContentProvider {

	/** manifest 里必须与此字符串一致（android:authorities）。 */
	static final String AUTHORITY = "top.d1studio.dshremote.choosercache";

	/** 缓存子目录名，位于 {@code Context.getCacheDir()} 下（系统可随时回收）。 */
	private static final String CACHE_SUBDIR = "chooser";

	/** 扩展名/元数据都拿不到时的兜底 MIME。 */
	static final String MIME_DEFAULT = "application/octet-stream";

	/**
	 * query() 暴露的列。{@code _display_name} 与 {@code _size} 是 WebView/Chromium
	 * 取文件名与大小的标准列名（{@link OpenableColumns}），必须用这两个，
	 * 否则页面拿不到 name/size，退化成又一段"静默什么都不显示"。
	 */
	private static final String[] QUERY_COLUMNS = {
		OpenableColumns.DISPLAY_NAME,
		OpenableColumns.SIZE,
		"mime_type",
	};

	@Override
	public boolean onCreate() {
		return true;
	}

	// ---------- URI <-> 缓存文件 ----------

	/** 缓存根目录：{@code getCacheDir()/chooser}，不存在则建。 */
	static File cacheDir(Context ctx) throws IOException {
		File dir = new File(ctx.getCacheDir(), CACHE_SUBDIR);
		if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
			throw new IOException("无法创建选择器缓存目录：" + dir);
		}
		return dir;
	}

	/** 由缓存文件构造对外 URI。 */
	static Uri uriFor(File file) {
		return new Uri.Builder()
			.scheme("content")
			.authority(AUTHORITY)
			.appendPath(file.getName())
			.build();
	}

	/**
	 * T41-F2：清空缓存目录里的全部文件，返回删除成功的个数。目录本身保留（下次复用）。
	 *
	 * <p>为什么必须清：这些副本是用户选过的文件的**原名**副本，若只增不减，就与 App
	 * “退出即清、不留痕迹”的口径（{@code onDestroy} 里 {@code WebStorage.deleteAllData()}）
	 * 自相矛盾；而且“每个不同展示名一个文件、每个上限 64MB”意味着目录可以无上限增长。
	 * 由 {@code MainActivity.onDestroy} 在 {@code webView.destroy()} **之后**调用。</p>
	 *
	 * <p>并发安全：调用点在 WebView 已 destroy 之后，不会再有新的 {@code openFile}；
	 * 已经打开的 fd 在 POSIX 语义下 unlink 后仍可读完（Android 的 ext4/f2fs 都如此），
	 * 所以与“正在被 WebView 读取”不冲突。逐个 {@code delete()}、失败不抛，
	 * 最多残留个别文件由系统按 cache 策略回收。</p>
	 */
	static int purgeCache(Context ctx) {
		File dir = new File(ctx.getCacheDir(), CACHE_SUBDIR);
		File[] kids = dir.listFiles();
		if (kids == null) return 0;
		int removed = 0;
		for (File f : kids) {
			try {
				// 只删本目录下的单层文件/空目录，不递归、不跟随符号链接。
				if (f.isDirectory()) {
					if (deleteEmptyDir(f)) removed++;
				} else if (f.delete()) {
					removed++;
				}
			} catch (Throwable ignored) { // 删不掉就留着，不影响退出流程
			}
		}
		return removed;
	}

	private static boolean deleteEmptyDir(File d) {
		String[] kids = d.list();
		if (kids == null || kids.length > 0) return false;
		return d.delete();
	}

	/**
	 * URI → 缓存文件。文件名非法（空、含分隔符、含 {@code ..}）一律抛
	 * {@link FileNotFoundException}，不落到"猜一个路径"。
	 */
	private File getFileForUri(Uri uri) throws FileNotFoundException {
		Context ctx = getContext();
		if (ctx == null) throw new FileNotFoundException("provider 未初始化");
		String name = uri.getLastPathSegment();
		if (name == null || name.isEmpty()
				|| name.contains("/") || name.contains("\\")
				|| name.equals(".") || name.equals("..")
				|| name.contains("..")) {
			throw new FileNotFoundException("非法缓存文件名：" + name);
		}
		File f = new File(new File(ctx.getCacheDir(), CACHE_SUBDIR), name);
		// 双保险：解析后的绝对路径必须仍在缓存目录内。
		try {
			String root = new File(ctx.getCacheDir(), CACHE_SUBDIR).getCanonicalPath();
			if (!f.getCanonicalPath().startsWith(root + File.separator)) {
				throw new FileNotFoundException("缓存路径越界：" + name);
			}
		} catch (IOException e) {
			throw new FileNotFoundException("缓存路径不可解析：" + name);
		}
		if (!f.isFile()) throw new FileNotFoundException("缓存文件不存在：" + name);
		return f;
	}

	/** 扩展名 → MIME；认不出就用 {@link #MIME_DEFAULT}。 */
	static String mimeOf(String name) {
		int dot = name.lastIndexOf('.');
		if (dot >= 0 && dot < name.length() - 1) {
			String ext = name.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
			String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
			if (mime != null && !mime.isEmpty()) return mime;
		}
		return MIME_DEFAULT;
	}

	// ---------- ContentProvider ----------

	@Override
	public Cursor query(Uri uri, String[] projection, String selection,
						String[] selectionArgs, String sortOrder) {
		File f;
		try {
			f = getFileForUri(uri);
		} catch (FileNotFoundException e) {
			// 查不到就返回空游标而不是抛异常：让调用方（Chromium）走"没有这个文件"的
			// 正常分支，而不是把整条选择器链路炸掉。
			return new MatrixCursor(QUERY_COLUMNS);
		}
		// projection 为 null 时返回全列；指定了子集时按顺序取交集。
		String[] cols = (projection == null || projection.length == 0) ? QUERY_COLUMNS : projection;
		MatrixCursor c = new MatrixCursor(cols, 1);
		Object[] row = new Object[cols.length];
		for (int i = 0; i < cols.length; i++) {
			String col = cols[i];
			if (OpenableColumns.DISPLAY_NAME.equals(col)) {
				row[i] = f.getName();
			} else if (OpenableColumns.SIZE.equals(col)) {
				row[i] = f.length();
			} else if ("mime_type".equals(col)) {
				row[i] = mimeOf(f.getName());
			} else {
				row[i] = null;
			}
		}
		c.addRow(row);
		return c;
	}

	@Override
	public String getType(Uri uri) {
		String name = uri.getLastPathSegment();
		return (name == null || name.isEmpty()) ? MIME_DEFAULT : mimeOf(name);
	}

	@Override
	public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
		File f = getFileForUri(uri);
		// 这些是**只读**的缓存副本：任何含写意图的打开方式一律拒绝，
		// 避免 Chromium 侧的意外写入把我们的缓存搞坏。
		if (mode != null && mode.contains("w")) {
			throw new FileNotFoundException("选择器缓存只读，拒绝模式：" + mode);
		}
		return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
	}

	/**
	 * {@code ContentProvider.insert} 的签名返回 {@link Uri}（不是 int，别写错），
	 * 且是抽象方法必须实现。选择器缓存是纯只读的落地通道，任何写入都直接拒绝。
	 */
	@Override
	public Uri insert(Uri uri, ContentValues values) {
		throw new UnsupportedOperationException("选择器缓存只读");
	}

	@Override
	public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
		throw new UnsupportedOperationException("选择器缓存只读");
	}

	@Override
	public int delete(Uri uri, String selection, String[] selectionArgs) {
		throw new UnsupportedOperationException("选择器缓存只读");
	}
}
