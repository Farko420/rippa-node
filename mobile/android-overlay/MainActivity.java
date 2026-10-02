package com.rippaadventures.node;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * THE LAUNCHER ACTIVITY — unchanged except that it now installs the WebView bridge.
 *
 * WHY THIS FILE IS IN THE OVERLAY RATHER THAN LEFT TO CAPACITOR. `npx cap add
 * android` generates a MainActivity that extends BridgeActivity and does nothing,
 * and the overlay is copied in after generation by scripts/package-apk.mjs — so
 * this body survives every Capacitor upgrade without a merge conflict, exactly
 * like the manifest that names this very class.
 *
 * WHY THE BRIDGE IS ATTACHED HERE AND NOWHERE ELSE. `addJavascriptInterface` is a
 * WebView method, and in a Capacitor app the WebView belongs to the bridge rather
 * than to this Activity. It only exists once `super.onCreate()` has run and
 * BridgeActivity.load() has built it — which is why this is registered after the
 * super call and null-checked, rather than in `load()` or a static initialiser.
 *
 * Registering once, here, means the interface survives every later page load: the
 * WebView object is long-lived and re-registering per load would only duplicate
 * the same object under the same name.
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (getBridge() == null || getBridge().getWebView() == null) {
            // BridgeActivity falls back to a "no webview" layout when its own
            // layout fails to inflate, leaving the bridge null. There is no WebView
            // to attach to in that case, and that is not worth crashing over.
            android.util.Log.w("RippaNode", "No Capacitor WebView; mobileBridge not attached.");
            return;
        }

        WebView webView = getBridge().getWebView();
        webView.addJavascriptInterface(new MobileBridge(this, webView), MobileBridge.NAME);
        android.util.Log.i("RippaNode", "mobileBridge attached (updater + version reporting).");
    }
}