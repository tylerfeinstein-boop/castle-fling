'use strict';
/* ============================================================
   CASTLE FLING — Android native bridge shim

   Maps the Capacitor plugins (CastleFlingAds / CastleFlingBilling) onto the
   plain bridge objects platform.js already expects:

     window.CastleFlingNativeAds
     window.CastleFlingNativePayments

   Load order matters and is enforced in index.html:
     platform.js  ->  native-bridge-android.js  ->  game.js
   platform.js must be first because this file reads IAP_PRODUCTS from it;
   game.js must be last because it calls Ads.init() / StorePayments.init() at
   the bottom of the file, and those resolve the bridge mode on the spot.

   On web, desktop and iOS this file installs nothing and returns immediately,
   so the same bundle stays usable everywhere.

   Style note: no optional chaining / nullish coalescing anywhere in the shipped
   JS (project convention — see game.js).
   ============================================================ */

(function () {
  var cap = window.Capacitor;
  if (!cap || typeof cap.getPlatform !== 'function' || cap.getPlatform() !== 'android') return;

  /* ---------------- diagnostics ----------------
     Every failure path below used to be swallowed by a bare .catch(), which
     meant "no ads" and "the bridge was never wired" looked identical from the
     game side. Route problems to console AND to Logcat via the existing
     diagnostics interface, and keep the last N lines queryable on the device
     through CastleFlingNative.getDiagnostics(). */
  var diag = [];
  function logDiag(msg) {
    var line = '[CastleFlingBridge] ' + msg;
    diag.push(line);
    if (diag.length > 40) diag.shift();
    try { console.warn(line); } catch (e) { }
    try {
      if (window.CastleFlingDiagnostics && window.CastleFlingDiagnostics.log) {
        window.CastleFlingDiagnostics.log(line);
      }
    } catch (e) { }
  }

  /* Capacitor 4+ populates Capacitor.Plugins ONLY from registerPlugin(). A
     plugin registered natively (MainActivity.registerPlugin) is absent from
     that object until the web layer asks for it by name — reading
     Capacitor.Plugins.X directly yields undefined and silently disables the
     whole bridge. registerPlugin() is the supported accessor. */
  function getPlugin(name) {
    try {
      if (typeof cap.registerPlugin === 'function') return cap.registerPlugin(name);
    } catch (e) {
      logDiag('registerPlugin("' + name + '") threw: ' + (e && e.message));
    }
    return (cap.Plugins && cap.Plugins[name]) || null;
  }

  /* Whether the NATIVE side actually registered the plugin. PluginHeaders is
     injected by the native bridge and lists every registered plugin, so this
     distinguishes "Java class missing / not registered" from "ad failed to
     fill" — two problems with identical symptoms. */
  function nativelyRegistered(name) {
    var headers = cap.PluginHeaders;
    if (!headers || !headers.length) return null;   // unknown, not false
    for (var i = 0; i < headers.length; i++) {
      if (headers[i] && headers[i].name === name) return true;
    }
    return false;
  }

  var adsNative = nativelyRegistered('CastleFlingAds');
  var billingNative = nativelyRegistered('CastleFlingBilling');
  if (adsNative === false) logDiag('CastleFlingAds is NOT registered natively — check MainActivity.registerPlugin.');
  if (billingNative === false) logDiag('CastleFlingBilling is NOT registered natively — check MainActivity.registerPlugin.');
  if (adsNative === null) logDiag('Capacitor.PluginHeaders unavailable; cannot confirm native registration.');

  var AdsPlugin = getPlugin('CastleFlingAds');
  var BillingPlugin = getPlugin('CastleFlingBilling');
  logDiag('bridge init: ads=' + !!AdsPlugin + ' (native=' + adsNative + ')'
    + ' billing=' + !!BillingPlugin + ' (native=' + billingNative + ')');

  /* ---------------- ads ---------------- */

  /* platform.js asks for availability SYNCHRONOUSLY, but every Capacitor call
     is async. The plugin pushes an adsStatusChanged event on every load,
     failure, show and dismissal; this cache is what the sync getters read. */
  var adStatus = {
    initialized: false,
    canRequestAds: false,
    rewardedReady: false,
    interstitialReady: false,
    privacyOptionsRequired: false,
    testMode: false,
    /* Validated-internet flag from ConnectivityManager. Starts TRUE: until the
       native side says otherwise, "unknown" must never read as offline, or the
       required-interstitial gate would block a player it cannot help. */
    online: true,
  };

  function mergeAdStatus(s) {
    if (!s || typeof s !== 'object') return;
    var keys = ['initialized', 'canRequestAds', 'rewardedReady',
                'interstitialReady', 'privacyOptionsRequired', 'testMode', 'online'];
    var changed = false;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (typeof s[k] === 'undefined') continue;
      if (adStatus[k] !== !!s[k]) changed = true;
      adStatus[k] = !!s[k];
    }
    /* Hand every change to the Ads adapter, which owns the subscriber list.
       The game uses it to re-enable rewarded buttons and to update an open
       "connection required" prompt the moment the network comes back. */
    if (changed && typeof Ads !== 'undefined' && Ads.notifyStatusChanged) {
      try { Ads.notifyStatusChanged(); } catch (e) { }
    }
  }

  if (AdsPlugin) {
    try {
      /* addListener returns a promise; if the native plugin is missing it
         REJECTS rather than throwing, so it needs a catch of its own or it
         surfaces as an unhandled rejection. Polling still covers us either way. */
      var h = AdsPlugin.addListener('adsStatusChanged', mergeAdStatus);
      if (h && typeof h.catch === 'function') {
        h.catch(function (e) { logDiag('adsStatusChanged listener failed: ' + (e && e.message)); });
      }
    } catch (e) { logDiag('addListener(ads) threw: ' + (e && e.message)); }

    window.CastleFlingNativeAds = {
      showInterstitial: function (reason) {
        return AdsPlugin.showInterstitial({ reason: reason || 'unspecified' })
          .then(function (r) {
            return {
              shown: !!(r && r.shown),
              completed: !!(r && r.completed),
              reason: r && r.reason,
            };
          })
          .catch(function (e) {
            logDiag('showInterstitial failed: ' + (e && (e.message || e.errorMessage)));
            return { shown: false, completed: false, reason: 'error' };
          });
      },

      showRewarded: function (reason) {
        return AdsPlugin.showRewarded({ reason: reason || 'unspecified' })
          .then(function (r) {
            /* Pass the native verdict through untouched. platform.js grants
               only when BOTH flags are true, and the plugin sets them only
               from the official earned-reward callback. */
            return {
              rewarded: !!(r && r.rewarded),
              completed: !!(r && r.completed),
              reason: r && r.reason,
            };
          })
          .catch(function (e) {
            logDiag('showRewarded failed: ' + (e && (e.message || e.errorMessage)));
            return { rewarded: false, completed: false, reason: 'error' };
          });
      },

      isInterstitialAvailable: function () {
        return !!(adStatus.canRequestAds && adStatus.interstitialReady);
      },
      isRewardedAvailable: function () {
        return !!(adStatus.canRequestAds && adStatus.rewardedReady);
      },
      /* Device connectivity, NOT ad availability — the two are deliberately
         separate so a no-fill while online is never mistaken for an offline
         device. Cached from the plugin's push events; refreshNetworkState()
         re-reads it on demand (used by Retry). */
      isOnline: function () { return !!adStatus.online; },
      refreshNetworkState: function () {
        if (!AdsPlugin || !AdsPlugin.getNetworkState) return Promise.resolve(!!adStatus.online);
        return AdsPlugin.getNetworkState()
          .then(function (r) {
            mergeAdStatus({ online: !!(r && r.online) });
            return !!adStatus.online;
          })
          .catch(function () { return !!adStatus.online; });
      },
    };
  }

  /* ---------------- payments ---------------- */

  /* Purchases can land with no UI call waiting for them: bought while the app
     was closed, a pending payment that later cleared, or an interrupted
     fulfillment replayed by the startup sweep. Those arrive as events. game.js
     registers the handler after it defines grantPurchaseReward, so anything
     that fires first is buffered and flushed on registration — a purchase is
     never dropped for arriving early. */
  var purchaseHandler = null;
  var purchaseBuffer = [];

  function deliverPurchase(payload) {
    if (!payload) return;
    if (purchaseHandler) {
      try { purchaseHandler(payload); } catch (e) { /* never break the bridge */ }
    } else {
      purchaseBuffer.push(payload);
    }
  }

  if (BillingPlugin) {
    try {
      var bh = BillingPlugin.addListener('purchaseCompleted', deliverPurchase);
      if (bh && typeof bh.catch === 'function') {
        bh.catch(function (e) { logDiag('purchaseCompleted listener failed: ' + (e && e.message)); });
      }
    } catch (e) { logDiag('addListener(billing) threw: ' + (e && e.message)); }

    window.CastleFlingNativePayments = {
      purchase: function (productId) {
        return BillingPlugin.purchase({ productId: productId })
          .then(function (r) { return r || { success: false, reason: 'failed' }; })
          .catch(function () {
            return { success: false, reason: 'failed', message: 'Store error.' };
          });
      },

      restorePurchases: function () {
        return BillingPlugin.restorePurchases()
          .then(function (r) { return (r && r.restored) ? r.restored : []; })
          .catch(function () { return []; });
      },

      getProducts: function () {
        return BillingPlugin.getProducts()
          .then(function (r) { return (r && r.products) ? r.products : []; })
          .catch(function (e) {
            logDiag('getProducts failed: ' + (e && (e.message || e.errorMessage)));
            return [];
          });
      },

      /* Re-ask Play for the catalog. Used when the shop opens with nothing to
         sell, so a product activated after launch appears without a restart. */
      refreshProducts: function () {
        return BillingPlugin.refreshProducts()
          .then(function (r) { logDiag('refreshProducts -> ' + JSON.stringify(r)); return r; })
          .catch(function (e) {
            logDiag('refreshProducts failed: ' + (e && (e.message || e.errorMessage)));
            return null;
          });
      },
    };
  }

  /* ---------------- public helpers for the game layer ---------------- */

  window.CastleFlingNative = {
    /** Everything needed to tell apart the ways ads can fail to appear.
     *  On a device: CastleFlingNative.getDiagnostics() */
    getDiagnostics: function () {
      return {
        adsPluginAcquired: !!AdsPlugin,
        billingPluginAcquired: !!BillingPlugin,
        adsRegisteredNatively: adsNative,
        billingRegisteredNatively: billingNative,
        adStatus: window.CastleFlingNative.getAdStatus(),
        adsAdapterMode: (typeof Ads !== 'undefined' && Ads.getMode) ? Ads.getMode() : 'n/a',
        log: diag.slice(),
      };
    },

    /** Async billing snapshot: connection state and how many products Play
     *  actually returned. Pair with getDiagnostics() when the shop is empty. */
    getBillingStatus: function () {
      if (!BillingPlugin) return Promise.resolve({ connected: false, detail: 'no-plugin' });
      return BillingPlugin.getStatus()
        .then(function (s) {
          return BillingPlugin.getProducts().then(function (p) {
            s.sellableProducts = (p && p.products) ? p.products.length : 0;
            return s;
          });
        })
        .catch(function (e) { return { connected: false, detail: 'error: ' + (e && e.message) }; });
    },

    /** True once UMP says a privacy-options entry point must be offered. */
    isPrivacyOptionsRequired: function () { return !!adStatus.privacyOptionsRequired; },

    showPrivacyOptionsForm: function () {
      if (!AdsPlugin) return Promise.resolve({ shown: false });
      return AdsPlugin.showPrivacyOptionsForm()
        .then(function (r) { return r || { shown: false }; })
        .catch(function () { return { shown: false }; });
    },

    getAdStatus: function () {
      var copy = {};
      for (var k in adStatus) if (Object.prototype.hasOwnProperty.call(adStatus, k)) copy[k] = adStatus[k];
      return copy;
    },

    refreshAdStatus: function () {
      if (!AdsPlugin) return Promise.resolve(adStatus);
      return AdsPlugin.getStatus()
        .then(function (s) { mergeAdStatus(s); return adStatus; })
        .catch(function () { return adStatus; });
    },

    /** game.js hands us its idempotent fulfillment function. */
    setPurchaseHandler: function (fn) {
      purchaseHandler = typeof fn === 'function' ? fn : null;
      if (!purchaseHandler) return;
      var pending = purchaseBuffer;
      purchaseBuffer = [];
      for (var i = 0; i < pending.length; i++) deliverPurchase(pending[i]);
    },
  };

  /* ---------------- kick off native init ----------------
     Both are fire-and-forget: nothing here blocks game startup, and both
     plugins are safe to call into before they finish initializing. */

  if (AdsPlugin) {
    AdsPlugin.initialize()
      .then(function (s) {
        mergeAdStatus(s);
        logDiag('ads initialize -> ' + JSON.stringify(s));
        if (s && s.canRequestAds === false) {
          logDiag('ads NOT permitted yet (detail=' + (s && s.detail) + '). '
            + 'consent-required means UMP has not granted consent.');
        }
        /* Inventory arrives after the SDK settles; the status events keep the
           cache current, and these polls cover a missed first event. */
        setTimeout(function () { window.CastleFlingNative.refreshAdStatus(); }, 4000);
        setTimeout(function () {
          window.CastleFlingNative.refreshAdStatus().then(function (st) {
            logDiag('ad status @15s: ' + JSON.stringify(st));
          });
        }, 15000);
      })
      .catch(function (e) {
        logDiag('ads initialize REJECTED: ' + (e && (e.message || e.errorMessage))
          + ' — if this says "not implemented", the native plugin is not registered.');
      });
  }

  if (BillingPlugin) {
    /* Ask Play about exactly the ids the catalog declares. Until these are
       created and activated in Play Console, Play returns nothing, getProducts()
       comes back empty, and the shop keeps its buttons disabled. */
    var ids = [];
    try {
      if (typeof IAP_PRODUCTS === 'object' && IAP_PRODUCTS) ids = Object.keys(IAP_PRODUCTS);
    } catch (e) { ids = []; }

    /* Record what JS actually sent. Without this, "the catalog never reached
       native" and "Play returned nothing" produce an identical empty shop, and
       the diagnostic report cannot tell them apart. */
    if (!ids.length) {
      logDiag('billing initialize: NO product ids resolved from IAP_PRODUCTS — '
        + 'platform.js did not load before this file.');
    } else {
      logDiag('billing initialize: sending ' + ids.length + ' id(s): ' + ids.join(','));
    }

    BillingPlugin.initialize({ productIds: ids })
      .then(function (s) { logDiag('billing initialize -> ' + JSON.stringify(s)); })
      .catch(function (e) {
        logDiag('billing initialize REJECTED: ' + (e && (e.message || e.errorMessage)));
      });
  }
})();
