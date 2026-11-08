package com.pilotix.app;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The app updating itself (asked by the website's lib/appUpdate): which build this is, may it install apps (Android
 * asks the person once), then download the new app from Pilotix's download page and hand it to Android, which asks
 * « Mettre à jour cette application ? ». Only Pilotix's own download page, and only an app of this same package: a page
 * can't make it install anything else. Android itself checks that the new app is signed with the same key.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    /** Pilotix's download page on GitHub (.github/workflows/mobile.yml puts each new app there). */
    private static final String RELEASES = "https://github.com/alaeddineballalou-hub/pilotix/releases/download/";

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile long loaded = 0;
    private volatile long total = -1;
    private volatile boolean downloading = false;

    /** This app's build (GitHub's build number, the version code) and its version name. */
    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        try {
            PackageInfo p = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            r.put("build", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? p.getLongVersionCode() : versionCode(p));
            r.put("version", p.versionName);
        } catch (PackageManager.NameNotFoundException e) {
            r.put("build", 0);
        }
        call.resolve(r);
    }

    @SuppressWarnings("deprecation")
    private static long versionCode(PackageInfo p) {
        return p.versionCode;
    }

    /** May this app install its update? Android asks the person once (« Autoriser cette source »). */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        r.put("allowed", Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getContext().getPackageManager().canRequestPackageInstalls());
        call.resolve(r);
    }

    /** Android's own screen where the person allows it (the page asks again when the app is back on screen). */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }

    /** How far the download is (the page's bar asks a few times a second). */
    @PluginMethod
    public void progress(PluginCall call) {
        JSObject r = new JSObject();
        r.put("loaded", loaded);
        r.put("total", total);
        r.put("downloading", downloading);
        call.resolve(r);
    }

    /** Download the new app, check it is Pilotix, then Android asks « Mettre à jour ? ». */
    @PluginMethod
    public void install(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || !url.startsWith(RELEASES)) {
            call.reject("Only Pilotix's download page");
            return;
        }
        if (downloading) {
            call.reject("Already downloading");
            return;
        }
        downloading = true;
        loaded = 0;
        total = -1;
        worker.execute(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "updates");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("No room for the update");
                File apk = new File(dir, "pilotix.apk");
                download(url, apk);
                PackageInfo p = archiveInfo(apk);
                if (p == null || !getContext().getPackageName().equals(p.packageName)) throw new IOException("Not the Pilotix app");
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Download failed" : e.getMessage());
            } finally {
                downloading = false;
            }
        });
    }

    @SuppressWarnings("deprecation")
    private PackageInfo archiveInfo(File apk) {
        return getContext().getPackageManager().getPackageArchiveInfo(apk.getPath(), 0);
    }

    /** GitHub answers the download page with a move to its file store: followed (both https). */
    private void download(String from, File to) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(from).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(15_000);
        c.setReadTimeout(30_000);
        try {
            int code = c.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) throw new IOException("HTTP " + code);
            total = c.getContentLengthLong();
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(to)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                long done = 0;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    done += n;
                    loaded = done;
                }
            }
        } finally {
            c.disconnect();
        }
    }
}
