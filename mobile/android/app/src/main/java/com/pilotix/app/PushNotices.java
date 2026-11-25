package com.pilotix.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.util.Arrays;
import java.util.Map;

/**
 * The app's notifications, drawn by the app itself from what the server sends (core push.ts › fcmMessage: title, body,
 * tag, url, order, workspace, alarm, conf, ring, ack). Three kinds, each a channel the person sees in the phone's
 * settings:
 *  - « Nouvelle commande à appeler » (ring: « Bloquer jusqu'à l'appel » and its test ring): Pilotix's ring, on the
 *    phone's ALARM sound — it rings even on a silent or vibrating phone, and through « Ne pas déranger » when alarms
 *    are let through (Android's default) — again and again until the person looks (or about 2 minutes: the server rings
 *    again every 2 minutes), with the ring screen over the locked screen (RingActivity);
 *  - « Alertes importantes » (alarm: an order given, a callback, a dépôt alert): Pilotix's ring once, as a notification;
 *  - « Autres notifications »: the phone's own notification sound.
 * The same tag replaces the notification before it, like the browsers' (sw.js).
 */
final class PushNotices {

    static final String CH_RING = "pilotix_ring";
    static final String CH_ALERT = "pilotix_alerts";
    static final String CH_INFO = "pilotix_info";

    /** what a tap gives the page (MainActivity → PilotixPushPlugin › tap): the same as sw.js's notificationclick */
    static final String EXTRA_URL = "px_url";
    static final String EXTRA_ORDER = "px_order";
    static final String EXTRA_WORKSPACE = "px_workspace";
    static final String EXTRA_TAG = "px_tag";
    static final String EXTRA_TITLE = "px_title";
    static final String EXTRA_BODY = "px_body";

    /** a ring lasts this long at most (the server rings again every 2 minutes while the order waits for the call) */
    static final long RING_FOR_MS = 110_000L;
    private static final long[] RING_BUZZ = { 0, 800, 200, 800, 200, 800, 200, 1200 };
    private static final long[] ALERT_BUZZ = { 0, 450, 150, 450 };
    /** the one notification id: each one is told apart by its tag */
    private static final int ID = 1;

    private PushNotices() {}

    /** Pilotix's ring, the website's « drrr-drrr » (res/raw/pilotix_ring.ogg), by name: its number changes between apps. */
    static Uri ringSound(Context c) {
        return Uri.parse("android.resource://" + c.getPackageName() + "/raw/pilotix_ring");
    }

    /** The three channels (Android 8+; made once, then the person's own settings for them win). */
    static void channels(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel ring = new NotificationChannel(CH_RING, c.getString(R.string.ch_ring), NotificationManager.IMPORTANCE_HIGH);
        ring.setDescription(c.getString(R.string.ch_ring_about));
        ring.setSound(
            ringSound(c),
            new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        );
        ring.enableVibration(true);
        ring.setVibrationPattern(RING_BUZZ);
        ring.enableLights(true);
        ring.setLightColor(0xFFF7A823);
        ring.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

        NotificationChannel alert = new NotificationChannel(CH_ALERT, c.getString(R.string.ch_alert), NotificationManager.IMPORTANCE_HIGH);
        alert.setDescription(c.getString(R.string.ch_alert_about));
        alert.setSound(
            ringSound(c),
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        );
        alert.enableVibration(true);
        alert.setVibrationPattern(ALERT_BUZZ);
        alert.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

        NotificationChannel info = new NotificationChannel(CH_INFO, c.getString(R.string.ch_info), NotificationManager.IMPORTANCE_DEFAULT);
        info.setDescription(c.getString(R.string.ch_info_about));

        nm.createNotificationChannels(Arrays.asList(ring, alert, info));
    }

    static boolean isRing(Map<String, String> d) {
        return "1".equals(d.get("ring")) || text(d.get("tag"), "").startsWith("conf-");
    }

    /** Shows one notification from the server's message. */
    static void show(Context c, Map<String, String> d) {
        if (!allowed(c)) return;
        channels(c);
        String tag = text(d.get("tag"), "pilotix");
        boolean ring = isRing(d);
        boolean alarm = ring || "1".equals(d.get("alarm"));
        String title = text(d.get("title"), "Pilotix");
        String body = text(d.get("body"), "");
        int code = tag.hashCode();

        NotificationCompat.Builder b = new NotificationCompat.Builder(c, ring ? CH_RING : alarm ? CH_ALERT : CH_INFO)
            .setSmallIcon(R.drawable.ic_stat_pilotix)
            .setColor(ContextCompat.getColor(c, R.color.pilotix_orange_deep))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(PendingIntent.getActivity(c, code, tapIntent(c, d), flags()))
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(alarm ? NotificationCompat.PRIORITY_MAX : NotificationCompat.PRIORITY_DEFAULT);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Android 7 has no channels: the sound and the buzz are the notification's own
            if (alarm) {
                b.setSound(ringSound(c), ring ? AudioManager.STREAM_ALARM : AudioManager.STREAM_NOTIFICATION);
                b.setVibrate(ring ? RING_BUZZ : ALERT_BUZZ);
            } else {
                b.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION));
            }
        }
        if (ring) {
            b.setCategory(NotificationCompat.CATEGORY_ALARM);
            b.setTimeoutAfter(RING_FOR_MS);
            // over the locked screen, the ring screen (Android lets an app installed outside the Play Store do it)
            b.setFullScreenIntent(PendingIntent.getActivity(c, code + 1, ringIntent(c, d), flags()), true);
        } else if (alarm) {
            b.setCategory(NotificationCompat.CATEGORY_REMINDER);
        }
        Notification n = b.build();
        // the ring repeats until the person looks at the phone (or Pilotix comes on the screen: stopRinging)
        if (ring) n.flags |= Notification.FLAG_INSISTENT;
        try {
            NotificationManagerCompat.from(c).notify(tag, ID, n);
        } catch (SecurityException e) {
            // notifications turned off in the meantime
        }
    }

    /** The same notification, without its sound (« Couper le son » on the ring screen): it stays in the list. */
    static void silence(Context c, Map<String, String> d) {
        if (!allowed(c)) return;
        String tag = text(d.get("tag"), "pilotix");
        String body = text(d.get("body"), "");
        Notification n = new NotificationCompat.Builder(c, CH_RING)
            .setSmallIcon(R.drawable.ic_stat_pilotix)
            .setColor(ContextCompat.getColor(c, R.color.pilotix_orange_deep))
            .setContentTitle(text(d.get("title"), "Pilotix"))
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(PendingIntent.getActivity(c, tag.hashCode(), tapIntent(c, d), flags()))
            .setAutoCancel(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .build();
        try {
            NotificationManagerCompat.from(c).notify(tag, ID, n);
        } catch (SecurityException e) {
            // notifications turned off in the meantime
        }
    }

    /** Pilotix is on the screen: it rings there itself (the order card), so the phone's ring stops. */
    static void stopRinging(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        try {
            for (StatusBarNotification s : nm.getActiveNotifications()) {
                boolean ring = s.getTag() != null && s.getTag().startsWith("conf-");
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ring = ring || CH_RING.equals(s.getNotification().getChannelId());
                if (ring) nm.cancel(s.getTag(), s.getId());
            }
        } catch (RuntimeException e) {
            // nothing to stop
        }
    }

    /** The app may show notifications (Android 13+: the person said yes; any Android: not turned off in its settings). */
    static boolean allowed(Context c) {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false;
        return NotificationManagerCompat.from(c).areNotificationsEnabled();
    }

    /** The ring's channel still rings (not turned off nor made quiet by the person in the phone's settings). */
    static boolean ringChannelOk(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return false;
        NotificationChannel ch = nm.getNotificationChannel(CH_RING);
        return ch == null || (ch.getImportance() >= NotificationManager.IMPORTANCE_HIGH && ch.getSound() != null);
    }

    /** Android lets the app show the ring screen over the locked screen (Android 14+ can take it away). */
    static boolean fullScreenOk(Context c) {
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        return nm != null && nm.canUseFullScreenIntent();
    }

    /** The alarm sound's volume now, 0 to 1 (the ring uses it). */
    static double alarmVolume(Context c) {
        AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return 1;
        int max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM);
        return max > 0 ? (double) am.getStreamVolume(AudioManager.STREAM_ALARM) / max : 1;
    }

    /** Opens Pilotix on the notification's page (MainActivity is singleTask: an open Pilotix gets it as a new intent). */
    static Intent tapIntent(Context c, Map<String, String> d) {
        Intent i = new Intent(c, MainActivity.class);
        i.setAction(Intent.ACTION_VIEW);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        put(i, d);
        return i;
    }

    static Intent ringIntent(Context c, Map<String, String> d) {
        Intent i = new Intent(c, RingActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        put(i, d);
        return i;
    }

    private static void put(Intent i, Map<String, String> d) {
        i.putExtra(EXTRA_URL, text(d.get("url"), ""));
        i.putExtra(EXTRA_ORDER, text(d.get("order"), ""));
        i.putExtra(EXTRA_WORKSPACE, text(d.get("workspace"), ""));
        i.putExtra(EXTRA_TAG, text(d.get("tag"), "pilotix"));
        i.putExtra(EXTRA_TITLE, text(d.get("title"), "Pilotix"));
        i.putExtra(EXTRA_BODY, text(d.get("body"), ""));
    }

    private static int flags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    }

    static String text(String v, String otherwise) {
        return v == null || v.isEmpty() ? otherwise : v;
    }

    /** Pilotix's own server address only (the « ack » address the ring carries): never another site. */
    static boolean ourAddress(String url) {
        if (url == null) return false;
        try {
            Uri u = Uri.parse(url);
            String host = u.getHost();
            return (
                "https".equals(u.getScheme()) &&
                host != null &&
                (host.equals("pilotix.online") || host.equals("www.pilotix.online") || host.equals("direct.pilotix.online")) &&
                u.getPath() != null &&
                u.getPath().contains("/push/ack/")
            );
        } catch (RuntimeException e) {
            return false;
        }
    }
}
