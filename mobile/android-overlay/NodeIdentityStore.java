package com.rippaadventures.node;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.HashMap;
import java.util.Map;

/**
 * THE NODE'S IDENTITY, MIRRORED INTO SharedPreferences.
 *
 * This file previously held RippaNodeTileService, which was never going to work:
 * javac rejects a public class whose filename does not match it ("class
 * RippaNodeTileService is public, should be declared in a file named
 * RippaNodeTileService.java"), the packager never copied it into the build
 * anyway, and the file itself carried a stray NUL byte in its javadoc. The tile
 * now lives in RippaNodeTileService.java and this class does what its name
 * always said it did.
 *
 * WHY A NATIVE MIRROR AT ALL, GIVEN THAT localStorage ALREADY HOLDS THE KEY.
 * There are two very different failure modes behind that one read:
 *
 *   1. The PROCESS was killed. Android does this constantly, and localStorage
 *      rides along in the WebView's own app data, so it survives fine.
 *   2. The app's DATA was removed. This is the one that hurts: "Clear storage"
 *      wipes it, and an uninstall wipes it by default. A node that forgets its
 *      own key is not a node any more, and on a tablet on a desk nobody is near,
 *      that means it silently drops out of the swarm.
 *
 * So the identity is written to two independent places. Between them:
 *
 *   localStorage        survives process death (the common case, and what the
 *                       pollers actually read).
 *   SharedPreferences   survives a WebView storage wipe, and — with
 *                       `android:hasFragileUserData="true"` in the manifest —
 *                       also survives the uninstall, because Android then asks
 *                       the operator "keep this app's data?" and keeps it.
 *
 * HAS FRAGILE USER DATA IS THE ENTIRE UNINSTALL STRATEGY, AND IT IS DELIBERATE.
 * The obvious alternative is mirroring the identity into a public directory such
 * as Documents/RippaNode/ so a fresh install can adopt it. That was considered
 * and rejected: under scoped storage (API 29+) writing anywhere public requires
 * MANAGE_EXTERNAL_STORAGE — the "All files access" special permission — which a
 * sideloaded APK cannot hold without the operator hand-granting it in Settings.
 * Trading a working one-tap prompt for a permission that is alarming, rarely
 * granted, and impossible to verify from the notification shade is a bad trade
 * for a node that has to work unattended. hasFragileUserData is the modern,
 * permission-free mechanism for exactly this case, and it is why this class
 * needs no storage permission of any kind.
 *
 * THIS IS A MIRROR, NOT A SECOND SOURCE OF TRUTH. `configureNode()` in
 * mobile/src/worker.ts stays the single writer of the config the pollers read,
 * and this store is only consulted to SEED a node that has no localStorage
 * config at all. Two live writers for one value is how a node ends up
 * contradicting itself between the dashboard and the Mothership.
 *
 * `createdAt` IS WRITE-ONCE. Re-adopting an identity must not reset its age, or
 * a restored node would look brand new to anything that reads that timestamp.
 */
public final class NodeIdentityStore {


    /**
     * Private to the app, in the app's own data directory.
     *
     * MODE_PRIVATE is not a formality here: this file holds the node key, which
     * is a bearer credential. It sits in the same sandbox as the WebView's
     * localStorage copy, so it grants no attacker any access the existing
     * storage layout did not already grant — this is not a new exposure, it is
     * a second copy inside the same perimeter.
     */
    private static final String PREFS_NAME = "rippa_node_identity";

    /** Bumped if the shape ever changes, so a future migration can branch on it. */
    private static final int SCHEMA_VERSION = 1;

    private static final String KEY_NODE_KEY = "nodeKey";
    private static final String KEY_NODE_NAME = "nodeName";
    private static final String KEY_NODE_CODE = "nodeCode";
    private static final String KEY_MOTHERSHIP_URL = "mothershipUrl";
    private static final String KEY_CREATED_AT = "createdAt";
    private static final String KEY_SCHEMA_VERSION = "schemaVersion";

    private NodeIdentityStore() {
        // Static helpers only; never instantiated.
    }

    /**
     * Writes the identity, creating the record's age on first write.
     *
     * BLANK VALUES ARE IGNORED RATHER THAN STORED, and that is deliberate. A
     * caller that only knows the node key — the common case, since the key is
     * the one field an operator always supplies — must not blank the node name
     * it was given last time. Storing "" would quietly destroy good data on the
     * way past.
     *
     * apply() rather than commit(): this is asynchronous disk I/O and the caller
     * is very likely on the main thread. There is no data-loss risk in not
     * waiting, because the caller has just written the same values to
     * localStorage — the two copies are written microseconds apart, so a flush
     * that has not landed yet still has an intact copy behind it.
     */
    public static void save(
            Context context,
            String nodeKey,
            String nodeName,
            String nodeCode,
            String mothershipUrl
    ) {
        if (context == null) {
            return;
        }
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            SharedPreferences.Editor editor = prefs.edit();
            putIfPresent(editor, KEY_NODE_KEY, nodeKey);
            putIfPresent(editor, KEY_NODE_NAME, nodeName);
            putIfPresent(editor, KEY_NODE_CODE, nodeCode);
            putIfPresent(editor, KEY_MOTHERSHIP_URL, mothershipUrl);
            // Write-once, so a later partial save cannot make an old node look
            // newly provisioned to anything that reads the timestamp.
            if (prefs.getString(KEY_CREATED_AT, null) == null) {
                editor.putString(KEY_CREATED_AT, Long.toString(System.currentTimeMillis()));
            }
            editor.putInt(KEY_SCHEMA_VERSION, SCHEMA_VERSION);
            editor.apply();
        } catch (Exception error) {
            // A mirror that cannot be written is a degraded node, not a broken
            // one. Throwing here would take down pairing, which still succeeds
            // through localStorage.
            android.util.Log.w("RippaNode", "Could not mirror node identity: " + error.getMessage());
        }
    }

    /**
     * The stored identity, or null when this device has never been paired.
     *
     * Null is the meaningful answer and is deliberately distinct from an empty
     * map: "no record" means "seed this node from the mirror", whereas "a record
     * that happens to have no key in it" would mean the opposite and would seed
     * the node with nothing.
     */
    public static Map<String, String> load(Context context) {
        if (context == null) {
            return null;
        }
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String nodeKey = trim(prefs.getString(KEY_NODE_KEY, null));
            if (nodeKey == null) {
                return null;
            }
            Map<String, String> identity = new HashMap<>();
            identity.put(KEY_NODE_KEY, nodeKey);
            identity.put(KEY_NODE_NAME, orEmpty(prefs.getString(KEY_NODE_NAME, null)));
            identity.put(KEY_NODE_CODE, orEmpty(prefs.getString(KEY_NODE_CODE, null)));
            identity.put(KEY_MOTHERSHIP_URL, orEmpty(prefs.getString(KEY_MOTHERSHIP_URL, null)));
            identity.put(KEY_CREATED_AT, orEmpty(prefs.getString(KEY_CREATED_AT, null)));
            identity.put(KEY_SCHEMA_VERSION, Integer.toString(prefs.getInt(KEY_SCHEMA_VERSION, 0)));
            return identity;
        } catch (Exception error) {
            android.util.Log.w("RippaNode", "Could not read node identity: " + error.getMessage());
            return null;
        }
    }

    /** Stores a value only when it is actually present. See save(). */
    private static void putIfPresent(SharedPreferences.Editor editor, String key, String value) {
        String cleaned = trim(value);
        if (cleaned != null) {
            editor.putString(key, cleaned);
        }
    }

    /** A trimmed non-empty string, or null. */
    private static String trim(String value) {
        if (value == null) {
            return null;
        }
        String cleaned = value.trim();
        return cleaned.isEmpty() ? null : cleaned;
    }

    /** Never-null strings, because the JS side reads these without guarding. */
    private static String orEmpty(String value) {
        return value == null ? "" : value;
    }
}

