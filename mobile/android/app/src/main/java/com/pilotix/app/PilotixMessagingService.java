package com.pilotix.app;

import androidx.annotation.NonNull;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;

/**
 * Pilotix's messages through Firebase (the server's apps/server/src/fcm.ts), even when the app is closed or the phone is
 * locked: what the browsers' worker does (apps/web/public/sw.js), done by the app.
 *  - « conf » (a new order to call): Pilotix open on the screen is told to look now (it shows the order and rings
 *    itself), with no notification on top; otherwise the notification rings (PushNotices);
 *  - « ack »: the phone says the message arrived (« Bloquer jusqu'à l'appel »: an agent's phone that does not answer is
 *    blocked until it rings again) — Pilotix's own address only, no session (the one-time code is the proof).
 * Firebase gives the app a new token now and then: the website saves it again (PilotixPushPlugin › token).
 */
public class PilotixMessagingService extends FirebaseMessagingService {

    @Override
    public void onNewToken(@NonNull String token) {
        PilotixPushPlugin.tokenChanged(getApplicationContext(), token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> d = message.getData();
        // a message without data is drawn by Firebase itself (none comes from Pilotix)
        if (d == null || d.isEmpty()) return;
        boolean conf = "1".equals(d.get("conf"));
        if (conf) PilotixPushPlugin.message(d);
        if (!(conf && PilotixPushPlugin.onScreen())) PushNotices.show(getApplicationContext(), d);
        answer(d.get("ack"));
    }

    private static void answer(String ack) {
        if (!PushNotices.ourAddress(ack)) return;
        HttpURLConnection h = null;
        try {
            h = (HttpURLConnection) new URL(ack).openConnection();
            h.setRequestMethod("POST");
            h.setConnectTimeout(8000);
            h.setReadTimeout(8000);
            h.setUseCaches(false);
            h.setDoOutput(true);
            h.setFixedLengthStreamingMode(0);
            try (OutputStream out = h.getOutputStream()) {
                out.flush();
            }
            h.getResponseCode();
        } catch (Exception e) {
            // no internet now: the server sees the phone did not answer, and rings it again
        } finally {
            if (h != null) h.disconnect();
        }
    }
}
