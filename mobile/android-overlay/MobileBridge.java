package com.rippaadventures.node;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;

/**
 * THE WEBVIEW BRIDGE — the satellite's own in-app APK updater.
 *
 * THE PROBLEM IT SOLVES. A Rippa node is a sideloaded APK on a tablet that is
 * physically bolted to a desk. There is no Play Store account, no MDM and no
 * fleet push channel, so the only way a bug fix reaches a running node is: a new
 * APK is published, and the node fetches and installs it itself. Before this class
 * the app had no route to the package installer at all, which is why every update
 * until now was a USB cable and an operator with a laptop.
 *
 * WHY A RAW @JavascriptInterface AND NOT A CAPACITOR PLUGIN. The Capacitor bridge
 * is asynchronous and promise-shaped, which is right for the worker's telemetry.
 * This is not telemetry: it is a user-initiated action that ends in platform UI,
 * and `getAppVersion()` is a plain synchronous string read the page makes while
 * it is still painting. A `@JavascriptInterface` returns that directly; a plugin
 * call cannot.
 *
 * REGISTERED BY MainActivity, NOT BY THIS CLASS. `WebView.addJavascriptInterface`
 * is a WebView API, and this is a Capacitor app — the WebView belongs to the
 * bridge, not to us.
 *
 * THE SECURITY POSTURE, WHICH IS THE WHOLE POINT OF DOING THIS CAREFULLY.
 * `addJavascriptInterface` exposes these methods to ANY page the WebView loads,
 * so the surface is deliberately tiny and every entry point validates its input:
 *
 *   1. Only http/https URLs are fetched. `file://`, `content://` and
 *      `javascript:` are rejected outright, so a hostile or compromised page
 *      cannot use the bridge as a local-file reader.
 *   2. The downloaded archive's package name MUST equal our own. This is the
 *      load-bearing control: whatever else happens, the installer is only ever
 *      offered an update to this app. A URL pointing at some other .apk gets the
 *      file deleted, not installed.
 *   3. The archive's versionCode must be >= the installed one, so the operator is
 *      never asked to approve a downgrade the installer will reject with jargon.
 *   4. An optional SHA-256 can be supplied; the download is discarded unless it
 *      matches, which catches a truncated or tampered payload before the installer
 *      ever sees it.
 *
 * WHY NOT DownloadManager. DownloadManager can only write to
 * `externalFilesDir` or the public volume — NOT to `getExternalCacheDir()`, which
 * is the app-scoped directory the specified file_paths.xml maps and the only one
 * that needs no storage permission. Streaming there also means no
 * BroadcastReceiver to register, no polling loop, and no new dependency in an APK
 * whose entire build story is "add nothing".
 */
public class MobileBridge {

    /** Log tag. Shares "RippaNode" with the service so one `adb logcat -s` shows all. */
    private static final String TAG = "RippaNode";

    /** The JS-visible name this object is registered under. Must match MainActivity. */
    public static final String NAME = "mobileBridge";

    /** Downloaded file name. Stable, so a retry overwrites rather than accumulates. */
    private static final String APK_FILE_NAME = "rippa-update.apk";

    /** In-progress suffix, so a killed download can never look like a whole one. */
    private static final String PART_SUFFIX = ".part";

    /** The CustomEvent the page listens for. */
    private static final String EVENT_NAME = "rippa-update";

    private static final int CONNECT_TIMEOUT_MS = 20_000;
    private static final int READ_TIMEOUT_MS = 60_000;
    private static final int BUFFER_BYTES = 64 * 1024;

    private final Activity activity;
    private final WebView webView;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    /**
     * One download at a time.
     *
     * Without this, a double-tapped "Update" button starts two threads writing the
     * same file and the installer can be handed a half-written APK. A dropped tap
     * is recoverable; an un-installable APK on a tablet in the field is not.
     */
    private volatile boolean downloading = false;

    public MobileBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    // --- VERSION REPORTING -----------------------------------------------------

    /**
     * The installed app version, so the page can compare itself to the Mothership.
     *
     * Returns `BuildConfig.VERSION_NAME`, which is generated from the root
     * package.json version by scripts/package-apk.mjs. It has to be done there:
     * AGP 8 no longer emits BuildConfig unless the feature is switched on, and
     * Capacitor's template hard-codes versionName "1.0", which would make every
     * tablet in the fleet claim to be on the same build forever. The
     * PackageManager read below is a runtime fallback for a blank constant, so the
     * page never sees "" and quietly concludes it is up to date.
     *
     * Synchronous by design — the page reads this while painting.
     */
    @JavascriptInterface
    public String getAppVersion() {
        String version = BuildConfig.VERSION_NAME;
        if (version != null && !version.trim().isEmpty()) {
            return version;
        }
        try {
            PackageInfo info = activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), 0);
            return info.versionName == null ? "" : info.versionName;
        } catch (Exception error) {
            Log.w(TAG, "Could not read the package version: " + error);
            return "";
        }
    }

    /** The installed versionCode, so the page can order two builds reliably. */
    @JavascriptInterface
    public int getAppVersionCode() {
        try {
            return activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), 0).versionCode;
        } catch (Exception error) {
            return 0;
        }
    }

    /**
     * Whether this app may install packages right now (Android 8+).
     *
     * Exposed so the dashboard can grey out "Update" and prompt BEFORE downloading
     * 40 MB, rather than after.
     */
    @JavascriptInterface
    public boolean canInstallPackages() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return true; // the pre-O install flow needed no per-app grant
        }
        try {
            return activity.getPackageManager().canRequestPackageInstalls();
        } catch (Exception error) {
            return false;
        }
    }

    // --- THE UPDATER -----------------------------------------------------------

    /** Downloads and installs an APK. No integrity check. */
    @JavascriptInterface
    public void installApkUpdate(String apkUrl) {
        installApkUpdate(apkUrl, null);
    }

    /**
     * Downloads `apkUrl` into the app cache and hands it to the system installer.
     *
     * @param expectedSha256 optional lowercase hex SHA-256 of the APK. When given,
     *                       a file that does not match is deleted rather than
     *                       installed. Pass null or "" to skip the check.
     *
     * Returns immediately: the work happens on its own thread and the page learns
     * the outcome from the `rippa-update` CustomEvent. Blocking here would stall the
     * WebView's JS thread for the length of a download, which on a tablet is
     * exactly the kind of jank that gets the app killed from the background.
     */
    @JavascriptInterface
    public void installApkUpdate(final String apkUrl, final String expectedSha256) {
        final Uri source;
        try {
            source = validateUrl(apkUrl);
        } catch (Exception error) {
            fail("bad-url", describe(error));
            return;
        }

        if (downloading) {
            fail("busy", "An update is already downloading.");
            return;
        }
        downloading = true;
        event("started", apkUrl);

        new Thread(new Runnable() {
            @Override
            public void run() {
                File apk = null;
                try {
                    apk = download(source, expectedSha256);
                } catch (Exception error) {
                    downloading = false;
                    Log.e(TAG, "APK download failed", error);
                    fail("download-failed", describe(error));
                    return;
                }
                // Everything below touches the Activity and the WebView, so it
                // belongs on the main thread. The download did not.
                final File ready = apk;
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            promptInstall(ready);
                        } catch (Exception error) {
                            Log.e(TAG, "Install prompt failed", error);
                            fail("install-failed", describe(error));
                        } finally {
                            downloading = false;
                        }
                    }
                });
            }
        }, "rippa-apk-update").start();
    }

    // --- DOWNLOAD --------------------------------------------------------------

    /**
     * Streams the APK into the cache, then proves it is this app before anything
     * else is allowed to happen to it.
     *
     * @return the downloaded file, ready to hand to FileProvider.
     */
    private File download(Uri source, String expectedSha256) throws Exception {
        File dir = cacheDir();
        if (dir == null) {
            throw new IOException("No cache directory is available.");
        }
        File target = new File(dir, APK_FILE_NAME);
        File partial = new File(dir, APK_FILE_NAME + PART_SUFFIX);
        // Clear whatever a previous attempt left, including a half-written file.
        deleteQuietly(target);
        deleteQuietly(partial);

        HttpURLConnection connection = (HttpURLConnection) new URL(source.toString())
                .openConnection();
        connection.setInstanceFollowRedirects(true);
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        /*
          identity encoding, deliberately. Under gzip the platform transparently
          uncompresses the stream but leaves Content-Length describing the COMPRESSED
          size, so the length check below would then reject a perfectly good
          download. Better to ask for the bytes as they are.
        */
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("User-Agent", "RippaNode-Updater");

        try {
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                throw new IOException("The server answered " + status + ".");
            }

            long declared = connection.getContentLengthLong();
            long written = copy(connection.getInputStream(), partial, declared);

            /*
              A download cut off by a dropped Wi-Fi link is the single most likely
              failure here, and the installer would otherwise be handed a truncated
              archive and report "App not installed" with no hint as to why.
            */
            if (declared > 0 && written != declared) {
                deleteQuietly(partial);
                throw new IOException(
                        "The download was cut short (" + written + " of " + declared + " bytes).");
            }
            if (written <= 0) {
                deleteQuietly(partial);
                throw new IOException("The server sent an empty file.");
            }

            if (expectedSha256 != null && !expectedSha256.trim().isEmpty()) {
                String actual = sha256(partial);
                if (!actual.equalsIgnoreCase(expectedSha256.trim())) {
                    deleteQuietly(partial);
                    throw new IOException("Checksum mismatch: this is not the expected build.");
                }
            }

            assertItIsThisApp(partial);

            if (!partial.renameTo(target)) {
                // A rename within one directory does not fail on any real device,
                // but if it ever did the downloaded file is still perfectly usable.
                Log.w(TAG, "Could not rename the downloaded APK; using it in place.");
                return partial;
            }
            event("downloaded", String.valueOf(written));
            return target;
        } finally {
            connection.disconnect();
        }
    }

    /**
     * Pumps the response body to disk, reporting progress as it goes.
     *
     * Progress is only computed when the server told us a length; without one it
     * would be a guess, and a percentage that jumps backwards is worse than none.
     */
    private long copy(InputStream input, File destination, long declaredLength) throws IOException {
        long total = 0;
        int lastPercent = -1;
        InputStream source = input;
        FileOutputStream sink = null;
        try {
            sink = new FileOutputStream(destination);
            byte[] buffer = new byte[BUFFER_BYTES];
            int read;
            while ((read = source.read(buffer)) != -1) {
                sink.write(buffer, 0, read);
                total += read;
                if (declaredLength > 0) {
                    int percent = (int) ((total * 100) / declaredLength);
                    // Every 10%, and only when it moved: a 40 MB APK emits a few
                    // hundred messages otherwise.
                    if (percent / 10 > lastPercent / 10) {
                        lastPercent = percent;
                        event("progress", percent + "%");
                    }
                }
            }
            sink.flush();
            // fsync before we trust the file. A tablet can lose power mid-write and
            // a cached-but-unsynced 40 MB file is a corrupt APK waiting to happen.
            sink.getFD().sync();
            return total;
        } finally {
            closeQuietly(sink);
            closeQuietly(source);
        }
    }

    /**
     * THE GATE. Refuses anything that is not a newer-or-equal build of THIS app.
     *
     * Without this, `installApkUpdate()` is a package installer that any page the
     * WebView happens to visit can point at an arbitrary .apk. It is four checks
     * and one delete, and it is the reason the bridge is safe to expose at all.
     */
    private void assertItIsThisApp(File apk) throws IOException {
        PackageManager manager = activity.getPackageManager();
        PackageInfo archive = manager.getPackageArchiveInfo(apk.getAbsolutePath(), 0);
        if (archive == null || archive.packageName == null) {
            deleteQuietly(apk);
            throw new IOException("The downloaded file is not a readable Android package.");
        }

        String self = activity.getPackageName();
        if (!self.equals(archive.packageName)) {
            deleteQuietly(apk);
            throw new IOException("Refusing to install " + archive.packageName
                    + ": this updater only installs " + self + ".");
        }

        try {
            long installed = manager.getPackageInfo(self, 0).versionCode;
            if (archive.versionCode < installed) {
                deleteQuietly(apk);
                throw new IOException("Build " + archive.versionCode
                        + " is older than the installed " + installed + ".");
            }
        } catch (PackageManager.NameNotFoundException error) {
            // Cannot happen (it is our own package), and a missing self would make
            // the comparison meaningless rather than dangerous. Carry on.
            Log.w(TAG, "Installed package not resolvable while checking an update.", error);
        }
    }

    /**
     * Where the APK is written.
     *
     * External cache first, because that is what the overlay's file_paths.xml maps
     * as `external-cache-path`. Internal cache is the fallback and it is mapped too
     * (`cache-path`), so a device with no mounted external volume still works —
     * and, unlike a shared directory, neither location needs a storage permission.
     */
    private File cacheDir() {
        File external = activity.getExternalCacheDir();
        if (external != null) {
            if (external.exists() || external.mkdirs()) {
                return external;
            }
            Log.w(TAG, "Could not create " + external + "; falling back to internal cache.");
        }
        return activity.getCacheDir();
    }

    // --- INSTALL ---------------------------------------------------------------

    /** Shows the system package installer for the downloaded APK. Main thread only. */
    private void promptInstall(File apk) throws IOException {
        if (activity.isFinishing() || activity.isDestroyed()) {
            throw new IOException("The app was closed before the update could start.");
        }

        /*
          Android 8+ requires the USER to grant this app permission to install
          packages. Asking the installer anyway is a dead end — the system either
          throws ActivityNotFoundException or shows an error the operator cannot act
          on — so we go and get the grant first, and tell the page to retry once
          they have been through Settings.
        */
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !activity.getPackageManager().canRequestPackageInstalls()) {
            openUnknownSourcesSettings();
            fail("permission-required",
                    "Allow Rippa Node to install updates, then tap Update again.");
            return;
        }

        Context context = activity.getApplicationContext();
        Uri apkUri = FileProvider.getUriForFile(
                context, context.getPackageName() + ".provider", apk);

        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
        /*
          FLAG_GRANT_READ_URI_PERMISSION is what makes the content:// URI readable by
          the installer process, and FLAG_ACTIVITY_NEW_TASK keeps this legal from the
          application context. Neither is optional: without the grant the installer
          cannot open the file, and without NEW_TASK the platform throws "Calling
          startActivity() from outside of an Activity context".
        */
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        // ClipData carries the grant as well. Some OEM installers read the
        // permission only from here and ignore the flag on the intent itself, which
        // shows up as an installer that opens onto "Open with" and nothing else.
        intent.setClipData(ClipData.newRawUri("", apkUri));

        try {
            activity.startActivity(intent);
            event("installing", apk.getName());
        } catch (ActivityNotFoundException error) {
            throw new IOException("This device has no package installer available.", error);
        }
    }

    /** Sends the operator to the one Settings screen that can grant the install. */
    private void openUnknownSourcesSettings() {
        Uri self = Uri.parse("package:" + activity.getPackageName());
        // The package-scoped screen exists from API 26; the generic one is the
        // fallback for OEM builds that only ship that. resolveActivity() is
        // deliberately NOT used to choose between them: since API 30 it needs a
        // <queries> declaration to return anything but null, so it would report a
        // perfectly working settings screen as missing.
        Intent scoped = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, self);
        scoped.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            activity.startActivity(scoped);
            return;
        } catch (ActivityNotFoundException ignored) {
            // fall through to the generic screen
        }
        try {
            activity.startActivity(
                    new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES));
        } catch (ActivityNotFoundException error) {
            Log.w(TAG, "No unknown-sources settings screen on this device.", error);
        }
    }

    // --- PLUMBING --------------------------------------------------------------

    /**
     * Tells the page what happened.
     *
     * The bridge methods return void, so this event is the ONLY way the dashboard
     * can tell "downloading" from "installed" from "the server was down". Detail is
     * `{"state": "...", "message": "..."}` on a `rippa-update` CustomEvent.
     */
    private void event(final String state, final String message) {
        if (webView == null) {
            return;
        }
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    String script = "window.dispatchEvent(new CustomEvent('" + EVENT_NAME
                            + "', { detail: { state: " + quote(state)
                            + ", message: " + quote(message) + " } }));";
                    // evaluateJavascript must be called on the UI thread, and this
                    // class is called from a download thread as well as the bridge.
                    webView.evaluateJavascript(script, null);
                } catch (Exception error) {
                    // Never let a progress notification be the thing that breaks an
                    // otherwise-fine update.
                    Log.w(TAG, "Could not notify the page: " + error);
                }
            }
        });
    }

    /** Reports a failure to the page and to logcat. The page is the operator's window. */
    private void fail(String state, String message) {
        Log.w(TAG, state + ": " + message);
        event("error", state + ": " + message);
    }

    /** Quotes a string for embedding in a script. JSONObject.quote is on every device. */
    private static String quote(String value) {
        return value == null ? "null" : org.json.JSONObject.quote(value);
    }

    private static String describe(Throwable error) {
        String message = error.getMessage();
        return message == null || message.isEmpty()
                ? error.getClass().getSimpleName()
                : message;
    }

    /** Only http(s). Anything else is a local-file read or an injection attempt. */
    private static Uri validateUrl(String apkUrl) throws IOException {
        if (apkUrl == null || apkUrl.trim().isEmpty()) {
            throw new IOException("No APK URL was supplied.");
        }
        Uri uri = Uri.parse(apkUrl.trim());
        String scheme = uri.getScheme();
        if (scheme == null) {
            throw new IOException("The APK URL has no scheme: " + apkUrl);
        }
        scheme = scheme.toLowerCase(Locale.US);
        if (!"https".equals(scheme) && !"http".equals(scheme)) {
            throw new IOException("Refusing to fetch a '" + scheme + "' URL.");
        }
        if (uri.getHost() == null) {
            throw new IOException("The APK URL has no host.");
        }
        return uri;
    }

    private static String sha256(File file) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            // SHA-256 is mandated on every Android release this app supports.
            throw new IOException("SHA-256 is unavailable on this device.", error);
        }
        InputStream input = null;
        try {
            input = new FileInputStream(file);
            byte[] buffer = new byte[BUFFER_BYTES];
            int read;
            while ((read = input.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
        } finally {
            closeQuietly(input);
        }
        StringBuilder hex = new StringBuilder(64);
        for (byte value : digest.digest()) {
            hex.append(String.format(Locale.US, "%02x", value));
        }
        return hex.toString();
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.exists() && !file.delete()) {
            Log.w(TAG, "Could not delete " + file);
        }
    }

    private static void closeQuietly(java.io.Closeable closeable) {
        if (closeable == null) {
            return;
        }
        try {
            closeable.close();
        } catch (IOException ignored) {
            // Nothing useful to do with a failed close on a stream we are done with.
        }
    }
}