package android.text;

/** Only the framework utility used by ProfileStore / MainActivity; not packaged into the APK. */
public final class TextUtils {
    public static boolean isEmpty(CharSequence value) {
        return value == null || value.length() == 0;
    }

    /**
     * T109：`MainActivity.isActiveGatewayUri()` 用到的第二个工具（主机名相等判定）。
     * 语义与框架一致：两边都为 null 算相等，否则 {@code a.equals(b)}。
     */
    public static boolean equals(CharSequence a, CharSequence b) {
        if (a == b) return true;
        int length;
        if (a != null && b != null && (length = a.length()) == b.length()) {
            if (a instanceof String && b instanceof String) {
                return a.equals(b);
            }
            for (int i = 0; i < length; i++) {
                if (a.charAt(i) != b.charAt(i)) return false;
            }
            return true;
        }
        return false;
    }
}
