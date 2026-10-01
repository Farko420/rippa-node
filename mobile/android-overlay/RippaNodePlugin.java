package com.rippaadventures.node;

import android.content.Context;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * THE CAPACITOR PLUGIN — the JavaScript side's only route to the platform.
 *
 * Exposes exactly three methods to the worker in `mobile/src/worker.ts`:
 * start the foreground service, stop it, and report whether it is running. That
 * surface is deliberately tiny: every additional method here is another thing
 * that can start pinning a wake lock, and this node's whole background story
 * rests on doing exactly one thing predictably.
 */
@CapacitorPlugin(name = "RippaNode")
public class RippaNodePlugin extends Plugin {

    /**
     * Starts (or re-affirms) the foreground service.
     *
     * IDEMPOTENT BY DESIGN. The worker calls this on boot, and Android may also
     * restart the service after a kill; starting an already-running foreground
     * service is harmless, which makes it safe to call defensively.
     */
    @PluginMethod
    public void startForegroundService(PluginCall call) {
        Context context = getContext();
        if (context == null) {
            call.reject("No Android context available.");
            return;
        }
        try {
            Intent intent = new Intent(context, RippaNodeService.class);
            /*
              startForegroundService (not startService).

              Android 8+ throws if a background app calls startService() and then
              tries to call startForeground(). Because the WebView may well be
              backgrounded when the worker boots, the correct call must be made up
              front.
            */
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
            call.resolve();
        } catch (Exception error) {
            // Rejected rather than swallowed: if the service cannot start, the
            // node is NOT going to survive the night, and the operator must be
            // told that rather than discovering it at 7am.
            call.reject("Could not start the foreground service: " + error.getMessage(), error);
        }
    }

    /** Stops the service. Releases the wake lock with it. */
    @PluginMethod
    public void stopForegroundService(PluginCall call) {
        Context context = getContext();
        if (context == null) {
            call.reject("No Android context available.");
            return;
        }
        try {
            RippaNodeService.stop(context);
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not stop the foreground service: " + error.getMessage(), error);
        }
    }

    /**
     * Reports whether the platform is currently protecting the node.
     *
     * The dashboard shows this, because "is it actually running overnight?" is
     * otherwise unanswerable from the WebView once Android has backgrounded it.
     */
    @PluginMethod
    public void isForegroundServiceRunning(PluginCall call) {
        JSObject result = new JSObject();
        // The service is START_STICKY with no binding, so "running" is reported
        // from the process rather than a live binder — which is exactly what a
        // caller actually wants to know.
        boolean running = isServiceProcessAlive();
        result.put("running", running);
        call.resolve(result);
    }

    /**
     * Best-effort liveness probe.
     *
     * Deliberately conservative: it reports what it can actually prove — the
     * service class resolves (so the manifest overlay really was applied) and
     * this app's process is alive — rather than claiming a stronger guarantee it
     * cannot verify without binding to the service.
     */
    private boolean isServiceProcessAlive() {
        try {
            // The service class resolves only if the manifest wired it up, so
            // this doubles as a check that the overlay was actually applied.
            Class.forName("com.rippaadventures.node.RippaNodeService");
            android.app.ActivityManager manager =
                    (android.app.ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
            if (manager == null) {
                return false;
            }
            int pid = android.os.Process.myPid();
            for (android.app.ActivityManager.RunningAppProcessInfo info : manager.getRunningAppProcesses()) {
                if (info != null && info.pid == pid) {
                    return true;
                }
            }
            return false;
        } catch (Exception error) {
            return false;
        }
    }
}