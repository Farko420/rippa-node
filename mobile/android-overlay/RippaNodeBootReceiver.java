package com.rippaadventures.node;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * RESTARTS THE NODE AFTER A REBOOT OR AN APP UPDATE.
 *
 * WHY THIS EXISTS. The stated goal is a tablet that runs the swarm "24/7
 * overnight". A tablet that reboots for a security patch at 3am, or is updated
 * from the Play Store while it sits on a desk, would otherwise drop out of the
 * swarm silently and stay out until somebody noticed the next morning — which is
 * the failure mode this whole feature exists to prevent.
 *
 * Note that this restarts the SERVICE. The WebView comes back when the user next
 * opens the app; the platform-level protection (wake lock + foreground
 * notification) is what has to survive unattended, and the service is what holds
 * it.
 */
public class RippaNodeBootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null) {
            return;
        }
        try {
            Intent service = new Intent(context, RippaNodeService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // Same reason as the plugin: startForegroundService is the only
                // call legal from a background receiver on Android 8+.
                context.startForegroundService(service);
            } else {
                context.startService(service);
            }
        } catch (Exception error) {
            // A reboot receiver that throws crashes the system on some OEM
            // builds. Failing to restart is recoverable; crashing the tablet is
            // not.
            android.util.Log.w("RippaNode", "Boot restart declined: " + error.getMessage());
        }
    }
}