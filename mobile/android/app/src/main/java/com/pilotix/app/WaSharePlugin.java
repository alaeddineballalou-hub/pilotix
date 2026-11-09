package com.pilotix.app;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
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
import java.net.MalformedURLException;
import java.net.URL;
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * « Envoyer des photos » (website: pages/confirmation/SendPhotos, lib/waShare): the agent's own WhatsApp, from the
 * app. A link can carry text only, so the app hands WhatsApp the photos itself: it downloads them from Pilotix (only
 * its own photo copies, /lp/dp/), then gives them to WhatsApp in the customer's chat (WhatsApp's « jid »: straight in
 * when the agent already has a chat with that number, which the message sent first makes; otherwise WhatsApp shows
 * its list of chats). Also opens the customer's chat with the message, in the same WhatsApp (normal or Business).
 */
@CapacitorPlugin(name = "WaShare")
public class WaSharePlugin extends Plugin {

    /** WhatsApp, then WhatsApp Business (AndroidManifest.xml lets the app see whether they are installed) */
    private static final String[] APPS = { "com.whatsapp", "com.whatsapp.w4b" };
    /** WhatsApp takes 30 photos at once; a photo copy is far smaller than this */
    private static final int MAX_PHOTOS = 30;
    private static final long MAX_BYTES = 12L * 1024 * 1024;
    /** Pilotix's own addresses (mobile/capacitor.config.json: the app opens these only) */
    private static final String[] HOSTS = { "pilotix.online", "direct.pilotix.online" };

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean busy = false;

    /** Which WhatsApp apps are on this phone: ["com.whatsapp", "com.whatsapp.w4b"] (the page asks which one, when both). */
    @PluginMethod
    public void apps(PluginCall call) {
        JSArray list = new JSArray();
        for (String p : APPS) if (installed(p)) list.put(p);
        JSObject r = new JSObject();
        r.put("apps", list);
        call.resolve(r);
    }

    /** The customer's chat with the message written, in the WhatsApp asked (it sends the message: the chat exists then). */
    @PluginMethod
    public void chat(PluginCall call) {
        String phone = digits(call.getString("phone"));
        if (phone == null) {
            call.reject("Numéro invalide", "BAD_INPUT");
            return;
        }
        String text = call.getString("text", "");
        String pkg = pick(call.getString("app"));
        String q = "phone=" + phone + "&text=" + Uri.encode(text == null ? "" : text);
        Intent scheme = new Intent(Intent.ACTION_VIEW, Uri.parse("whatsapp://send?" + q));
        Intent link = new Intent(Intent.ACTION_VIEW, Uri.parse("https://api.whatsapp.com/send?" + q));
        if (pkg != null) {
            scheme.setPackage(pkg);
            link.setPackage(pkg);
        }
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().startActivity(scheme);
                call.resolve();
            } catch (ActivityNotFoundException e) {
                try {
                    getActivity().startActivity(link);
                    call.resolve();
                } catch (ActivityNotFoundException e2) {
                    call.reject("WhatsApp n'est pas installé", "NO_WHATSAPP");
                }
            }
        });
    }

    /** The photos into the customer's chat: downloaded from Pilotix, then given to WhatsApp (an optional caption: text). */
    @PluginMethod
    public void photos(PluginCall call) {
        String phone = digits(call.getString("phone"));
        JSArray photos = call.getArray("photos");
        String text = call.getString("text", "");
        String pkg = pick(call.getString("app"));
        if (phone == null || photos == null || photos.length() == 0 || photos.length() > MAX_PHOTOS) {
            call.reject("Photos ou numéro invalides", "BAD_INPUT");
            return;
        }
        if (pkg == null) {
            call.reject("WhatsApp n'est pas installé", "NO_WHATSAPP");
            return;
        }
        ArrayList<String> urls = new ArrayList<>();
        for (int k = 0; k < photos.length(); k++) {
            String u = photos.optString(k, "");
            if (!allowed(u)) {
                call.reject("Seulement les photos de Pilotix", "BAD_INPUT");
                return;
            }
            urls.add(u);
        }
        if (busy) {
            call.reject("Déjà en cours", "BUSY");
            return;
        }
        busy = true;
        worker.execute(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "wa");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Pas de place pour les photos");
                // the last send's photos: WhatsApp took them already
                File[] old = dir.listFiles();
                if (old != null) {
                    for (File f : old) {
                        //noinspection ResultOfMethodCallIgnored
                        f.delete();
                    }
                }
                String stamp = Long.toString(System.currentTimeMillis(), 36);
                ArrayList<Uri> uris = new ArrayList<>();
                boolean allJpeg = true;
                for (int k = 0; k < urls.size(); k++) {
                    File f = new File(dir, "p" + stamp + "-" + (k + 1) + ".jpg");
                    String type = download(urls.get(k), f);
                    if (!"image/jpeg".equals(type)) allJpeg = false;
                    uris.add(FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f));
                }
                Intent it = new Intent(uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE);
                it.setType(allJpeg ? "image/jpeg" : "image/*");
                if (uris.size() == 1) it.putExtra(Intent.EXTRA_STREAM, uris.get(0));
                else it.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
                if (text != null && !text.isEmpty()) it.putExtra(Intent.EXTRA_TEXT, text);
                // WhatsApp's own extra: the chat of this number
                it.putExtra("jid", phone + "@s.whatsapp.net");
                it.setPackage(pkg);
                // WhatsApp may read every photo
                ClipData clip = ClipData.newRawUri("photos", uris.get(0));
                for (int k = 1; k < uris.size(); k++) clip.addItem(new ClipData.Item(uris.get(k)));
                it.setClipData(clip);
                it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().runOnUiThread(() -> {
                    try {
                        getActivity().startActivity(it);
                        JSObject r = new JSObject();
                        r.put("sent", uris.size());
                        call.resolve(r);
                    } catch (ActivityNotFoundException e) {
                        call.reject("WhatsApp n'est pas installé", "NO_WHATSAPP");
                    } finally {
                        busy = false;
                    }
                });
            } catch (Exception e) {
                busy = false;
                call.reject(e.getMessage() == null ? "Les photos n'ont pas pu être téléchargées" : e.getMessage(), "DOWNLOAD");
            }
        });
    }

    @SuppressWarnings("deprecation")
    private boolean installed(String p) {
        try {
            getContext().getPackageManager().getPackageInfo(p, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    /** the WhatsApp asked when it is installed, else the first installed (null: none) */
    private String pick(String asked) {
        if (asked != null) for (String p : APPS) if (p.equals(asked) && installed(p)) return p;
        for (String p : APPS) if (installed(p)) return p;
        return null;
    }

    /** an international number, digits only (213…): 8 to 15 digits */
    private static String digits(String s) {
        if (s == null) return null;
        String d = s.replaceAll("[^0-9]", "");
        return d.length() >= 8 && d.length() <= 15 ? d : null;
    }

    /** only Pilotix's own photo copies: https, its address, /lp/dp/ */
    private static boolean allowed(String u) {
        try {
            URL url = new URL(u);
            if (!"https".equals(url.getProtocol())) return false;
            String h = url.getHost().toLowerCase(Locale.ROOT);
            boolean ours = false;
            for (String x : HOSTS) if (x.equals(h)) ours = true;
            return ours && url.getPath().startsWith("/api/") && url.getPath().contains("/lp/dp/");
        } catch (MalformedURLException e) {
            return false;
        }
    }

    /** one photo to a file (an image only, not too big); returns its type */
    private String download(String from, File to) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(from).openConnection();
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(15_000);
        c.setReadTimeout(30_000);
        c.setRequestProperty("User-Agent", "PilotixApp");
        try {
            int code = c.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) throw new IOException("Photo introuvable (HTTP " + code + ")");
            String type = c.getContentType() == null ? "" : c.getContentType().split(";")[0].trim().toLowerCase(Locale.ROOT);
            if (!type.startsWith("image/")) throw new IOException("Ce n'est pas une photo");
            if (c.getContentLengthLong() > MAX_BYTES) throw new IOException("Photo trop grande");
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(to)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                long done = 0;
                while ((n = in.read(buf)) > 0) {
                    done += n;
                    if (done > MAX_BYTES) throw new IOException("Photo trop grande");
                    out.write(buf, 0, n);
                }
            }
            return type;
        } finally {
            c.disconnect();
        }
    }
}
