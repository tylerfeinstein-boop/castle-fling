package com.emptyhelmetgames.castlefling;

import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.core.content.pm.PackageInfoCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "CastleFling";
    private static final String DIAG_PREFS = "castlefling_diag";
    private static final String KEY_RENDERER_RECOVERED = "rendererRecovered";

    /** Last insets pushed to the web layer, so a reload can be re-fed immediately. */
    private int lastTop = -1, lastRight = -1, lastBottom = -1, lastLeft = -1;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        /* Modern edge-to-edge. Must run before super.onCreate(), which is where
           BridgeActivity inflates its layout. EdgeToEdge.enable() does the whole
           job the old code hand-rolled: it clears decor fitsSystemWindows, makes
           both bars transparent, and installs the automatic scrim that keeps
           three-button navigation readable on API < 29. Nothing else in this
           class may set bar colours or systemUiVisibility — one implementation
           only. */
        /* Hands the launch theme over to postSplashScreenTheme
           (AppTheme.NoActionBar). This call is what the scaffolded splash theme
           always required and never had: without it the Activity kept
           Theme.SplashScreen forever, leaving the AppCompat title bar on screen
           with the full-screen splash bitmap stretched across it. Must run
           before super.onCreate(), which is where the content view is set. */
        SplashScreen.installSplashScreen(this);
        EdgeToEdge.enable(this);

        /* Monetization plugins. Capacitor only binds plugins registered BEFORE
           super.onCreate(), which is where the bridge is built. Registering
           them does not initialize any SDK — the web layer calls initialize()
           when it is ready, and the ads plugin gates that behind UMP consent. */
        registerPlugin(CastleFlingAdsPlugin.class);
        registerPlugin(CastleFlingBillingPlugin.class);

        super.onCreate(savedInstanceState);

        Log.i(TAG, "App launch: onCreate (sdk=" + Build.VERSION.SDK_INT
            + ", model=" + Build.MODEL + ")");

        applyCutoutMode();
        applyImmersiveMode();
        installInsetBridge();
        installBackHandler();

        // The Android WebView refuses <audio>.play() unless it can tie the call
        // to a native touch gesture, which Capacitor's synthesized click events
        // don't always satisfy — music only starts from the game's own buttons,
        // so lift the restriction.
        this.bridge.getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);

        // The game carries its own type scale (--ui-scale plus the
        // height-based compact tiers in style.css). By default the WebView
        // ALSO multiplies every CSS font size by the system font-size
        // setting (textZoom = fontScale × 100; Samsung's "Large" presets run
        // 110–130%), a hidden second scaling system the fixed-height menu
        // panels were never laid out for — it reflowed the Board, menu and
        // castle screens right off the bottom of the panel. Pin it to 100:
        // the UI scales with the window it is given, never with a
        // multiplier it cannot see.
        this.bridge.getWebView().getSettings().setTextZoom(100);
        Log.i(TAG, "WebView created");

        // JS -> Logcat diagnostics bridge. Exposes ONLY log() and the one-shot
        // renderer-recovery flag read — no other native surface.
        this.bridge.getWebView().addJavascriptInterface(
            new CastleFlingDiagnosticsBridge(), "CastleFlingDiagnostics");

        installRendererRecovery();
    }

    /* ============================================================
       WINDOW / INSETS
       ============================================================ */

    /** Draw through the camera cutout on every edge; the inset bridge keeps the
     *  UI clear of it. Forcing NEVER is not an option on API 35+, where a
     *  non-floating window always lays out through the cutout area. */
    private void applyCutoutMode() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return;
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        lp.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
            ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        getWindow().setAttributes(lp);
    }

    /** Immersive landscape play. WindowInsetsControllerCompat replaces the
     *  deprecated decorView systemUiVisibility flag soup; BEHAVIOR_SHOW_TRANSIENT
     *  lets a swipe peek at the bars and auto-hides them again, so nothing has to
     *  re-hide them on a timer or per frame. */
    private void applyImmersiveMode() {
        WindowInsetsControllerCompat c =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        c.hide(WindowInsetsCompat.Type.systemBars());
    }

    /** Read window insets and hand them to the web layer as CSS pixels.
     *
     *  The WebView itself is never padded — it keeps filling the whole
     *  edge-to-edge window so backgrounds and the battlefield still reach every
     *  corner. Only the HTML critical-control layer insets itself, via the
     *  --android-safe-* custom properties (see style.css).
     *
     *  Insets are read with getInsetsIgnoringVisibility() for the system bars, so
     *  the safe area stays CONSTANT when a swipe transiently reveals the bars —
     *  otherwise every peek would reflow the menus. The cutout is unioned in at
     *  its real value because it never hides. */
    private void installInsetBridge() {
        final View root = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars;
            try {
                bars = insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars());
            } catch (IllegalArgumentException e) {
                bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            }
            Insets cut = insets.getInsets(WindowInsetsCompat.Type.displayCutout());

            float d = getResources().getDisplayMetrics().density;
            if (d <= 0) d = 1f;
            int top    = Math.round(Math.max(bars.top,    cut.top)    / d);
            int right  = Math.round(Math.max(bars.right,  cut.right)  / d);
            int bottom = Math.round(Math.max(bars.bottom, cut.bottom) / d);
            int left   = Math.round(Math.max(bars.left,   cut.left)   / d);

            pushInsets(top, right, bottom, left, false);

            // NOT consumed: the WebView must still lay out edge to edge.
            return insets;
        });
    }

    /** One-way native -> JS. No JavascriptInterface is involved, so this adds no
     *  callable surface for page content. */
    private void pushInsets(int top, int right, int bottom, int left, boolean force) {
        if (top < 0 || right < 0 || bottom < 0 || left < 0) {
            return;   // nothing measured yet — the listener will deliver the real values
        }
        if (!force && top == lastTop && right == lastRight
            && bottom == lastBottom && left == lastLeft) {
            return;   // unchanged — never re-run layout for nothing
        }
        lastTop = top; lastRight = right; lastBottom = bottom; lastLeft = left;
        evalJs("window.__castleFlingSetInsets && window.__castleFlingSetInsets("
            + top + "," + right + "," + bottom + "," + left + ");");
    }

    private void evalJs(String js) {
        try {
            if (this.bridge != null && this.bridge.getWebView() != null) {
                this.bridge.getWebView().evaluateJavascript(js, null);
            }
        } catch (Exception e) {
            Log.w(TAG, "evaluateJavascript failed", e);
        }
    }

    /* ============================================================
       CONFIGURATION CHANGES
       ============================================================ */

    /** The Activity is NOT recreated (see configChanges in the manifest) because
     *  the whole game — current run, tutorial step, Ricochet attempt, audio — is
     *  live WebView state. Everything that depends on window size is refreshed
     *  here instead: immersive flags, insets, and the web layer's own measure. */
    @Override
    public void onConfigurationChanged(@NonNull Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        Log.i(TAG, "Configuration changed: " + newConfig.screenWidthDp + "x"
            + newConfig.screenHeightDp + "dp orientation=" + newConfig.orientation);
        applyImmersiveMode();
        // force a fresh inset dispatch against the new window bounds
        ViewCompat.requestApplyInsets(getWindow().getDecorView());
        pushInsets(lastTop, lastRight, lastBottom, lastLeft, true);
        evalJs("window.__castleFlingOnConfigChange && window.__castleFlingOnConfigChange();");
    }

    /* ============================================================
       BACK HANDLING
       ============================================================ */

    /** onBackPressed() is deprecated from API 33; the dispatcher is the supported
     *  path and is what predictive back reads. The game decides:
     *  __castleFlingBack() pauses gameplay / backs out of menus and returns true,
     *  and returns false only on the main menu where leaving the app is right. */
    private void installBackHandler() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = bridge != null ? bridge.getWebView() : null;
                if (wv == null) { finish(); return; }
                try {
                    wv.evaluateJavascript(
                        "window.__castleFlingBack ? window.__castleFlingBack() : false",
                        value -> { if (!"true".equals(value)) finish(); });
                } catch (Exception e) {
                    finish();
                }
            }
        });
    }

    /* ============================================================
       RENDERER RECOVERY + DIAGNOSTICS  (unchanged behaviour)
       ============================================================ */

    /** Detect the system killing the WebView RENDERER process. Note this cannot
     *  catch a fault on the in-process GPU thread — see the 2026-07 Adreno
     *  gsl_syncobj_destroy crash, fixed on the rendering side. */
    private void installRendererRecovery() {
        this.bridge.getWebView().setWebViewClient(new BridgeWebViewClient(this.bridge) {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    Log.e(TAG, "WebView renderer terminated. DidCrash=" + detail.didCrash()
                        + " rendererPriorityAtExit=" + detail.rendererPriorityAtExit());
                } else {
                    Log.e(TAG, "WebView renderer terminated (no detail on this API level).");
                }
                getSharedPreferences(DIAG_PREFS, MODE_PRIVATE).edit()
                    .putBoolean(KEY_RENDERER_RECOVERED, true).commit();
                safelyDestroyWebView(view);
                // full activity recreate: Capacitor rebuilds the bridge + WebView
                // cleanly instead of us hand-wiring a half-initialized one
                runOnUiThread(MainActivity.this::recreate);
                return true;   // handled — never let the whole app be killed
            }
        });
    }

    /** The dead WebView must never stay attached (blank/frozen screen). */
    private void safelyDestroyWebView(WebView view) {
        try {
            ViewGroup parent = (ViewGroup) view.getParent();
            if (parent != null) parent.removeView(view);
            view.destroy();
        } catch (Exception e) {
            Log.e(TAG, "Failed to destroy dead WebView", e);
        }
    }

    /** Minimal JS diagnostics surface (see game.js CrashDiagnostics). */
    private class CastleFlingDiagnosticsBridge {
        @JavascriptInterface
        public void log(String message) {
            if (message == null) return;
            if (message.length() > 4000) message = message.substring(0, 4000);
            Log.e("CastleFlingJS", message);
        }

        /** Installed build, as "versionName (versionCode)".
         *
         *  A diagnostic report without this is close to useless: the 2026-07
         *  Adreno gsl_syncobj_destroy crash could not be told apart from its own
         *  fix landing, because nothing in the report said which build produced
         *  it. Read from the package manager, so it can never drift from what
         *  Play actually shipped. */
        @JavascriptInterface
        public String appVersion() {
            try {
                android.content.pm.PackageInfo pi = getPackageManager()
                    .getPackageInfo(getPackageName(), 0);
                long code = PackageInfoCompat.getLongVersionCode(pi);
                return pi.versionName + " (" + code + ")";
            } catch (Exception e) {
                return "unknown";
            }
        }

        /** One-shot: true only on the first boot after a renderer recovery. */
        @JavascriptInterface
        public boolean wasRendererRecovered() {
            SharedPreferences p = getSharedPreferences(DIAG_PREFS, MODE_PRIVATE);
            boolean recovered = p.getBoolean(KEY_RENDERER_RECOVERED, false);
            if (recovered) p.edit().putBoolean(KEY_RENDERER_RECOVERED, false).apply();
            return recovered;
        }
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        Log.w(TAG, "onTrimMemory level=" + level);
        evalJs("window.CastleFlingDiag && window.CastleFlingDiag.record('android-trim-memory',{level:"
            + level + "});");
    }

    /* ============================================================
       LIFECYCLE
       ============================================================ */

    @Override
    public void onResume() {
        super.onResume();
        Log.i(TAG, "Lifecycle: onResume");
        applyImmersiveMode();
        // returning from another Activity can drop the last dispatch
        ViewCompat.requestApplyInsets(getWindow().getDecorView());
        pushInsets(lastTop, lastRight, lastBottom, lastLeft, true);
    }

    @Override
    public void onPause() {
        Log.i(TAG, "Lifecycle: onPause");
        super.onPause();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // only on regain: re-hiding while focus is leaving makes the bars flash
        if (hasFocus) applyImmersiveMode();
    }
}
