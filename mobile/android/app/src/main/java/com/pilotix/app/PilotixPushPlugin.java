package com.pilotix.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.Map;

/**
 * The app's notifications for the website (apps/web/src/lib/push.ts): in place of the browsers' Web Push, which the app's
 * WebView does not have. The website asks here, and saves this phone on the server as « fcm:<token> ».
 *  - state: what the phone allows now (permission, notifications on, the ring's channel, the ring screen, the alarm
 *    volume) and the token already known;
 *  - enable({ ask }): asks the person (Android 13+, only from a tap: ask), then gives Firebase's token;
 *  - openSettings: the app's notification settings (to turn them back on);
 *  - events: « message » (a new order while Pilotix is on the screen: px-conf, as sw.js), « tap » (a notification was
 *    tapped: its page; kept until the page listens, for an app that was closed), « token » (Firebase gave a new one).
 */
@CapacitorPlugin(name = "PilotixPush", permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") })
public class PilotixPushPlugin extends Plugin {

    private static final String PREFS = "pilotix_push";
    private static volatile PilotixPushPlugin live;
    private static volatile boolean resumed;

    @Override
    public void load() {
        live = this;
        resumed = true;
        PushNotices.channels(getContext());
        // the app was closed and a notification opened it
        tap(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        tap(intent);
    }

    @Override
    protected void handleOnResume() {
        resumed = true;
        PushNotices.stopRinging(getContext());
    }

    @Override
    protected void handleOnPause() {
        resumed = false;
    }

    @Override
    protected void handleOnDestroy() {
        if (live == this) live = null;
        resumed = false;
    }

    /** Pilotix is open on the screen now. */
    static boolean onScreen() {
        return live != null && resumed;
    }

    /** A message for Pilotix open on the screen (« conf »: look at the new order now). */
    static void message(Map<String, String> d) {
        PilotixPushPlugin p = live;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("type", "1".equals(d.get("conf")) ? "px-conf" : "px-push");
        o.put("tag", PushNotices.text(d.get("tag"), ""));
        p.notifyListeners("message", o);
    }

    /** Firebase gave this phone a new token: kept here, and the website saves it again if it is open. */
    static void tokenChanged(Context c, String token) {
        prefs(c).edit().putString("token", token).apply();
        PilotixPushPlugin p = live;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("token", token);
        p.notifyListeners("token", o);
    }

    private void tap(Intent i) {
        if (i == null || !i.hasExtra(PushNotices.EXTRA_TAG)) return;
        JSObject o = new JSObject();
        o.put("type", "px-open");
        o.put("url", i.getStringExtra(PushNotices.EXTRA_URL));
        String order = i.getStringExtra(PushNotices.EXTRA_ORDER);
        if (order != null && order.matches("\\d{1,12}")) o.put("order", Long.parseLong(order));
        o.put("workspace", i.getStringExtra(PushNotices.EXTRA_WORKSPACE));
        o.put("tag", i.getStringExtra(PushNotices.EXTRA_TAG));
        // used once: a page reload or the app coming back does not open it again
        i.removeExtra(PushNotices.EXTRA_TAG);
        PushNotices.stopRinging(getContext());
        notifyListeners("tap", o, true);
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private String permission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "granted";
        PermissionState s = getPermissionState("notifications");
        return s == PermissionState.GRANTED ? "granted" : s == PermissionState.DENIED ? "denied" : "prompt";
    }

    private JSObject facts() {
        Context c = getContext();
        JSObject r = new JSObject();
        r.put("permission", permission());
        r.put("enabled", PushNotices.allowed(c));
        r.put("ring", PushNotices.ringChannelOk(c));
        r.put("fullScreen", PushNotices.fullScreenOk(c));
        r.put("alarmVolume", PushNotices.alarmVolume(c));
        String token = prefs(c).getString("token", null);
        if (token != null) r.put("token", token);
        return r;
    }

    @PluginMethod
    public void state(PluginCall call) {
        call.resolve(facts());
    }

    @PluginMethod
    public void enable(PluginCall call) {
        boolean ask = Boolean.TRUE.equals(call.getBoolean("ask", false));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && ask && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterAsk");
            return;
        }
        afterAsk(call);
    }

    @PermissionCallback
    private void afterAsk(PluginCall call) {
        JSObject r = facts();
        if (!PushNotices.allowed(getContext())) {
            r.put("state", "granted".equals(permission()) || "denied".equals(permission()) ? "denied" : "off");
            call.resolve(r);
            return;
        }
        try {
            FirebaseMessaging.getInstance()
                .getToken()
                .addOnCompleteListener(task -> {
                    if (!task.isSuccessful() || task.getResult() == null || task.getResult().isEmpty()) {
                        // Firebase cannot be reached now (no internet, Google Play services missing)
                        r.put("state", "off");
                        r.put("error", task.getException() != null ? String.valueOf(task.getException().getMessage()) : "no token");
                        call.resolve(r);
                        return;
                    }
                    String token = task.getResult();
                    prefs(getContext()).edit().putString("token", token).apply();
                    r.put("token", token);
                    r.put("state", "on");
                    call.resolve(r);
                });
        } catch (IllegalStateException e) {
            // an app made without google-services.json
            r.put("state", "unsupported");
            call.resolve(r);
        }
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Context c = getContext();
        Intent i;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, c.getPackageName());
        } else {
            i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + c.getPackageName()));
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getActivity().startActivity(i);
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("Réglages introuvables", "NO_SETTINGS");
        }
    }
}
