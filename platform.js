'use strict';
/* ============================================================
   CASTLE FLING — platform adapters (payments, ads, build config)

   This file is deliberately game-agnostic: it never touches save
   data or grants rewards. The game calls StorePayments.purchase()
   / Ads.showRewarded() and receives a normalized result object;
   reward granting lives in game.js (grantPurchaseReward etc.).

   Loaded before game.js.
   ============================================================ */

/* ---------------- build configuration ----------------
   When isProduction is true, mock purchases and mock ads are hard-disabled
   regardless of the enable flags, and a missing native bridge makes the feature
   "unavailable" instead of faking success.

   isProduction is DERIVED, not hand-set. Any native (Capacitor) build is a
   production surface: it talks to the real AdMob and Play Billing SDKs, so a
   simulated purchase or fake ad must be impossible there. A manual flag was the
   obvious way to get this wrong — ship a store build with it still false and
   the shop would happily hand out crowns for free. Browser and desktop builds,
   which have no native bridge at all, keep their mocks for development. */
const CF_PLATFORM = (() => {
  if (window.Capacitor && window.Capacitor.getPlatform) {
    const p = window.Capacitor.getPlatform();
    if (p === 'android' || p === 'ios') return p;
  }
  if (/Electron/i.test(navigator.userAgent)) return 'desktop';
  return 'web';
})();

const BUILD_CONFIG = {
  appName: 'Castle Fling',
  platform: CF_PLATFORM,
  isProduction: CF_PLATFORM === 'android' || CF_PLATFORM === 'ios',
  enableMockPurchases: true,   // dev-only; ignored when isProduction
  enableMockAds: true,         // dev-only; ignored when isProduction
  /* Native ads/billing bridges ship as of versionCode 11 — see
     native-bridge-android.js and the CastleFling*Plugin Java classes. */
  androidBridgeEnabled: true,
  iosBridgeEnabled: false,     // no iOS build yet
  supportContact: 'EmptyHelmetGames@gmail.com',
};
/* MUST stay. Every dev-only gate in game.js / ricochet.js / daily.js /
   tutorial.js reads window.BUILD_CONFIG, and a top-level `const` in a classic
   script creates a global LEXICAL binding — never a property on window. Without
   this line those gates read undefined, decide the build is not production, and
   ship their test hooks and debug code in the release. */
window.BUILD_CONFIG = BUILD_CONFIG;

function devWarn(msg) {
  if (!BUILD_CONFIG.isProduction) console.warn('[CastleFling:dev] ' + msg);
}

/* ---------------- ad unit configuration ----------------
   There are NO ad unit IDs in the JavaScript layer, by design. Ads are created
   natively, so the IDs live in exactly one place:

     build/mobile/android/app/build.gradle

   where the buildType picks the set and hands it to Java via BuildConfig and to
   the manifest via ${admobAppId}:
     release -> real Castle Fling units (App ID ...~8174715470)
     debug   -> Google's sample units, which never bill an advertiser

   Keeping them there rather than here means a debug build physically cannot
   serve a production ad, with no runtime flag to misconfigure. Read the current
   values at runtime with CastleFlingNative.getAdStatus().testMode. */

/* ---------------- IAP catalog ----------------
   PRODUCT IDS ARE NOT FINAL. Google Play will not accept product creation until
   a billing-enabled build has been uploaded, so these are the ids we intend to
   create — not ids known to exist. Nothing is purchasable until Play itself
   returns a product (see getProducts below), so a mismatch shows up as an empty
   shop, never as a broken buy button.

   AFTER creating the products in Play Console, confirm each id below matches
   the Console id EXACTLY. A crown pack is a CONSUMABLE (repurchasable); each
   also carries adFreeIncluded, which is the permanent forced-ad removal. */
const IAP_PRODUCTS = {
  /* Crown Shop (2026-07): premium currency is crowns; the old coin_pack_* ids
     are retired and must never be re-used for different grants */
  crown_pack_100:  { id: 'crown_pack_100',  crowns: 100,  priceLabel: '$0.99', adFreeIncluded: true },
  crown_pack_250:  { id: 'crown_pack_250',  crowns: 250,  priceLabel: '$1.99', adFreeIncluded: true },
  crown_pack_500:  { id: 'crown_pack_500',  crowns: 500,  priceLabel: '$2.99', adFreeIncluded: true },
  crown_pack_1000: { id: 'crown_pack_1000', crowns: 1000, priceLabel: '$4.99', adFreeIncluded: true },
};

/* ---------------- native bridge placeholders ----------------
   Native shells implement these before loading the game:

   window.CastleFlingNativePayments = {
     purchase(productId) -> Promise<{success, transactionId, receipt, ...}>,
     restorePurchases()  -> Promise<[{productId, transactionId}, ...]>,
     getProducts()       -> Promise<[{id, priceLabel}, ...]>,
   };
   window.CastleFlingNativeAds = {
     showInterstitial(reason) -> Promise<{shown, completed}>,
     showRewarded(reason)     -> Promise<{rewarded, completed}>,
     isInterstitialAvailable() -> bool,
     isRewardedAvailable()     -> bool,
     isOnline()                -> bool,      // VALIDATED internet, not "has an interface"
     refreshNetworkState()     -> Promise<bool>,
   };
   iOS may alternatively expose:
   window.webkit.messageHandlers.CastleFlingPayments / CastleFlingAds
*/
function androidPaymentsBridge() {
  return (BUILD_CONFIG.androidBridgeEnabled && window.CastleFlingNativePayments) || null;
}
function iosPaymentsBridge() {
  if (!BUILD_CONFIG.iosBridgeEnabled) return null;
  return window.CastleFlingNativePayments ||
    (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.CastleFlingPayments) || null;
}
function androidAdsBridge() {
  return (BUILD_CONFIG.androidBridgeEnabled && window.CastleFlingNativeAds) || null;
}
function iosAdsBridge() {
  if (!BUILD_CONFIG.iosBridgeEnabled) return null;
  return window.CastleFlingNativeAds ||
    (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.CastleFlingAds) || null;
}

/* ---------------- StorePayments adapter ---------------- */
const StorePayments = (() => {
  let mode = 'unavailable';   // 'android' | 'ios' | 'mock' | 'unavailable'
  let initialized = false;
  let mockSeq = 0;

  function resolveMode() {
    const p = BUILD_CONFIG.platform;
    if (p === 'android' && androidPaymentsBridge()) return 'android';
    if (p === 'ios' && iosPaymentsBridge()) return 'ios';
    if (!BUILD_CONFIG.isProduction && BUILD_CONFIG.enableMockPurchases) return 'mock';
    return 'unavailable';
  }

  const fail = (productId, reason, message) =>
    ({ success: false, productId, reason, message });

  return {
    async init() {
      mode = resolveMode();
      initialized = true;
      if (mode === 'mock') devWarn('Mock purchases enabled');
      if (BUILD_CONFIG.isProduction && mode === 'unavailable') devWarn('Production payment bridge unavailable');
      return mode;
    },

    /* Every entry carries an `available` flag, and the shop must honour it.
       On a real store, a product exists only if the store itself returned it:
       the static catalog is a list of what we INTEND to sell, never proof that
       it is on sale. Until the crown packs are created and activated in Play
       Console, Play returns nothing here and the shop shows no buy buttons. */
    async getProducts() {
      if (mode === 'android' || mode === 'ios') {
        try {
          const bridge = mode === 'android' ? androidPaymentsBridge() : iosPaymentsBridge();
          const list = await bridge.getProducts();
          // merge store price labels over the static catalog
          return Object.values(IAP_PRODUCTS).map(prod => {
            const live = (list || []).find(x => x.id === prod.id);
            return live
              ? Object.assign({}, prod, { priceLabel: live.priceLabel || prod.priceLabel, available: true })
              : Object.assign({}, prod, { available: false });
          });
        } catch (e) {
          // store unreachable: nothing is purchasable right now
          return Object.values(IAP_PRODUCTS).map(p => Object.assign({}, p, { available: false }));
        }
      }
      // dev mock: purchasable only outside a production build
      const mockAvailable = mode === 'mock' && !BUILD_CONFIG.isProduction;
      return Object.values(IAP_PRODUCTS).map(p => Object.assign({}, p, { available: mockAvailable }));
    },

    async purchase(productId) {
      if (!IAP_PRODUCTS[productId]) return fail(productId, 'failed', 'Unknown product.');
      if (mode === 'unavailable') return fail(productId, 'not_supported', 'Purchases are unavailable on this platform.');

      if (mode === 'mock') {
        if (BUILD_CONFIG.isProduction) return fail(productId, 'not_supported', 'Purchases are unavailable.');
        await new Promise(r => setTimeout(r, 700));   // simulate store round-trip
        return {
          success: true,
          productId,
          transactionId: `mock_${Date.now()}_${++mockSeq}_${Math.floor(Math.random() * 1e6)}`,
          platform: 'mock',
          receipt: null,
          verified: true,
        };
      }

      // native bridges: never grant before the store confirms
      try {
        const bridge = mode === 'android' ? androidPaymentsBridge() : iosPaymentsBridge();
        const raw = await bridge.purchase(productId);
        if (raw && raw.success) {
          return {
            success: true,
            productId,
            transactionId: raw.transactionId || null,
            platform: mode,
            receipt: raw.receipt || null,
            verified: raw.verified !== false,
          };
        }
        return fail(productId, (raw && raw.reason) || 'failed', (raw && raw.message) || 'Purchase did not complete.');
      } catch (e) {
        return fail(productId, 'failed', 'Purchase error: ' + (e && e.message || 'unknown'));
      }
    },

    async restorePurchases() {
      if (mode === 'unavailable') return { success: false, reason: 'not_supported', restored: [] };
      if (mode === 'mock') {
        if (BUILD_CONFIG.isProduction) return { success: false, reason: 'not_supported', restored: [] };
        return { success: true, restored: [], platform: 'mock' };   // mock has nothing server-side to restore
      }
      try {
        const bridge = mode === 'android' ? androidPaymentsBridge() : iosPaymentsBridge();
        const list = await bridge.restorePurchases();
        return {
          success: true,
          platform: mode,
          restored: (list || []).filter(x => x && IAP_PRODUCTS[x.productId]).map(x => ({
            productId: x.productId, transactionId: x.transactionId || null,
          })),
        };
      } catch (e) {
        return { success: false, reason: 'failed', restored: [], message: e && e.message };
      }
    },

    /* Ask the store to re-fetch its catalog. Only the native stores have one to
       re-fetch; everywhere else this is a no-op so callers need no platform
       check. Safe to call repeatedly. */
    async refreshProducts() {
      if (mode !== 'android' && mode !== 'ios') return false;
      const native = window.CastleFlingNative;
      if (!native || !native.refreshProducts) return false;
      try { await native.refreshProducts(); return true; } catch (e) { return false; }
    },

    isAvailable() { return initialized && mode !== 'unavailable'; },
    getMode() { return mode; },
  };
})();

/* ---------------- Ads adapter ---------------- */
const Ads = (() => {
  let mode = 'unavailable';   // 'android' | 'ios' | 'mock' | 'unavailable'
  let initialized = false;

  const adState = {
    initialized: false,
    interstitialShowing: false,
    rewardedShowing: false,
    lastInterstitialWave: null,
  };

  /* Status subscribers (connectivity, inventory). The adapter owns the list so
     there is exactly ONE set of listeners no matter how many game screens care:
     native pushes arrive through notifyStatusChanged(), and the browser
     online/offline events below are registered once, here, for web and desktop.
     Subscribing twice with the same function is a no-op. */
  const statusSubs = [];
  function notifySubs() {
    for (let i = 0; i < statusSubs.length; i++) {
      try { statusSubs[i](); } catch (e) { /* one bad subscriber must not stop the rest */ }
    }
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('online', notifySubs);
    window.addEventListener('offline', notifySubs);
  }

  function resolveMode() {
    const p = BUILD_CONFIG.platform;
    if (p === 'android' && androidAdsBridge()) return 'android';
    if (p === 'ios' && iosAdsBridge()) return 'ios';
    if (!BUILD_CONFIG.isProduction && BUILD_CONFIG.enableMockAds) return 'mock';
    return 'unavailable';
  }

  const fail = reason =>
    ({ success: false, rewarded: false, shown: false, reason, message: 'Ad was not completed.' });

  /* dev-only fake ad overlay: pauses interaction, counts down, and for
     rewarded ads offers a skip path so both outcomes are testable */
  function mockAdOverlay(kind, seconds) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'mockAdOverlay';
      wrap.innerHTML =
        `<div class="mockAdBox"><div class="mockAdTag">DEV MOCK AD — ${kind}</div>` +
        `<div class="mockAdTimer"></div>` +
        (kind === 'rewarded' ? '<button class="mockAdSkip">Skip (no reward)</button>' : '') +
        `</div>`;
      document.body.appendChild(wrap);
      let left = seconds;
      const timerEl = wrap.querySelector('.mockAdTimer');
      timerEl.textContent = `Reward in ${left}s…`;
      const iv = setInterval(() => {
        left--;
        if (left > 0) { timerEl.textContent = `Reward in ${left}s…`; return; }
        clearInterval(iv);
        wrap.remove();
        resolve(true);
      }, 1000);
      const skip = wrap.querySelector('.mockAdSkip');
      if (skip) skip.addEventListener('click', () => { clearInterval(iv); wrap.remove(); resolve(false); });
    });
  }

  return {
    adState,

    async init() {
      mode = resolveMode();
      initialized = true;
      adState.initialized = true;
      if (mode === 'mock') devWarn('Mock ads enabled');
      if (BUILD_CONFIG.isProduction && mode === 'unavailable') devWarn('Production ad bridge unavailable');
      return mode;
    },

    async showInterstitial(reason) {
      if (mode === 'unavailable') return fail('unavailable');
      if (adState.interstitialShowing || adState.rewardedShowing) return fail('failed');
      adState.interstitialShowing = true;
      try {
        if (mode === 'mock') {
          if (BUILD_CONFIG.isProduction) return fail('unavailable');
          await mockAdOverlay('interstitial', 2);
          return { success: true, shown: true, completed: true, reason, platform: 'mock' };
        }
        const bridge = mode === 'android' ? androidAdsBridge() : iosAdsBridge();
        const raw = await bridge.showInterstitial(reason);
        if (raw && raw.shown) return { success: true, shown: true, completed: raw.completed !== false, reason, platform: mode };
        return fail((raw && raw.reason) || 'failed');
      } catch (e) {
        return fail('failed');
      } finally {
        adState.interstitialShowing = false;
      }
    },

    async showRewarded(reason) {
      if (mode === 'unavailable') return fail('unavailable');
      if (adState.interstitialShowing || adState.rewardedShowing) return fail('failed');
      adState.rewardedShowing = true;
      try {
        if (mode === 'mock') {
          if (BUILD_CONFIG.isProduction) return fail('unavailable');
          const completed = await mockAdOverlay('rewarded', 3);
          if (!completed) return fail('cancelled');
          return { success: true, rewarded: true, completed: true, reason, platform: 'mock' };
        }
        const bridge = mode === 'android' ? androidAdsBridge() : iosAdsBridge();
        const raw = await bridge.showRewarded(reason);
        // reward ONLY on explicit completion
        if (raw && raw.rewarded === true && raw.completed === true) {
          return { success: true, rewarded: true, completed: true, reason, platform: mode };
        }
        return fail((raw && raw.reason) || 'cancelled');
      } catch (e) {
        return fail('failed');
      } finally {
        adState.rewardedShowing = false;
      }
    },

    isInterstitialAvailable() {
      if (mode === 'mock') return !BUILD_CONFIG.isProduction;
      if (mode === 'android' || mode === 'ios') {
        try {
          const bridge = mode === 'android' ? androidAdsBridge() : iosAdsBridge();
          return !!(bridge && bridge.isInterstitialAvailable());
        } catch (e) { return false; }
      }
      return false;
    },

    isRewardedAvailable() {
      if (mode === 'mock') return !BUILD_CONFIG.isProduction;
      if (mode === 'android' || mode === 'ios') {
        try {
          const bridge = mode === 'android' ? androidAdsBridge() : iosAdsBridge();
          return !!(bridge && bridge.isRewardedAvailable());
        } catch (e) { return false; }
      }
      return false;
    },

    /* ---------------- connectivity ----------------
       Tri-state on purpose: true, false, or null for "cannot tell". Only an
       explicit false is evidence the device is offline; null must be treated
       as online by callers, because guessing "offline" would block a player
       behind a prompt no amount of reconnecting can clear.

       This is an EARLY WARNING, never the verdict. The ad SDK's own load/show
       lifecycle decides whether an ad actually happened — this only classifies
       a failure that already occurred as "no connection" vs "no fill". */
    isOnline() {
      if (mode === 'android' || mode === 'ios') {
        const bridge = mode === 'android' ? androidAdsBridge() : iosAdsBridge();
        if (bridge && typeof bridge.isOnline === 'function') {
          try { return !!bridge.isOnline(); } catch (e) { return null; }
        }
      }
      // browser/desktop: navigator.onLine only ever proves the NEGATIVE case
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
      return null;
    },

    /** Re-read connectivity from the platform (used when the player taps Retry). */
    async refreshNetworkState() {
      if (mode === 'android' || mode === 'ios') {
        const bridge = mode === 'android' ? androidAdsBridge() : iosAdsBridge();
        if (bridge && typeof bridge.refreshNetworkState === 'function') {
          try { await bridge.refreshNetworkState(); } catch (e) { /* keep the cache */ }
        }
      }
      return Ads.isOnline();
    },

    /** Subscribe to connectivity / inventory changes. Idempotent per function. */
    onStatusChange(fn) {
      if (typeof fn !== 'function' || statusSubs.indexOf(fn) !== -1) return;
      statusSubs.push(fn);
    },

    /** Called by the native bridge when the plugin pushes a changed status. */
    notifyStatusChanged() { notifySubs(); },

    isAvailable() { return initialized && mode !== 'unavailable'; },
    getMode() { return mode; },
  };
})();

/* ---------------- legal / compliance copy ----------------
   Editable content for the Terms & Privacy screen. Keep the language
   store-safe: no personal data collected, payments handled by the
   platform stores, saves are local-only. */
const LEGAL = {
  sections: [
    { title: 'Terms & Conditions', body:
      'Castle Fling is provided as-is for entertainment. By playing you agree to use the game reasonably and accept that gameplay balance, content, and features may change with updates. Anything you buy is covered by the In-App Purchases and Virtual Currency sections below. Castle Fling is intended for a general audience and is not directed to children under 13.' },
    { title: 'Privacy Policy', body:
      'Castle Fling does not collect, store, or transmit personal information. There are no accounts, no analytics profiles of you as a person, and no sale of data.' },
    { title: 'In-App Purchases', body:
      'The only optional purchases are <b>crown packs</b> — bundles of crowns, the game’s premium currency. Pack sizes and prices are shown in the Crown Shop and are charged in your local currency. All payments are processed by your platform’s app store (Google Play or the Apple App Store) — the game never sees or stores your payment details. Every crown pack also permanently removes forced ads. <b>Coins cannot be purchased</b>; they are earned only by playing.' },
    { title: 'Virtual Currency & Items', body:
      'Crowns are spent on optional in-game content: Royal Treasury unlocks (castles, hand powers, room variants and cosmetics), saving a run, and extra Castle Ricochet attempts. Crowns can also be earned by playing, so no purchase is ever required to reach any content. Crowns, coins and unlocked items are a limited licence to use virtual items inside Castle Fling — they have no monetary value, cannot be exchanged for real money, and cannot be sold or transferred outside the game. Refunds are handled by your app store under its own policy and your local consumer rights.' },
    { title: 'Ads & Rewarded Ads', body:
      'The game may show an interstitial ad between waves and after a run has finished — never during combat. Purchasing any crown pack disables forced ads permanently. Optional rewarded ads (for example, to earn an extra upgrade choice) remain available to everyone and only play when you choose to watch them. Ads are served by Google AdMob; where required, you will be asked for advertising consent when the game starts, and you can change that choice at any time from Privacy Options in Settings.' },
    { title: 'Local Save Data', body:
      'Your progress — coins, crowns, unlocks, cosmetics, and settings — is saved locally on this device only. Deleting the app’s data or uninstalling may permanently remove local progress, including any unspent crowns you purchased. Cloud save is not currently offered.' },
    { title: 'Restore Purchases', body:
      'If your platform supports it, use the Restore Purchases button in the Shop to restore your ad-free status after reinstalling.' },
    { title: 'Contact & Support', body:
      'Questions or issues? Contact: ' + BUILD_CONFIG.supportContact },
  ],
};
