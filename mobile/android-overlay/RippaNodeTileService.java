package com.rippaadventures.node;

import android.annotation.TargetApi;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * THE QUICK SETTINGS TILE — a one-swipe on/off switch for the node.
 *
 * WHY THIS IS HERE AND NOT A BUTTON IN THE APP. The node lives on a tablet on a
 * desk that nobody walks over to. Its two useful actions are "make it work" and
 * "stop it chewing my battery", and both are urgent precisely when the app is
 * NOT open — someone is holding their phone and wondering whether the fleet
 * tablet is still running. The notification shade is the only surface that is
 * reachable in that moment without unlocking into a WebView.
 *
 * IT DELIBERATELY GOES THROUGH RippaNodeService.start()/stop() RATHER THAN
 * TOUCHING THE SERVICE DIRECTLY. Those two methods already encode the
 * API-26+-must-use-startForegroundService rule and the intent extras, and the
 * plugin and the boot receiver use the same pair. A third implementation here
 * would be a third thing to keep in step, and the one place it could drift is
 * exactly the one that throws ForegroundServiceStartNotAllowedException on
 * Android 12+.
 *
 * ON THE TILE'S HONESTY. `onClick` calls `requestListeningState()`, which makes
 * the platform re-call `onStartListening` and re-read the REAL service state.
 * The tile therefore shows what the service actually is rather than what the
 * last tap intended — the same rule the dashboard's service switch follows,
 * because a tile that shows "on" for a service Android has killed is worse than
 * no tile at all.
 *
 * API 24+ (TileService). The class is only ever instantiated by the platform
 * when it resolves the QS_TILE action, which does not exist below 24, so this
 * is safe on the minSdk-22 devices this app still supports.
 */
@TargetApi(Build.VERSION_CODES.N)
public class RippaNodeTileService extends TileService {

    @Override
    public void onStartListening() {
        super.onStartListening();
        refreshTile();
    }

    /**
     * Toggles the node.
     *
     * Errors are caught rather than propagated: a BroadcastReceiver-adjacent
     * callback that throws takes down the SystemUI shade process on some OEM
     * builds, and a crash in SystemUI is far worse than a tile that did nothing.
     */
    @Override
    public void onClick() {
        super.onClick();
        try {
            if (RippaNodeService.isRunning()) {
                RippaNodeService.stop(this);
            } else {
                RippaNodeService.start(this, null, null);
            }
        } catch (Exception error) {
            android.util.Log.w("RippaNode", "Tile toggle declined: " + error.getMessage());
        } finally {
            refreshTile();
            // Asks the platform to call us back once the start/stop has actually
            // landed, so the tile settles on the truth rather than on intent.
            requestListeningState();
        }
    }

    /**
     * Repaints the tile from the service's live state.
     *
     * `getQSTile()` returns null before the user has added the tile, which is
     * not an error and must not throw.
     */
    private void refreshTile() {
        Tile tile = getQSTile();
        if (tile == null) {
            return;
        }
        boolean running = RippaNodeService.isRunning();
        tile.setState(running ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        tile.setLabel("Rippa Node");
        // The subtitle is the whole value of a tile: the label is already on
        // screen, the subtitle is the answer to "is it actually running?".
        tile.setSubtitle(running ? "Running" : "Stopped");
        tile.updateTile();
    }
}