package com.emptyhelmetgames.castlefling;

import android.app.Activity;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.android.gms.ads.AdError;
import com.google.android.gms.ads.AdRequest;
import com.google.android.gms.ads.FullScreenContentCallback;
import com.google.android.gms.ads.LoadAdError;
import com.google.android.gms.ads.MobileAds;
import com.google.android.gms.ads.interstitial.InterstitialAd;
import com.google.android.gms.ads.interstitial.InterstitialAdLoadCallback;
import com.google.android.gms.ads.rewarded.RewardedAd;
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback;
// ConsentDebugSettings is deliberately NOT imported: geography overrides and
// forced-consent debugging must not exist in a shippable build.
import com.google.android.ump.ConsentInformation;
import com.google.android.ump.ConsentRequestParameters;
import com.google.android.ump.UserMessagingPlatform;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Google Mobile Ads for Castle Fling.
 *
 * Contract with the web layer (see platform.js / native-bridge-android.js):
 *   initialize()            -> runs UMP consent, then MobileAds init, then preloads
 *   getStatus()             -> availability snapshot, also pushed as adsStatusChanged
 *   showRewarded(reason)    -> {rewarded, completed} — TRUE ONLY on earned reward
 *   showInterstitial(reason)-> {shown, completed}
 *   showPrivacyOptionsForm()-> reopens the UMP privacy options form
 *
 * Design rules this file enforces:
 *  - MobileAds.initialize runs EXACTLY ONCE per process (static guard). The
 *    WebView can reload and re-run the JS layer; the SDK must not re-init.
 *  - No ad is ever REQUESTED before UMP reports canRequestAds().
 *  - A rewarded ad grants only from OnUserEarnedRewardListener. Opening,
 *    closing, clicking, impression and show-failure all grant nothing.
 *  - Every PluginCall resolves exactly once, guarded by an AtomicBoolean, so a
 *    duplicated SDK callback cannot deliver a second reward.
 *  - Failed loads retry with capped exponential backoff, never a tight loop.
 *  - Ad objects are destroyed (dereferenced) after use and a fresh one preloaded.
 *  - Connectivity is reported as VALIDATED internet, not "an interface exists".
 *    The required-interstitial gate in game.js blocks progression only on a
 *    confirmed-offline device, so a false "online" would trap a player behind
 *    an ad that can never load, and a false "offline" would block one for an
 *    ordinary no-fill. Wi-Fi attached to a captive portal is NOT online here.
 *
 * Ad unit IDs come from BuildConfig, which the buildType selects — debug gets
 * Google's sample units, release gets the real Castle Fling units. This class
 * never hardcodes an ID.
 */
@CapacitorPlugin(name = "CastleFlingAds")
public class CastleFlingAdsPlugin extends Plugin {

    private static final String TAG = "CastleFlingAds";

    /** Process-wide: survives WebView reloads and plugin re-instantiation. */
    private static final AtomicBoolean sdkInitStarted = new AtomicBoolean(false);
    private static volatile boolean sdkInitialized = false;

    private static final long RETRY_BASE_MS = 5_000L;
    private static final long RETRY_MAX_MS = 5 * 60_000L;
    private static final int RETRY_MAX_ATTEMPTS = 6;

    private final Handler main = new Handler(Looper.getMainLooper());

    private ConsentInformation consentInformation;

    private RewardedAd rewardedAd;
    private InterstitialAd interstitialAd;
    private boolean rewardedLoading = false;
    private boolean interstitialLoading = false;
    private int rewardedRetries = 0;
    private int interstitialRetries = 0;

    /** Guards against two overlapping full-screen presentations. */
    private boolean presenting = false;

    /** Registered exactly once; unregistered in handleOnDestroy. */
    private ConnectivityManager.NetworkCallback networkCallback;
    private ConnectivityManager connectivityManager;

    /* ============================================================
       INITIALIZATION  (consent first, then SDK, then preload)
       ============================================================ */

    @PluginMethod
    public void initialize(final PluginCall call) {
        final Activity activity = getActivity();
        if (activity == null) {
            call.resolve(status(false, "no-activity"));
            return;
        }
        main.post(() -> {
            try {
                /* Before consent: the web layer needs the connectivity signal
                   even when ads are not permitted, and a device that comes
                   online later must re-trigger the preload. */
                startNetworkWatch();
                runConsentFlow(activity, call);
            } catch (Throwable t) {
                // A consent failure must never leave the game stuck. Report and
                // let the caller carry on with ads simply unavailable.
                Log.w(TAG, "Consent flow threw; continuing without ads", t);
                call.resolve(status(false, "consent-exception"));
            }
        });
    }

    /**
     * UMP consent, requested on every launch as Google requires. The previous
     * choice is owned and persisted by the SDK — we never reset it, and
     * ConsentInformation.reset() is deliberately absent from this file so it
     * cannot ship in a production build.
     */
    private void runConsentFlow(@NonNull final Activity activity, final PluginCall call) {
        consentInformation = UserMessagingPlatform.getConsentInformation(activity);

        ConsentRequestParameters params = new ConsentRequestParameters.Builder()
            .setTagForUnderAgeOfConsent(false)
            .build();

        consentInformation.requestConsentInfoUpdate(
            activity,
            params,
            () -> UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity, formError -> {
                if (formError != null) {
                    Log.w(TAG, "Consent form error " + formError.getErrorCode()
                        + ": " + formError.getMessage());
                }
                // Whether or not the form errored, canRequestAds() is the single
                // authority on whether a request may be made.
                afterConsent(call);
            }),
            requestError -> {
                Log.w(TAG, "Consent info update failed "
                    + requestError.getErrorCode() + ": " + requestError.getMessage());
                // Consent state unknown -> canRequestAds() decides; on a fresh
                // install under GDPR that is false, and we simply serve no ads.
                afterConsent(call);
            });
    }

    private void afterConsent(final PluginCall call) {
        boolean canRequest = consentInformation != null && consentInformation.canRequestAds();
        if (!canRequest) {
            Log.i(TAG, "Consent does not permit ad requests yet.");
            call.resolve(status(false, "consent-required"));
            pushStatus();
            return;
        }
        initializeSdkOnce();
        call.resolve(status(true, "ok"));
        pushStatus();
    }

    /** MobileAds.initialize exactly once per process. */
    private void initializeSdkOnce() {
        if (!sdkInitStarted.compareAndSet(false, true)) {
            // Already initialized (or initializing) — just make sure inventory
            // is warm for this plugin instance.
            if (sdkInitialized) preloadAll();
            return;
        }
        Activity activity = getActivity();
        if (activity == null) return;
        Log.i(TAG, "Initializing Google Mobile Ads (testMode=" + BuildConfig.ADS_TEST_MODE + ")");
        if (BuildConfig.ADS_TEST_MODE) {
            Log.w(TAG, "TEST ADS ACTIVE — Google sample ad units, no real impressions.");
        }
        MobileAds.initialize(activity, initializationStatus -> {
            sdkInitialized = true;
            Log.i(TAG, "Mobile Ads SDK initialized");
            preloadAll();
            pushStatus();
        });
    }

    private void preloadAll() {
        loadRewarded();
        loadInterstitial();
    }

    private boolean adsAllowed() {
        return sdkInitialized
            && consentInformation != null
            && consentInformation.canRequestAds();
    }

    /* ============================================================
       CONNECTIVITY
       ============================================================ */

    /**
     * True only for a network the system has VALIDATED as reaching the
     * internet. An attached-but-useless interface (captive portal, router with
     * no upstream, mobile data with no service) reports false, which is the
     * distinction navigator.onLine cannot make and the whole reason this lives
     * natively. Any failure to determine the state returns true — "unknown"
     * must never be treated as offline, or a permission or OEM quirk would
     * block gameplay behind a connection prompt the player cannot satisfy.
     */
    private boolean isDeviceOnline() {
        try {
            ConnectivityManager cm = connectivity();
            if (cm == null) return true;
            Network active = cm.getActiveNetwork();
            if (active == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(active);
            if (caps == null) return false;
            return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        } catch (Throwable t) {
            Log.w(TAG, "Connectivity check failed; assuming online", t);
            return true;
        }
    }

    private ConnectivityManager connectivity() {
        if (connectivityManager == null) {
            Context ctx = getContext();
            if (ctx == null) return null;
            connectivityManager =
                (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
        }
        return connectivityManager;
    }

    /**
     * Watch for the connection coming back so the web layer can re-enable its
     * Retry path and rewarded buttons without the player restarting the app.
     * Registered ONCE (the null check is the duplicate-listener guard) and torn
     * down in handleOnDestroy. Regaining a validated network also resets the
     * backoff counters and re-preloads, so a reconnect does not have to wait
     * out a five-minute retry delay earned while offline.
     */
    private void startNetworkWatch() {
        if (networkCallback != null) return;
        ConnectivityManager cm = connectivity();
        if (cm == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(@NonNull Network network) {
                main.post(() -> {
                    Log.i(TAG, "Network available — resetting ad backoff and preloading");
                    rewardedRetries = 0;
                    interstitialRetries = 0;
                    preloadAll();
                    pushStatus();
                });
            }

            @Override
            public void onLost(@NonNull Network network) {
                main.post(() -> pushStatus());
            }

            @Override
            public void onCapabilitiesChanged(@NonNull Network network,
                                              @NonNull NetworkCapabilities caps) {
                // Covers the captive-portal case: the interface never changes,
                // only its VALIDATED capability does.
                main.post(() -> pushStatus());
            }
        };
        try {
            cm.registerNetworkCallback(
                new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build(),
                networkCallback);
        } catch (Throwable t) {
            Log.w(TAG, "registerNetworkCallback failed", t);
            networkCallback = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (networkCallback != null && connectivityManager != null) {
            try { connectivityManager.unregisterNetworkCallback(networkCallback); }
            catch (Throwable t) { Log.w(TAG, "unregisterNetworkCallback failed", t); }
        }
        networkCallback = null;
        super.handleOnDestroy();
    }

    /** Connectivity snapshot for the web layer, independent of consent/SDK state. */
    @PluginMethod
    public void getNetworkState(PluginCall call) {
        call.resolve(new JSObject().put("online", isDeviceOnline()));
    }

    /* ============================================================
       REWARDED  (Free Upgrade)
       ============================================================ */

    private void loadRewarded() {
        if (!adsAllowed() || rewardedLoading || rewardedAd != null) return;
        Activity activity = getActivity();
        if (activity == null) return;
        rewardedLoading = true;
        RewardedAd.load(activity, BuildConfig.ADMOB_REWARDED_ID,
            new AdRequest.Builder().build(),
            new RewardedAdLoadCallback() {
                @Override
                public void onAdLoaded(@NonNull RewardedAd ad) {
                    rewardedLoading = false;
                    rewardedRetries = 0;
                    rewardedAd = ad;
                    Log.i(TAG, "Rewarded ad loaded");
                    pushStatus();
                }

                @Override
                public void onAdFailedToLoad(@NonNull LoadAdError error) {
                    rewardedLoading = false;
                    rewardedAd = null;
                    Log.w(TAG, "Rewarded load failed: " + error.getCode() + " " + error.getMessage());
                    scheduleRetry(true);
                    pushStatus();
                }
            });
    }

    @PluginMethod
    public void showRewarded(final PluginCall call) {
        final Activity activity = getActivity();
        final String reason = call.getString("reason", "unspecified");
        if (activity == null) { call.resolve(rewardResult(false, "no-activity")); return; }

        main.post(() -> {
            if (presenting) { call.resolve(rewardResult(false, "already-presenting")); return; }
            final RewardedAd ad = rewardedAd;
            if (ad == null) {
                // Not loaded: the caller keeps the menu usable and grants nothing.
                loadRewarded();
                call.resolve(rewardResult(false, "not-loaded"));
                return;
            }

            // Hand the object off immediately: this presentation owns it, and a
            // second showRewarded() can never present the same ad.
            rewardedAd = null;
            presenting = true;

            final AtomicBoolean earned = new AtomicBoolean(false);
            final AtomicBoolean resolved = new AtomicBoolean(false);

            ad.setFullScreenContentCallback(new FullScreenContentCallback() {
                @Override
                public void onAdDismissedFullScreenContent() {
                    presenting = false;
                    // The ONLY place a rewarded result is reported. Dismissal
                    // alone grants nothing — earned.get() decides.
                    if (resolved.compareAndSet(false, true)) {
                        boolean ok = earned.get();
                        Log.i(TAG, "Rewarded dismissed (" + reason + ") earned=" + ok);
                        call.resolve(rewardResult(ok, ok ? "earned" : "dismissed-early"));
                    }
                    loadRewarded();   // destroyed by dereference; preload the next
                    pushStatus();
                }

                @Override
                public void onAdFailedToShowFullScreenContent(@NonNull AdError error) {
                    presenting = false;
                    Log.w(TAG, "Rewarded show failed: " + error.getCode() + " " + error.getMessage());
                    if (resolved.compareAndSet(false, true)) {
                        call.resolve(rewardResult(false, "show-failed"));
                    }
                    loadRewarded();
                    pushStatus();
                }

                @Override
                public void onAdShowedFullScreenContent() {
                    Log.i(TAG, "Rewarded shown (" + reason + ")");
                }
                // NOTE: no onAdImpression/onAdClicked handling on purpose —
                // neither is evidence the user earned the reward.
            });

            ad.show(activity, rewardItem -> {
                // Official earned-reward callback: the one source of truth.
                earned.set(true);
                Log.i(TAG, "User earned reward: " + rewardItem.getAmount()
                    + " " + rewardItem.getType());
            });
        });
    }

    /* ============================================================
       INTERSTITIAL
       ============================================================ */

    private void loadInterstitial() {
        if (!adsAllowed() || interstitialLoading || interstitialAd != null) return;
        Activity activity = getActivity();
        if (activity == null) return;
        interstitialLoading = true;
        InterstitialAd.load(activity, BuildConfig.ADMOB_INTERSTITIAL_ID,
            new AdRequest.Builder().build(),
            new InterstitialAdLoadCallback() {
                @Override
                public void onAdLoaded(@NonNull InterstitialAd ad) {
                    interstitialLoading = false;
                    interstitialRetries = 0;
                    interstitialAd = ad;
                    Log.i(TAG, "Interstitial loaded");
                    pushStatus();
                }

                @Override
                public void onAdFailedToLoad(@NonNull LoadAdError error) {
                    interstitialLoading = false;
                    interstitialAd = null;
                    Log.w(TAG, "Interstitial load failed: " + error.getCode() + " " + error.getMessage());
                    scheduleRetry(false);
                    pushStatus();
                }
            });
    }

    @PluginMethod
    public void showInterstitial(final PluginCall call) {
        final Activity activity = getActivity();
        final String reason = call.getString("reason", "unspecified");
        if (activity == null) { call.resolve(shownResult(false, "no-activity")); return; }

        main.post(() -> {
            if (presenting) { call.resolve(shownResult(false, "already-presenting")); return; }
            final InterstitialAd ad = interstitialAd;
            if (ad == null) {
                loadInterstitial();
                // Never block the transition the caller was making.
                call.resolve(shownResult(false, "not-loaded"));
                return;
            }
            interstitialAd = null;
            presenting = true;

            final AtomicBoolean resolved = new AtomicBoolean(false);

            ad.setFullScreenContentCallback(new FullScreenContentCallback() {
                @Override
                public void onAdDismissedFullScreenContent() {
                    presenting = false;
                    if (resolved.compareAndSet(false, true)) {
                        call.resolve(shownResult(true, "dismissed"));
                    }
                    loadInterstitial();
                    pushStatus();
                }

                @Override
                public void onAdFailedToShowFullScreenContent(@NonNull AdError error) {
                    presenting = false;
                    Log.w(TAG, "Interstitial show failed: " + error.getCode());
                    if (resolved.compareAndSet(false, true)) {
                        call.resolve(shownResult(false, "show-failed"));
                    }
                    loadInterstitial();
                    pushStatus();
                }

                @Override
                public void onAdShowedFullScreenContent() {
                    Log.i(TAG, "Interstitial shown (" + reason + ")");
                }
            });

            ad.show(activity);
        });
    }

    /* ============================================================
       RETRY  (capped exponential backoff — never a tight loop)
       ============================================================ */

    private void scheduleRetry(final boolean forRewarded) {
        int attempt = forRewarded ? rewardedRetries : interstitialRetries;
        if (attempt >= RETRY_MAX_ATTEMPTS) {
            Log.w(TAG, "Giving up preloading " + (forRewarded ? "rewarded" : "interstitial")
                + " after " + attempt + " attempts; will retry on next demand.");
            return;
        }
        long delay = Math.min(RETRY_BASE_MS * (1L << attempt), RETRY_MAX_MS);
        if (forRewarded) rewardedRetries++; else interstitialRetries++;
        main.postDelayed(() -> {
            if (forRewarded) loadRewarded(); else loadInterstitial();
        }, delay);
    }

    /* ============================================================
       PRIVACY OPTIONS  (Settings entry point)
       ============================================================ */

    @PluginMethod
    public void showPrivacyOptionsForm(final PluginCall call) {
        final Activity activity = getActivity();
        if (activity == null) { call.resolve(new JSObject().put("shown", false)); return; }
        main.post(() -> UserMessagingPlatform.showPrivacyOptionsForm(activity, formError -> {
            if (formError != null) {
                Log.w(TAG, "Privacy options form error: " + formError.getMessage());
            }
            call.resolve(new JSObject()
                .put("shown", formError == null)
                .put("error", formError == null ? null : formError.getMessage()));
            pushStatus();
        }));
    }

    /* ============================================================
       STATUS
       ============================================================ */

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status(adsAllowed(), "ok"));
    }

    /**
     * Rewarded outcome. `completed` is deliberately tied to `rewarded` rather
     * than tracked separately: platform.js grants only when BOTH are true, and
     * the single fact that decides both is whether the SDK fired the earned-
     * reward callback. Keeping them as one fact makes it impossible to report
     * "completed but not rewarded" and accidentally widen the grant condition.
     */
    private JSObject rewardResult(boolean rewarded, String reason) {
        return new JSObject()
            .put("rewarded", rewarded)
            .put("completed", rewarded)
            .put("reason", reason);
    }

    /** Interstitial outcome. Nothing is granted for these, so it is advisory. */
    private JSObject shownResult(boolean shown, String reason) {
        return new JSObject()
            .put("shown", shown)
            .put("completed", shown)
            .put("reason", reason);
    }

    private JSObject status(boolean allowed, String detail) {
        boolean privacyRequired = consentInformation != null
            && consentInformation.getPrivacyOptionsRequirementStatus()
               == ConsentInformation.PrivacyOptionsRequirementStatus.REQUIRED;
        return new JSObject()
            .put("initialized", sdkInitialized)
            .put("canRequestAds", allowed)
            .put("rewardedReady", rewardedAd != null)
            .put("interstitialReady", interstitialAd != null)
            .put("privacyOptionsRequired", privacyRequired)
            .put("testMode", BuildConfig.ADS_TEST_MODE)
            .put("online", isDeviceOnline())
            .put("detail", detail);
    }

    /**
     * Push availability to JS. platform.js asks for availability synchronously,
     * so the web layer keeps a cache that these events keep current.
     */
    private void pushStatus() {
        try {
            notifyListeners("adsStatusChanged", status(adsAllowed(), "push"));
        } catch (Throwable t) {
            Log.w(TAG, "pushStatus failed", t);
        }
    }
}
