package com.emptyhelmetgames.castlefling;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.ConsumeParams;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Google Play Billing for Castle Fling.
 *
 * Contract with the web layer (see platform.js):
 *   initialize(productIds[]) -> connect, then query whatever products exist
 *   getProducts()            -> [{id, priceLabel}] — EMPTY until products are
 *                               created and activated in Play Console
 *   purchase(productId)      -> {success, transactionId, ...}
 *   restorePurchases()       -> [{productId, transactionId}]
 *
 * Design rules this file enforces:
 *  - One BillingClient, one connection, reconnected with capped backoff.
 *  - Startup is never blocked: initialize() resolves as soon as the connection
 *    attempt settles, and every entry point is safe while disconnected.
 *  - Nothing is granted locally. A purchase is reported to JS only after Play
 *    reports PURCHASED, and the game's grantPurchaseReward() dedupes on the
 *    transaction id, so fulfillment is idempotent.
 *  - Consumables are CONSUMED (repurchasable); non-consumables are
 *    ACKNOWLEDGED and never consumed. Every purchase must be one or the other
 *    within 3 days or Play auto-refunds it.
 *  - Purchases that complete while the game is closed, or arrive late, are
 *    picked up by the queryPurchases sweep on every initialize().
 *
 * NOTE ON PRODUCT IDS: this build ships with an EMPTY catalog on purpose. The
 * crown packs cannot exist in Play Console until a billing-enabled build has
 * been uploaded, so the JS layer passes the ids it knows and this plugin simply
 * reports which of them Play actually recognises. Anything Play does not return
 * stays unavailable, and the shop keeps its buttons disabled.
 */
@CapacitorPlugin(name = "CastleFlingBilling")
public class CastleFlingBillingPlugin extends Plugin implements PurchasesUpdatedListener {

    private static final String TAG = "CastleFlingBilling";

    private static final long RETRY_BASE_MS = 2_000L;
    private static final long RETRY_MAX_MS = 5 * 60_000L;
    private static final int RETRY_MAX_ATTEMPTS = 8;

    private final Handler main = new Handler(Looper.getMainLooper());

    private BillingClient billingClient;
    private boolean connected = false;
    private boolean connecting = false;
    private int retries = 0;

    /** Product ids the JS layer asked about, and what Play actually returned. */
    private final List<String> requestedProductIds = new ArrayList<>();
    private final Map<String, ProductDetails> productDetails = new HashMap<>();

    /* Outcome of the last catalog query, surfaced through getStatus() so the
       in-app diagnostic report is self-sufficient. An empty shop has four
       distinct causes — ids never sent, never connected, Play refused the ids,
       or Play returned them with no sellable offer — and they are
       indistinguishable from the JS side without these. */
    private static final int QUERY_NEVER_RAN = -999;
    private int lastQueryCode = QUERY_NEVER_RAN;
    private String lastQueryMessage = "";
    private int queryCount = 0;
    private final List<String> lastUnfetched = new ArrayList<>();

    /**
     * Non-consumable ids. Castle Fling currently sells only consumable crown
     * packs (ad-free is bundled into each pack), so this is empty — but the
     * acknowledge-don't-consume path below is live, so adding an id here is all
     * that a future permanent entitlement needs.
     */
    private static final List<String> NON_CONSUMABLE_IDS = Collections.emptyList();

    /** In-flight purchase call, so the async PurchasesUpdatedListener can answer it. */
    private PluginCall pendingPurchaseCall;
    private String pendingPurchaseProductId;

    /* ============================================================
       CONNECTION
       ============================================================ */

    @PluginMethod
    public void initialize(final PluginCall call) {
        final Activity activity = getActivity();
        if (activity == null) { call.resolve(state("no-activity")); return; }

        requestedProductIds.clear();
        try {
            JSArray ids = call.getArray("productIds");
            if (ids != null) {
                for (Object o : ids.toList()) {
                    if (o != null) requestedProductIds.add(String.valueOf(o));
                }
            }
        } catch (JSONException e) {
            Log.w(TAG, "Bad productIds argument; continuing with none", e);
        }
        Log.i(TAG, "initialize() received " + requestedProductIds.size()
            + " product id(s): " + requestedProductIds);

        main.post(() -> {
            try {
                ensureClient();
                connect(() -> {
                    // Sweep for anything bought while the game was closed, and
                    // for purchases whose fulfillment was interrupted.
                    queryExistingPurchases();
                    queryProducts(() -> call.resolve(state("ok")));
                }, failure -> call.resolve(state(failure)));
            } catch (Throwable t) {
                // Billing must never take the game down with it.
                Log.w(TAG, "Billing init failed; continuing without billing", t);
                call.resolve(state("exception"));
            }
        });
    }

    private void ensureClient() {
        if (billingClient != null) return;
        billingClient = BillingClient.newBuilder(getContext())
            .setListener(this)
            .enablePendingPurchases(
                PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .build();
    }

    private interface OnConnected { void run(); }
    private interface OnFailed { void run(String reason); }

    private void connect(final OnConnected done, final OnFailed failed) {
        if (billingClient == null) { failed.run("no-client"); return; }
        if (connected) { done.run(); return; }
        if (connecting) { failed.run("connecting"); return; }
        connecting = true;

        billingClient.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(@NonNull BillingResult result) {
                connecting = false;
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    connected = true;
                    retries = 0;
                    Log.i(TAG, "Billing connected");
                    done.run();
                } else {
                    connected = false;
                    Log.w(TAG, "Billing setup failed: " + result.getResponseCode()
                        + " " + result.getDebugMessage());
                    // BILLING_UNAVAILABLE means no Play Store / no account —
                    // e.g. sideloaded or an emulator without Play. Not an error
                    // the player should ever see.
                    scheduleReconnect();
                    failed.run("setup-" + result.getResponseCode());
                }
            }

            @Override
            public void onBillingServiceDisconnected() {
                connecting = false;
                connected = false;
                Log.w(TAG, "Billing disconnected");
                scheduleReconnect();
            }
        });
    }

    private void scheduleReconnect() {
        if (retries >= RETRY_MAX_ATTEMPTS) {
            Log.w(TAG, "Billing reconnect gave up after " + retries + " attempts.");
            return;
        }
        long delay = Math.min(RETRY_BASE_MS * (1L << retries), RETRY_MAX_MS);
        retries++;
        main.postDelayed(() -> connect(() -> {
            queryExistingPurchases();
            queryProducts(null);
        }, reason -> { /* backoff continues from onBillingSetupFinished */ }), delay);
    }

    /* ============================================================
       PRODUCTS
       ============================================================ */

    private void queryProducts(final Runnable done) {
        /* Say WHY no query happened. Returning silently here made an empty shop
           indistinguishable from a shop that never asked: the "Product query"
           line below simply never appeared, so the absence of output looked the
           same as Play returning nothing. */
        if (!connected) {
            Log.w(TAG, "Skipping product query: billing not connected.");
            if (done != null) done.run();
            return;
        }
        if (requestedProductIds.isEmpty()) {
            Log.w(TAG, "Skipping product query: the web layer sent NO product ids "
                + "(expected 4 crown packs). The JS bridge never reached initialize().");
            if (done != null) done.run();
            return;
        }
        Log.i(TAG, "Querying Play for: " + requestedProductIds);
        List<QueryProductDetailsParams.Product> products = new ArrayList<>();
        for (String id : requestedProductIds) {
            products.add(QueryProductDetailsParams.Product.newBuilder()
                .setProductId(id)
                .setProductType(BillingClient.ProductType.INAPP)
                .build());
        }
        billingClient.queryProductDetailsAsync(
            QueryProductDetailsParams.newBuilder().setProductList(products).build(),
            (billingResult, queryResult) -> {
                productDetails.clear();
                lastUnfetched.clear();
                queryCount++;
                lastQueryCode = billingResult.getResponseCode();
                lastQueryMessage = billingResult.getDebugMessage() == null
                    ? "" : billingResult.getDebugMessage();
                /* Billing 9.x hands back a QueryProductDetailsResult, not a bare
                   List<ProductDetails>. It also reports ids Play did NOT
                   recognise via getUnfetchedProductList() — which, until the
                   catalog exists in Play Console, is every id we asked for. */
                if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    Log.w(TAG, "Product query failed: " + billingResult.getResponseCode()
                        + " " + billingResult.getDebugMessage());
                } else if (queryResult != null) {
                    List<ProductDetails> list = queryResult.getProductDetailsList();
                    if (list != null) {
                        for (ProductDetails pd : list) productDetails.put(pd.getProductId(), pd);
                    }
                    /* Name the ids Play would NOT sell us. Without this an
                       unrecognised id and a recognised-but-unpurchasable one
                       look identical from the log, which is the difference
                       between "wrong id / not activated" and "wrong track or
                       tester account". */
                    try {
                        List<com.android.billingclient.api.UnfetchedProduct> unfetched =
                            queryResult.getUnfetchedProductList();
                        if (unfetched != null && !unfetched.isEmpty()) {
                            StringBuilder sb = new StringBuilder();
                            for (com.android.billingclient.api.UnfetchedProduct u : unfetched) {
                                if (u == null) continue;
                                if (sb.length() > 0) sb.append(", ");
                                sb.append(u.getProductId()).append(" (status ")
                                  .append(u.getStatusCode()).append(')');
                                lastUnfetched.add(u.getProductId() + ":" + u.getStatusCode());
                            }
                            Log.w(TAG, "Play did NOT return: " + sb);
                        }
                    } catch (Throwable t) {
                        Log.w(TAG, "Could not read unfetched product list", t);
                    }
                }
                // An empty result is the EXPECTED state until the catalog is
                // created in Play Console. Not an error.
                Log.i(TAG, "Product query: asked " + requestedProductIds.size()
                    + ", Play returned " + productDetails.size());
                for (ProductDetails pd : productDetails.values()) {
                    ProductDetails.OneTimePurchaseOfferDetails o = resolveOffer(pd);
                    Log.i(TAG, "  " + pd.getProductId() + " -> "
                        + (o == null ? "NO OFFER" : o.getFormattedPrice()));
                }
                if (done != null) done.run();
            });
    }

    /**
     * Resolve the offer to sell for a one-time product.
     *
     * Play's newer one-time-product model puts pricing on PURCHASE OPTIONS, and
     * the singular getOneTimePurchaseOfferDetails() returns only the option
     * flagged "backwards compatible". A product configured purely with purchase
     * options therefore comes back from Play perfectly intact and still yields
     * null there — which silently dropped it from the catalog and left the shop
     * empty with no error anywhere. Prefer the LIST accessor, which returns
     * every option regardless of that flag, and keep the singular one as a
     * fallback for anything configured the old way.
     */
    private ProductDetails.OneTimePurchaseOfferDetails resolveOffer(ProductDetails pd) {
        try {
            List<ProductDetails.OneTimePurchaseOfferDetails> list = pd.getOneTimePurchaseOfferDetailsList();
            if (list != null && !list.isEmpty()) {
                for (ProductDetails.OneTimePurchaseOfferDetails o : list) {
                    if (o != null) return o;
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "getOneTimePurchaseOfferDetailsList failed; falling back", t);
        }
        return pd.getOneTimePurchaseOfferDetails();
    }

    /**
     * Re-ask Play for the catalog. The startup query runs once, so a product
     * activated (or finished propagating) after launch would otherwise stay
     * invisible until the app was fully restarted. The shop calls this when it
     * opens with nothing to sell.
     */
    @PluginMethod
    public void refreshProducts(final PluginCall call) {
        main.post(() -> {
            if (!connected) {
                // Reconnect first; the connection callback re-queries for us.
                connect(() -> queryProducts(() -> call.resolve(state("refreshed"))),
                        reason -> call.resolve(state(reason)));
                return;
            }
            queryProducts(() -> call.resolve(state("refreshed")));
        });
    }

    @PluginMethod
    public void getProducts(PluginCall call) {
        JSArray out = new JSArray();
        int noOffer = 0;
        for (ProductDetails pd : productDetails.values()) {
            ProductDetails.OneTimePurchaseOfferDetails offer = resolveOffer(pd);
            if (offer == null) {
                // Play knows the product but exposed no purchasable offer.
                noOffer++;
                Log.w(TAG, "No offer for " + pd.getProductId()
                    + " — check its purchase option is active in Play Console.");
                continue;
            }
            out.put(new JSObject()
                .put("id", pd.getProductId())
                .put("priceLabel", offer.getFormattedPrice()));
        }
        Log.i(TAG, "getProducts: " + out.length() + " sellable, "
            + noOffer + " known-but-no-offer, " + productDetails.size() + " fetched");
        call.resolve(new JSObject().put("products", out));
    }

    /* ============================================================
       PURCHASE
       ============================================================ */

    @PluginMethod
    public void purchase(final PluginCall call) {
        final Activity activity = getActivity();
        final String productId = call.getString("productId");
        if (activity == null || productId == null) {
            call.resolve(failure(productId, "failed", "Purchase unavailable."));
            return;
        }
        if (!connected) {
            call.resolve(failure(productId, "not_supported", "Store is unavailable."));
            return;
        }
        final ProductDetails details = productDetails.get(productId);
        if (details == null) {
            // Product not configured/activated in Play Console yet.
            call.resolve(failure(productId, "not_supported", "This item is not available yet."));
            return;
        }
        if (pendingPurchaseCall != null) {
            call.resolve(failure(productId, "failed", "Another purchase is in progress."));
            return;
        }

        main.post(() -> {
            pendingPurchaseCall = call;
            pendingPurchaseProductId = productId;

            List<BillingFlowParams.ProductDetailsParams> params = new ArrayList<>();
            /* A product sold through purchase options needs the OFFER TOKEN to
               say which option is being bought; without it Play rejects the
               flow. The token comes from the same offer getProducts() priced,
               so what the player sees is what they are charged. */
            ProductDetails.OneTimePurchaseOfferDetails offer = resolveOffer(details);
            String offerToken = null;
            try {
                if (offer != null) offerToken = offer.getOfferToken();
            } catch (Throwable ignored) { }

            BillingFlowParams.ProductDetailsParams.Builder pdp =
                BillingFlowParams.ProductDetailsParams.newBuilder()
                    .setProductDetails(details);
            if (offerToken != null && !offerToken.isEmpty()) pdp.setOfferToken(offerToken);
            params.add(pdp
                .build());

            BillingResult r = billingClient.launchBillingFlow(activity,
                BillingFlowParams.newBuilder().setProductDetailsParamsList(params).build());

            if (r.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                Log.w(TAG, "launchBillingFlow failed: " + r.getResponseCode());
                resolvePending(failure(productId, "failed", "Could not open the store."));
            }
        });
    }

    /** Play's callback for every purchase outcome, including ones we did not start. */
    @Override
    public void onPurchasesUpdated(@NonNull BillingResult result, List<Purchase> purchases) {
        int code = result.getResponseCode();

        if (code == BillingClient.BillingResponseCode.USER_CANCELED) {
            resolvePending(failure(pendingPurchaseProductId, "cancelled", "Purchase cancelled."));
            return;
        }
        if (code != BillingClient.BillingResponseCode.OK || purchases == null) {
            resolvePending(failure(pendingPurchaseProductId, "failed",
                "Purchase failed (" + code + ")."));
            return;
        }
        for (Purchase p : purchases) handlePurchase(p);
    }

    /**
     * Single fulfillment path for a purchase from any source: the active flow,
     * a purchase completed while the game was closed, or a queryPurchases sweep.
     */
    private void handlePurchase(final Purchase purchase) {
        if (purchase.getPurchaseState() == Purchase.PurchaseState.PENDING) {
            // Deferred payment (cash, family approval). Grant NOTHING now; the
            // sweep on a later launch will pick it up once it becomes PURCHASED.
            Log.i(TAG, "Purchase pending; nothing granted yet.");
            resolvePending(failure(pendingPurchaseProductId, "pending",
                "Payment is pending approval."));
            return;
        }
        if (purchase.getPurchaseState() != Purchase.PurchaseState.PURCHASED) return;

        final String productId = purchase.getProducts().isEmpty()
            ? pendingPurchaseProductId : purchase.getProducts().get(0);
        final String token = purchase.getPurchaseToken();
        final String orderId = purchase.getOrderId();
        // Transaction identity handed to JS. The order id is the stable Play
        // identifier; the token is the fallback so this is never null and the
        // game's dedupe key always exists.
        final String transactionId = (orderId != null && !orderId.isEmpty()) ? orderId : token;

        if (NON_CONSUMABLE_IDS.contains(productId)) {
            if (purchase.isAcknowledged()) {
                report(productId, transactionId, true);
                return;
            }
            billingClient.acknowledgePurchase(
                AcknowledgePurchaseParams.newBuilder().setPurchaseToken(token).build(),
                billingResult -> {
                    boolean ok = billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK;
                    Log.i(TAG, "Acknowledge " + productId + " -> " + billingResult.getResponseCode());
                    report(productId, transactionId, ok);
                });
            return;
        }

        // Consumable (crown packs). Report to JS FIRST so the balance is saved,
        // then consume. If the process dies between the two, the purchase stays
        // unconsumed and the next sweep replays it — and grantPurchaseReward()
        // drops the duplicate on transaction id.
        report(productId, transactionId, true);
        billingClient.consumeAsync(
            ConsumeParams.newBuilder().setPurchaseToken(token).build(),
            (billingResult, outToken) ->
                Log.i(TAG, "Consume " + productId + " -> " + billingResult.getResponseCode()));
    }

    /** Deliver a confirmed purchase to JS: answers the live call if there is one. */
    private void report(String productId, String transactionId, boolean ok) {
        JSObject payload = new JSObject()
            .put("success", ok)
            .put("productId", productId)
            .put("transactionId", transactionId)
            .put("platform", "android")
            .put("verified", true);

        if (pendingPurchaseCall != null
                && productId != null
                && productId.equals(pendingPurchaseProductId)) {
            resolvePending(payload);
        } else {
            // Out-of-band: bought while closed, restored, or a late callback.
            // JS grants it through the same idempotent path.
            notifyListeners("purchaseCompleted", payload);
        }
    }

    /** Resolves the in-flight purchase call exactly once. */
    private void resolvePending(JSObject payload) {
        PluginCall call = pendingPurchaseCall;
        pendingPurchaseCall = null;
        pendingPurchaseProductId = null;
        if (call != null) call.resolve(payload);
    }

    /* ============================================================
       RESTORE
       ============================================================ */

    private void queryExistingPurchases() {
        if (!connected) return;
        billingClient.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.INAPP)
                .build(),
            (billingResult, purchases) -> {
                if (billingResult.getResponseCode() != BillingClient.BillingResponseCode.OK
                        || purchases == null) return;
                Log.i(TAG, "Sweep found " + purchases.size() + " outstanding purchase(s)");
                for (Purchase p : purchases) handlePurchase(p);
            });
    }

    @PluginMethod
    public void restorePurchases(final PluginCall call) {
        if (!connected) {
            call.resolve(new JSObject().put("restored", new JSArray()));
            return;
        }
        billingClient.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.INAPP)
                .build(),
            (billingResult, purchases) -> {
                JSArray out = new JSArray();
                if (billingResult.getResponseCode() == BillingClient.BillingResponseCode.OK
                        && purchases != null) {
                    for (Purchase p : purchases) {
                        if (p.getPurchaseState() != Purchase.PurchaseState.PURCHASED) continue;
                        String pid = p.getProducts().isEmpty() ? null : p.getProducts().get(0);
                        String orderId = p.getOrderId();
                        out.put(new JSObject()
                            .put("productId", pid)
                            .put("transactionId",
                                (orderId != null && !orderId.isEmpty()) ? orderId : p.getPurchaseToken()));
                        // Also fulfil anything still outstanding.
                        handlePurchase(p);
                    }
                }
                call.resolve(new JSObject().put("restored", out));
            });
    }

    /* ============================================================
       STATUS
       ============================================================ */

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(state("ok"));
    }

    /** A purchase that did not happen. Shape matches what platform.js reads. */
    private JSObject failure(String productId, String reason, String message) {
        return new JSObject()
            .put("success", false)
            .put("productId", productId)
            .put("reason", reason)
            .put("message", message);
    }

    /**
     * Connection + catalog state, detailed enough that the in-app diagnostic
     * report alone identifies why a shop is empty:
     *   requestedIds empty  -> the web layer never delivered the catalog
     *   connected false     -> no Play Store / no account on the device
     *   queryCount 0        -> connected, but the query never ran
     *   unfetched non-empty -> Play REFUSED these ids (status code says why)
     *   productCount > 0 but no offers -> ids fine, purchase option not live
     */
    private JSObject state(String detail) {
        JSArray ids = new JSArray();
        for (String id : requestedProductIds) ids.put(id);
        JSArray unfetched = new JSArray();
        for (String u : lastUnfetched) unfetched.put(u);
        return new JSObject()
            .put("connected", connected)
            .put("productCount", productDetails.size())
            .put("detail", detail)
            .put("requestedIds", ids)
            .put("queryCount", queryCount)
            .put("lastQueryCode", lastQueryCode)
            .put("lastQueryMessage", lastQueryMessage)
            .put("unfetched", unfetched);
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        try {
            if (billingClient != null) billingClient.endConnection();
        } catch (Throwable ignored) { }
        billingClient = null;
        connected = false;
    }
}
