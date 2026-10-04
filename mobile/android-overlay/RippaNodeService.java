package com.rippaadventures.node;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;

/**
 * THE FOREGROUND SERVICE + WAKE LOCK — what actually keeps this node alive
 * overnight.
 *
 * WHY THIS IS NATIVE JAVA AND NOT JAVASCRIPT. Android's power manager treats a
 * WebView app as a foreground app: the moment the screen goes off the process is
 * a candidate for freezing, and after a few minutes of Doze it is killed. A
 * tablet left to forage with the screen off would therefore do nothing at all.
 *
 * A foreground service inverts that: it declares "there is visible, user-relevant
 * work happening" via a persistent notification, and Android will not freeze or
 * reclaim the process while that notification is up. Pairing it with a
 * PARTIAL_WAKE_LOCK keeps the CPU itself awake.
 *
 * The service is deliberately tiny. The node's real work happens in the WebView;
 * this exists purely to hold the platform's hand while that happens.
 */
public class RippaNodeService extends android.app.Service {

    /**
     * Lowest-importance channel that still counts as a foreground-service
     * notification. It makes NO SOUND — a tablet that chirps every hour on a desk
     * overnight would be unplugged within a night — but the service must still
     * show one to be considered legitimately foreground.
     */
    private static final String CHANNEL_ID = "rippa_node_service";
    private static final int NOTIFICATION_ID = 4711;

    /**
     * THE TITLE THE OPERATOR ACTUALLY SEES. Set in Java rather than taken from
     * the JavaScript caller on purpose: the notification outlives the WebView (it
     * is exactly what is still on screen hours after the page is gone), so it
     * cannot depend on a JS object being alive to describe it.
     */
    private static final String DEFAULT_TITLE = "Rippa Node is running";

    /**
     * Live service state, in a STATIC field.
     *
     * THIS EXISTS BECAUSE THE OLD `isForegroundServiceRunning` IMPLEMENTATION WAS
     * LYING, and the lie is worth recording. It answered by walking
     * ActivityManager for "is my own process in the running list", which is true
     * for as long as the WebView is alive — so it reported `running: true` even
     * when no service existed at all, on a browser preview, or after a failed
     * start. An operator toggling "Run as Background Service" would have watched
     * the switch claim success while the node quietly died at 11pm, which is the
     * exact failure this whole feature exists to prevent.
     *
     * The service is started and stopped within one process, so a static flag
     * written in onCreate/onDestroy is authoritative for the only question being
     * asked: "is the platform protecting me right now?"
     */
    private static volatile boolean serviceRunning = false;

    /**
     * The wake lock. Tagged so it appears in `adb shell dumpsys power` under
     * "RippaNode" — invaluable when diagnosing "why did it stop at midnight".
     */
    private android.os.PowerManager.WakeLock wakeLock = null;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        acquireWakeLock();
        serviceRunning = true;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = DEFAULT_TITLE;
        String message = DEFAULT_MESSAGE;
        if (intent != null && intent.getExtras() != null) {
            // Supplyed by the JS side for operator-facing wording, but strictly
            // optional: START_STICKY redelivers a NULL intent after the process
            // is killed, and that restart must still produce a valid notification
            // rather than one with null text.
            String suppliedTitle = intent.getStringExtra(EXTRA_TITLE);
            String suppliedMessage = intent.getStringExtra(EXTRA_MESSAGE);
            if (suppliedTitle != null && suppliedTitle.trim().length() > 0) {
                title = suppliedTitle.trim();
            }
            if (suppliedMessage != null && suppliedMessage.trim().length() > 0) {
                message = suppliedMessage.trim();
            }
        }

        // Started in the foreground IMMEDIATELY, before any work: on Android 12+
        // a service that does work first and calls startForeground() afterwards
        // can be killed for a "contextless start".
        startForeground(NOTIFICATION_ID, buildNotification(title, message));

        // START_STICKY, not START_NOT_STICKY: if Android kills this under memory
        // pressure it is restarted with a null intent. An autonomous overnight
        // worker must come back on its own.
        return START_STICKY;
    }

    /** Shown when the caller supplies no message of its own. */
    private static final String DEFAULT_MESSAGE =
            "Foraging for the swarm. The screen may be off.";

    /** Intent extras the Capacitor plugin fills in from the JS call. */
    public static final String EXTRA_TITLE = "rippa_node_title";
    public static final String EXTRA_MESSAGE = "rippa_node_message";

    /**
     * TRUE ONLY WHILE THE SERVICE IS ACTUALLY ALIVE.
     *
     * Read by RippaNodePlugin.isForegroundServiceRunning and, through it, by the
     * dashboard's "Run as Background Service" switch. It is a plain flag rather
     * than a bind, because binding would require the WebView to hold a Service
     * connection open — which is the very thing being backgrounded.
     */
    public static boolean isRunning() {
        return serviceRunning;
    }

    /**
     * PARTIAL_WAKE_LOCK keeps the CPU running with the screen off.
     *
     * PARTIAL rather than FULL deliberately: FULL also keeps the screen on,
     * leaving the tablet glowing on a desk all night and draining the battery far
     * faster than the work itself does.
     */
    private void acquireWakeLock() {
        if (wakeLock != null) {
            return;
        }
        android.os.PowerManager power = (android.os.PowerManager) getSystemService(POWER_SERVICE);
        if (power == null) {
            // Defensive: a device that refuses a wake lock must still run the
            // service, degraded, rather than crash.
            return;
        }
        wakeLock = power.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "RippaNode:swarm-worker");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }
@Override
    public void onDestroy() {
        // Cleared BEFORE the wake lock is released, so isRunning() never reports
        // a live service whose wake lock is already gone.
        serviceRunning = false;
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
        super.onDestroy();
    }

    /**
     * A foreground-service notification is mandatory, and on Android 8+ it must
     * live on a channel. Created once and reused: recreating it on every start
     * would discard any importance setting the user chose.
     */
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Swarm worker",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Keeps the Rippa Node working while the screen is off.");
        channel.setSound(null, null);
        channel.enableVibration(false);
        manager.createNotificationChannel(channel);
    }

    /**
     * THE QUICK-NAVIGATION BUTTON.
     *
     * An explicit Intent at MainActivity rather than
     * `getPackageManager().getLaunchIntentForPackage()`, which is what the
     * original used. The package launch intent resolves to MAIN/LAUNCHER with
     * `FLAG_ACTIVITY_NEW_TASK` and no component target, so whether it reopened
     * the already-running dashboard or cold-started a second WebView depended on
     * the launchMode. MainActivity is declared `singleTask`, so an explicit
     * intent with SINGLE_TOP delivers `onNewIntent` to the live Activity and the
     * operator lands on the dashboard they were already looking at.
     */
    private android.app.PendingIntent dashboardIntent(int requestCode) {
        Intent launch = new Intent(this, MainActivity.class);
        launch.setAction(Intent.ACTION_MAIN);
        launch.addCategory(Intent.CATEGORY_LAUNCHER);
        // SINGLE_TOP routes to the running Activity instead of rebuilding it.
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            // FLAG_IMMUTABLE is required from API 31 and correct in practice
            // everywhere: this intent only opens the app and must not be
            // hijackable by another app.
            flags |= android.app.PendingIntent.FLAG_IMMUTABLE;
        }
        return android.app.PendingIntent.getActivity(this, requestCode, launch, flags);
    }

    /**
     * Tapping the notification opens the dashboard, so the operator can reach the
     * node without hunting for the app icon on the home screen.
     *
     * THE NOTIFICATION CARRIES BOTH AFFORDANCES ON PURPOSE. The whole-body
     * contentIntent (tap anywhere) and the explicit "Open dashboard" action are
     * separate PendingIntents with separate request codes — reusing one request
     * code would let the second getActivity() call REPLACE the first, which
     * silently turns the action button into a duplicate of the body tap.
     */
    private Notification buildNotification(String title, String message) {
        NotificationCompat.Builder builder =
                new NotificationCompat.Builder(this, CHANNEL_ID)
                        .setContentTitle(title)
                        .setContentText(message)
                        .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                        .setPriority(NotificationCompat.PRIORITY_LOW)
                        .setOngoing(true)
                        .setSilent(true)
                        .setCategory(NotificationCompat.CATEGORY_SERVICE)
                        .setContentIntent(dashboardIntent(0))
                        // The explicit quick-navigation button. `setContentIntent`
                        // alone only makes the body tappable; on a tablet whose
                        // notification is collapsed, an operator has to expand it
                        // first to reach the dashboard at all.
                        .addAction(
                                android.R.drawable.ic_menu_view,
                                "Open dashboard",
                                dashboardIntent(1));
        return builder.build();
    }

    /**
     * No binding is exposed to anyone: the WebView talks to the platform through
     * the Capacitor plugin, never by binding to this service. Returning null is
     * therefore correct, not a stub.
     */
    @Override
    public android.os.IBinder onBind(Intent intent) {
        return null;
    }

    /** True when the wake lock is currently held. Used by the plugin's status call. */
    public boolean isHoldingWakeLock() {
        return wakeLock != null && wakeLock.isHeld();
    }

    /**
     * Starts the service, honouring the Android 8+ background-start rules.
     *
     * Extracted so the plugin and the boot receiver cannot disagree about WHICH
     * call is legal: startForegroundService() is required when the caller may be
     * backgrounded, and calling startService() instead throws
     * IllegalStateException on API 26+.
     */
    public static void start(Context context, String title, String message) {
        Intent intent = new Intent(context, RippaNodeService.class);
        if (title != null && title.trim().length() > 0) {
            intent.putExtra(EXTRA_TITLE, title.trim());
        }
        if (message != null && message.trim().length() > 0) {
            intent.putExtra(EXTRA_MESSAGE, message.trim());
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    /**
     * Exposed so the plugin can stop the service from JavaScript.
     *
     * The flag is cleared here as well as in onDestroy(). onDestroy() is the
     * authoritative hook, but Android may not deliver it promptly after
     * stopService(), and the dashboard polls isForegroundServiceRunning() every
     * couple of seconds — so clearing it at the call site is what makes the
     * "Run as Background Service" switch untick immediately rather than a beat
     * later.
     */
    public static void stop(Context context) {
        context.stopService(new Intent(context, RippaNodeService.class));
        serviceRunning = false;
    }
}