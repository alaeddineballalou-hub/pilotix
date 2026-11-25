package com.pilotix.app;

import android.app.KeyguardManager;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;
import java.util.HashMap;
import java.util.Map;

/**
 * The ring screen (« Bloquer jusqu'à l'appel »): when a new order rings a locked phone, it comes over the locked screen,
 * like a call, with the order's line. « Ouvrir Pilotix » unlocks the phone and opens the order's page; « Couper le son »
 * stops this ring (the notification stays; the server rings again in 2 minutes if the order still waits for the call).
 * It shows only what the notification already shows on the locked screen: Pilotix itself always asks for the unlock.
 */
public class RingActivity extends AppCompatActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_ring);
        findViewById(R.id.ring_open).setOnClickListener((v) -> open());
        findViewById(R.id.ring_quiet).setOnClickListener((v) -> quiet());
        fill();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        fill();
    }

    private void fill() {
        Intent i = getIntent();
        ((TextView) findViewById(R.id.ring_title)).setText(PushNotices.text(i.getStringExtra(PushNotices.EXTRA_TITLE), "Pilotix"));
        ((TextView) findViewById(R.id.ring_body)).setText(PushNotices.text(i.getStringExtra(PushNotices.EXTRA_BODY), ""));
    }

    /** The notification's fields again (to open its page, or to draw it without sound). */
    private Map<String, String> data() {
        Intent i = getIntent();
        Map<String, String> d = new HashMap<>();
        d.put("tag", i.getStringExtra(PushNotices.EXTRA_TAG));
        d.put("title", i.getStringExtra(PushNotices.EXTRA_TITLE));
        d.put("body", i.getStringExtra(PushNotices.EXTRA_BODY));
        d.put("url", i.getStringExtra(PushNotices.EXTRA_URL));
        d.put("order", i.getStringExtra(PushNotices.EXTRA_ORDER));
        d.put("workspace", i.getStringExtra(PushNotices.EXTRA_WORKSPACE));
        return d;
    }

    private void open() {
        Intent go = PushNotices.tapIntent(this, data());
        KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && km != null && km.isKeyguardLocked()) {
            // the phone's own unlock first (code, fingerprint…), then Pilotix on the order
            km.requestDismissKeyguard(
                this,
                new KeyguardManager.KeyguardDismissCallback() {
                    @Override
                    public void onDismissSucceeded() {
                        startActivity(go);
                        finish();
                    }
                }
            );
            return;
        }
        startActivity(go);
        finish();
    }

    private void quiet() {
        PushNotices.silence(this, data());
        finish();
    }
}
