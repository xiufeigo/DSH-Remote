package top.d1studio.dshremote;

/** 添加服务器卡片宽度：窄屏必须整张落在屏幕里，宽屏保持 400dp 上限。 */
public class WelcomeMetricsTest {
	static int checks;

	static void check(boolean ok, String label) {
		if (!ok) throw new AssertionError(label);
		checks++;
		System.out.println("ok " + label);
	}

	public static void main(String[] args) {
		// 360dp 手机、xxhdpi（density 3）：屏幕 1080px。旧卡片 400dp = 1200px，加上 24dp 页边距更宽。
		int phone = WelcomeMetrics.cardWidthPx(1080, 48, 1200);
		check(phone == 1080 - 48 * 2, "360dp xxhdpi card uses the inner width");
		check(phone + 48 * 2 <= 1080, "360dp card plus margins stays on screen");
		check(1200 > 1080, "the old fixed 400dp card is wider than this phone");

		// 360dp、density 2.75（常见 1080 宽屏换算约 392dp，这里直接用 360*2.75）。
		int compact = WelcomeMetrics.cardWidthPx(990, 44, 1100);
		check(compact + 44 * 2 <= 990, "density 2.75 360dp card fits");

		// 平板：内宽超过 400dp 时封顶，仍然留出两侧空白。
		int tablet = WelcomeMetrics.cardWidthPx(1600, 32, 800);
		check(tablet == 800, "tablet card caps at 400dp");
		check(tablet + 32 * 2 <= 1600, "tablet card stays inside the window");

		// 比留白还窄的窗口：卡片退回整屏宽，不能算出负数。
		int tiny = WelcomeMetrics.cardWidthPx(40, 48, 400);
		check(tiny == 40 && tiny > 0, "narrower than the margins uses the full screen");

		int zero = WelcomeMetrics.cardWidthPx(0, 16, 400);
		check(zero == 1, "non-positive screen width still returns a positive card");

		System.out.println("WelcomeMetrics tests passed: " + checks);
	}
}
