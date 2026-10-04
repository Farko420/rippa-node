package com.rippaadventures.node;

import android.content.Context;

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
 *
 * THE `@CapacitorPlugin` NAME IS THE JS IDENTITY, AND IT IS THE FIRST HALF OF THE
 * BUG THAT PRODUCED "Native bridge unavailable". Capacitor derives the JavaScript
 * global from this annotation: `@CapacitorPlugin(name = "RippaNode")` publishes the
 * methods at `window.Capacitor.Plugins.RippaNode`, NOT at
 * `window.RippaNodePlugin`. The worker looked for `globalThis.RippaNodePlugin`,
 * which nothing in the Capacitor runtime has ever created, so the bridge was
 * unreachable on every device. The two halves of the contract must change
 * together: the name here, and `NATIVE_PLUGIN_ID` in mobile/src/worker.ts.
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
        /*
          startForegroundService (not startService).

          Android 8+ throws if a background app calls startService() and then
          tries to call startForeground(). Because the WebView may well be
          backgrounded when the worker boots, the correct call must be made up
          front.
        */
        try {
            RippaNodeService.start(
                    context,
                    call.getString("title", "Rippa Node is running"),
                    call.getString("message", "Foraging for the swarm. The screen may be off."));
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
        /*
          THE SERVICE'S OWN FLAG, NOT A PROCESS PROBE.

          This used to walk ActivityManager looking for "is my own pid in the
          running-process list", which is true for as long as the WebView is
          alive. It therefore answered `running: true` on a desktop browser
          preview, after a failed start, and any time no service existed at all —
          so the dashboard's "Run as Background Service" switch reported success
          while the node was unprotected. The dashboard renders this value
          verbatim, so a wrong answer here is a lie the operator acts on.

          A secondary check is still performed and reported separately: if the
          service class does not resolve, the manifest overlay was never applied
          and the node cannot be protected no matter what this flag says.
        */
        boolean overlayApplied = serviceClassResolves();
        result.put("running", overlayApplied && RippaNodeService.isRunning());
        // Surfaced so the dashboard can distinguish "off" from "broken", which
        // are very different things to an operator at 11pm.
        result.put("available", overlayApplied);
        call.resolve(result);
    }

    /**
     * Resolves the service class, which only exists in the APK if the manifest
     * overlay was applied. Used as the "is this build capable of protecting the
     * node at all" probe.
     */
    private boolean serviceClassResolves() {
        try {
            Class.forName("com.rippaadventures.node.RippaNodeService");
            return true;
        } catch (Exception error) {
            return false;
        }
    }
}