package com.rippaadventures.node;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * THE CAPACITOR PLUGIN — the JavaScript side's only route to the platform.
 *
 * Exposes a deliberately tiny surface to the worker in `mobile/src/worker.ts`:
 * start the foreground service, stop it, report whether it is running, and the
 * battery-optimisation exemption pair (`isIgnoring…` / `requestIgnore…`). Every
 * additional method here is another thing that can start pinning a wake lock or
 * putting a system dialog in front of an operator, and this node's whole
 * background story rests on doing exactly one thing predictably.
 *
 * THE EXEMPTION PAIR IS EXEMPT FROM THAT RULE IN ONE RESPECT ONLY: it does not
 * start anything, it only ASKS. It cannot wake a lock or keep a process alive by
 * itself — it just makes the OEM app killer leave the node alone, which nothing
 * else in this APK can do.
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

    // --- THE OEM APP KILLER ---------------------------------------------------

    /**
     * Whether Android is currently exempting this app from battery optimisation.
     *
     * READ, NEVER ASSUMED. Returns `false` on every pre-Marshmallow device, where
     * the concept does not exist and the answer is trivially "nothing to ask for".
     *
     * Any exception (a stripped ROM, a restricted profile) answers `false`, which
     * is the safe direction: the caller then believes it still needs to prompt, and
     * a redundant settings page is a far smaller failure than a node that silently
     * believes it is protected and is not.
     */
    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        JSObject result = new JSObject();
        if (android.os.Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            result.put("ignoring", true);
            result.put("supported", false);
            call.resolve(result);
            return;
        }
        try {
            android.os.PowerManager power =
                    (android.os.PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            boolean ignoring = power != null
                    && power.isIgnoringBatteryOptimizations(getContext().getPackageName());
            result.put("ignoring", ignoring);
            result.put("supported", true);
            call.resolve(result);
        } catch (Exception error) {
            result.put("ignoring", false);
            result.put("supported", true);
            result.put("error", error.getMessage());
            call.resolve(result);
        }
    }

    /**
     * Asks the user to exempt this app from battery optimisation.
     *
     * THIS IS THE ONLY WAY TO SURVIVE A SAMSUNG TABLET. The foreground service
     * and wake lock handle stock Android; they do nothing against Samsung's
     * proprietary sleeping-apps service, which freezes background processes on its
     * own schedule and ignores every stock exemption. Without this the fleet goes
     * offline overnight on exactly the hardware it is deployed on.
     *
     * IDEMPOTENT AND SILENT WHEN UNNECESSARY — it checks first and resolves without
     * showing anything if the app is already exempt or the OS is too old. Android
     * rate-limits this dialog and an app that nags gets uninstalled, so the check
     * is not an optimisation, it is the difference between a prompt and an
     * uninstall.
     *
     * FALLBACK CHAIN, because a single intent is not enough in the field:
     *   1. ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS — the direct "allow" dialog.
     *   2. ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS — the list page, for OEMs
     *      that disable the direct dialog.
     *   3. ACTION_APPLICATION_DETAILS_SETTINGS — our own app page, which always
     *      exists. An operator who lands here can still find "Battery" and set
     *      "Unrestricted" by hand.
     *
     * Every step is wrapped: an `ActivityNotFoundException` here must degrade to
     * the next screen, never propagate into the WebView as an unhandled error.
     */
    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        Context context = getContext();
        if (context == null) {
            call.reject("No Android context available.");
            return;
        }
        if (android.os.Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            call.resolve(); // pre-Marshmallow has no battery optimisation to exempt
            return;
        }

        String pkg = context.getPackageName();
        try {
            android.os.PowerManager power =
                    (android.os.PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (power != null && power.isIgnoringBatteryOptimizations(pkg)) {
                call.resolve(); // already exempt — never re-prompt
                return;
            }
        } catch (Exception ignored) {
            /* fall through and prompt anyway */
        }

        if (startSettings(context, new Intent(
                android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:" + pkg)))) {
            call.resolve();
            return;
        }
        if (startSettings(context, new Intent(
                android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))) {
            call.resolve();
            return;
        }
        // Last resort: our own app details page always resolves.
        startSettings(context, new Intent(
                android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + pkg)));
        call.resolve();
    }

    /**
     * Starts a settings activity, reporting whether it was actually available.
     *
     * `FLAG_ACTIVITY_NEW_TASK` is mandatory: the plugin method may run with no
     * Activity in the foreground (the WebView can be backgrounded), and starting
     * an Activity without it throws "Calling startActivity() from outside of an
     * Activity context requires the FLAG_ACTIVITY_NEW_TASK flag".
     */
    private boolean startSettings(Context context, Intent intent) {
        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            return true;
        } catch (Exception error) {
            return false;
        }
    }
}