package android.text;

/** Only the framework utility used by ProfileStore; not packaged into the APK. */
public final class TextUtils {
    public static boolean isEmpty(CharSequence value) {
        return value == null || value.length() == 0;
    }
}
