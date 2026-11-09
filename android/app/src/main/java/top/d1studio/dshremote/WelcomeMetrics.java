package top.d1studio.dshremote;

/**
 * 添加服务器卡片的宽度。不依赖 Android，JVM 单测可以直接跑。
 *
 * 旧实现把卡片写死成 400dp 再水平居中。360dp 一类手机上卡片比屏幕宽，
 * 左右被裁掉，标签、输入框和「保存并连接」都会探出屏幕。
 * 这里保证：屏幕放得下两侧留白时，卡片宽度加两侧留白不超过屏幕；
 * 宽屏再封顶到 maxCardPx，避免表格在平板上拉成一整条。
 */
public final class WelcomeMetrics {
	private WelcomeMetrics() {}

	public static int cardWidthPx(int screenPx, int sidePx, int maxCardPx) {
		if (screenPx < 1) screenPx = 1;
		if (sidePx < 0) sidePx = 0;
		int inner = screenPx - sidePx * 2;
		if (inner < 1) inner = screenPx;
		if (maxCardPx > 0 && inner > maxCardPx) return maxCardPx;
		return inner;
	}
}
