package com.pilotix.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // Android 13+ asks the person before an app may show notifications (new orders, dépôt alerts…).
    // The answer is kept by Android; after two « Don't allow » it stops asking by itself.
    private final ActivityResultLauncher<String> askNotifications = registerForActivityResult(
        new ActivityResultContracts.RequestPermission(),
        granted -> {}
    );

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        keepPagesBetweenTheBars();
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS);
        }
    }

    /**
     * The pages sit between the phone's top bar (clock, battery) and bottom bar (buttons), never under them,
     * on every page and every Android version. The bars show the navy window background with light icons.
     * When the keyboard opens, the page gets shorter so the field being typed stays visible.
     * (capacitor.config.json → SystemBars.insetsHandling = "disable", so Capacitor leaves the bars to this.)
     */
    private void keepPagesBetweenTheBars() {
        EdgeToEdge.enable(this, SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));
        View content = (View) getBridge().getWebView().getParent();
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets keyboard = insets.getInsets(WindowInsetsCompat.Type.ime());
            boolean keyboardOpen = insets.isVisible(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, keyboardOpen ? Math.max(keyboard.bottom, bars.bottom) : bars.bottom);
            // the page itself sees no bars (its safe-area values become 0), so nothing is padded twice
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(), Insets.NONE)
                .build();
        });
        ViewCompat.requestApplyInsets(content);
    }
}
