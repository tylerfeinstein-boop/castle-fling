package com.castlefling.game;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private static final String TAG = "CastleFling";
    private static final String DIAG_PREFS = "castlefling_diag";
    private static final String KEY_RENDERER_RECOVERED = "rendererRecovered";

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.i(TAG, "App launch: onCreate (sdk=" + Build.VERSION.SDK_INT
            + ", model=" + Build.MODEL + ")");
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        hideSystemBars();
        createWebView();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        webView = new WebView(this);
        // Detect the system killing the WebView renderer process. Returning
        // true keeps the app alive; the WebView is destroyed and rebuilt so
        // the player never sits on a blank/frozen screen, and the game shows
        // its own themed recovery notice on reload.
        webView.setWebViewClient(new WebViewClient() {
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
                safelyDestroyWebView();
                recreateWebView();
                return true;   // handled — never let the whole app be killed
            }
        });
        webView.setWebChromeClient(new WebChromeClient());
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setBackgroundColor(0xff12100e);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(false);

        // JS -> Logcat diagnostics bridge (log() + one-shot recovery flag only)
        webView.addJavascriptInterface(new CastleFlingDiagnosticsBridge(), "CastleFlingDiagnostics");

        setContentView(webView);
        webView.loadUrl("file:///android_asset/www/index.html");
        Log.i(TAG, "WebView created");
    }

    private void safelyDestroyWebView() {
        if (webView == null) return;
        try {
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) parent.removeView(webView);
            webView.destroy();
        } catch (Exception e) {
            Log.e(TAG, "Failed to destroy dead WebView", e);
        }
        webView = null;
    }

    private void recreateWebView() {
        runOnUiThread(() -> {
            createWebView();
            Log.i(TAG, "WebView recreated after renderer termination");
        });
    }

    /** Minimal JS diagnostics surface (see game.js CrashDiagnostics). */
    private class CastleFlingDiagnosticsBridge {
        @JavascriptInterface
        public void log(String message) {
            if (message == null) return;
            if (message.length() > 4000) message = message.substring(0, 4000);
            Log.e("CastleFlingJS", message);
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
        try {
            if (webView != null) {
                webView.evaluateJavascript(
                    "window.CastleFlingDiag && window.CastleFlingDiag.record('android-trim-memory',{level:"
                        + level + "});", null);
            }
        } catch (Exception e) { /* diagnostics only — never crash for it */ }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        if (webView != null) {
            webView.evaluateJavascript(
                "window.__castleFlingBack ? window.__castleFlingBack() : false;",
                value -> {
                    if (!"true".equals(value)) moveTaskToBack(true);
                }
            );
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        Log.i(TAG, "Lifecycle: onResume");
        hideSystemBars();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onPause() {
        Log.i(TAG, "Lifecycle: onPause");
        if (webView != null) webView.onPause();
        super.onPause();
    }

    private void hideSystemBars() {
        Window window = getWindow();
        View decor = window.getDecorView();
        decor.setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = decor.getWindowInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
            }
        }
    }
}
