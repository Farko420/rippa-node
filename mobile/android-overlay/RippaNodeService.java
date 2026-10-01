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
     * The wake lock. Tagged so it appears in `adb shell dumpsys power` under
     * "RippaNode" — invaluable when diagnosing "why did it stop at midnight".
     */
    private android.os.PowerManager.WakeLock wakeLock = null;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        acquireWakeLock();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Started in the foreground IMMEDIATELY, before any work: on Android 12+
        // a service that does work first and calls startForeground() afterwards
        // can be killed for a "contextless start".
        startForeground(NOTIFICATION_ID, buildNotification(
                "Rippa Node — satellite",
                "Foraging for the swarm. The screen may be off."));

        // START_STICKY, not START_NOT_STICKY: if Android kills this under memory
        // pressure it is restarted with a null intent. An autonomous overnight
        // worker must come back on its own.
        return START_STICKY;
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
     * Tapping the notification opens the dashboard, so the operator can reach the
     * node without hunting for the app icon on the home screen.
     */
    private Notification buildNotification(String title, String message) {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        android.app.PendingIntent contentIntent = null;
        if (launch != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            // FLAG_IMMUTABLE is required from API 31 and correct in practice
            // everywhere: this intent only opens the app and must not be
            // hijackable by another app.
            int flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT
                    | android.app.PendingIntent.FLAG_IMMUTABLE;
            launch.setFlags(launch.getFlags() | flags);
            contentIntent = android.app.PendingIntent.getActivity(this, 0, launch, flags);
        }

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(message)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setContentIntent(contentIntent)
                .build();
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

    /** Exposed so the plugin can stop the service from JavaScript. */
    public static void stop(Context context) {
        context.stopService(new Intent(context, RippaNodeService.class));
    }
}