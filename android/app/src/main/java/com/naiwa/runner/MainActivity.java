package com.naiwa.runner;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * 奶蛙快跑 —— 全屏 WebView 壳。
 *
 * 游戏是纯前端（Three.js + 内嵌 base64 的 GLB + 本地 wav/mp3），不需要任何
 * 服务端、网络权限或第三方 SDK，所以直接把 assets/www 整个塞进 APK 用 file:// 打开。
 *
 * 几个不做就会「装得上但玩不了」的设置：
 *   - setMediaPlaybackRequiresUserGesture(false)：否则 BGM 和大笑会被自动播放策略拦掉
 *   - **不要**给 WebView setLayerType(LAYER_TYPE_HARDWARE)：WebGL 的画布本来就由
 *     Chromium 在 GPU 上合成，app 层再套一层硬件缓存会把 canvas 内容变成纯黑
 *     （v1.1 机型上「角色和障碍全黑」就是这个引起的）
 *   - setAllowFileAccessFromFileURLs：file:// 页面加载同目录的 <script>/<audio>
 *   - noCompress wav/mp3（在 build.gradle）：>1MB 的压缩 assets 在部分 WebView 里无法 seek
 *
 * ---- 开发模式 ----
 * 调玩法时改一行 JS 就要重新出包（5 MB）再传到手机，很烦。所以留了一个口子：
 *
 *   adb shell am start -n com.naiwa.runner/.MainActivity \
 *       -e dev_url "http://127.0.0.1:8000/index.html"
 *
 * 带上 dev_url 就加载电脑上的页面（配合 tools/dev_server.py 的 adb reverse），
 * 手机屏幕上多一个 DEV 角标，点一下就是刷新。不带 extra 直接点桌面图标启动，
 * 永远是离线的 assets 版本 —— 也就是说「是否开发模式」完全由启动方决定，
 * 装给别人的包里这条路径永远走不到。
 */
public class MainActivity extends Activity {

    private static final String GAME_URL = "file:///android_asset/www/index.html";

    /** 只写 -e dev 1 时用这个默认地址（配合 dev_server.py 起的 8000 端口） */
    private static final String DEV_DEFAULT_URL = "http://127.0.0.1:8000/index.html";

    private WebView web;
    private long lastBackAt = 0L;
    private boolean devMode = false;

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 跑酷是三道竖屏追逐视角，锁死竖屏（Manifest 里也声明了一份）
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // 刘海 / 挖孔屏：让画面延伸到顶部，页面用 viewport-fit=cover + safe-area-inset 避让
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }

        web = new WebView(this);
        web.setId(View.generateViewId());
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                  // 最高分存在 localStorage
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);        // file:// 页面读同目录资源
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false);  // BGM / 大笑自动播放，不等点击
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);      // 改了资源重新装包立刻生效

        // 关掉系统的「强制深色」：Android 10+ 在深色模式下会把 WebView 内容整体压暗，
        // 浅色画面（这游戏是奶油色系）会被压成脏灰甚至发黑。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try { s.setForceDark(WebSettings.FORCE_DARK_OFF); } catch (Throwable ignored) { }
        }
        if (Build.VERSION.SDK_INT >= 33) {
            try { s.setAlgorithmicDarkeningAllowed(false); } catch (Throwable ignored) { }
        }

        web.setWebChromeClient(new WebChromeClient());
        // 关键：这里绝对不能 setLayerType(LAYER_TYPE_HARDWARE)。
        // WebGL canvas 自己有 GPU 合成路径，再套一层硬件缓存会让画面变纯黑
        // （表现为角色、障碍、地面全黑，只有 DOM 化的 HUD 正常）。
        // 保持 LAYER_TYPE_NONE，由系统自动分配。
        web.setLayerType(View.LAYER_TYPE_NONE, null);
        web.setBackgroundColor(0xFFFFF8EC);             // 与页面奶油底色一致，加载时不闪白
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);  // 不出现边缘回弹
        web.setHorizontalScrollBarEnabled(false);
        web.setVerticalScrollBarEnabled(false);
        web.setLongClickable(false);                   // 长按不弹「复制/选择」菜单
        web.setOnLongClickListener(new View.OnLongClickListener() {
            @Override public boolean onLongClick(View v) { return true; }
        });
        web.setHapticFeedbackEnabled(false);
        WebView.setWebContentsDebuggingEnabled(true);    // 连电脑可 chrome://inspect；上架前可关

        // 每页加载完都挂一次 DEV 角标（只在开发模式下真的挂）
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                if (devMode) injectDevBadge();
            }
        });

        open(resolveDevUrl(getIntent()));
        hideSystemBars();
    }

    /**
     * 从 intent 里解析开发模式地址；返回 null 表示走离线的 assets 版本。
     * 支持两种写法：-e dev_url "http://..."（任意地址）或 -e dev 1（默认 8000 端口）。
     */
    private String resolveDevUrl(Intent it) {
        if (it == null) return null;
        String url = it.getStringExtra("dev_url");
        if (url != null) {
            url = url.trim();
            if (url.length() > 0) {
                // 只写了 IP:端口 时补上协议和路径，省得手打
                if (url.indexOf("://") < 0) url = "http://" + url;
                return url;
            }
        }
        String flag = it.getStringExtra("dev");
        if (flag != null && (flag.equals("1") || flag.equalsIgnoreCase("true"))) {
            return DEV_DEFAULT_URL;
        }
        return null;
    }

    /** 切换网络策略并加载目标页；devUrl 为 null 时回到离线 assets */
    private void open(String devUrl) {
        devMode = devUrl != null;
        WebSettings s = web.getSettings();

        if (devMode) {
            // 开发模式下必须放行网络，否则 adb reverse 过来的请求会被当成越权拦掉
            s.setBlockNetworkLoads(false);
            s.setBlockNetworkImage(false);
            Toast.makeText(this, "开发模式：" + devUrl + "\n改完代码刷新即可，点右下角 DEV",
                    Toast.LENGTH_LONG).show();
            // 每次重开都换一个查询串：同一个 URL 连续 loadUrl 时 WebView 有可能
            // 认为「没变化」而不真的重新请求，改完 JS 就看不到效果。
            web.loadUrl(cacheBust(devUrl));
        } else {
            // 正式玩法：彻底断网，连 DNS 都发不出去
            s.setBlockNetworkLoads(true);
            s.setBlockNetworkImage(true);
            web.loadUrl(GAME_URL);
        }
    }

    /** 在 #hash 之前插一个时间戳参数，强制走一次新的请求 */
    private static String cacheBust(String url) {
        int hash = url.indexOf('#');
        String head = hash >= 0 ? url.substring(0, hash) : url;
        String tail = hash >= 0 ? url.substring(hash) : "";
        return head + (head.indexOf('?') >= 0 ? "&" : "?") + "_t=" + System.currentTimeMillis() + tail;
    }

    /** 开发模式角标：半透明小胶囊，点一下 location.reload() */
    private void injectDevBadge() {
        String js = "(function(){"
                + "if(document.getElementById('__devbar'))return;"
                + "var d=document.createElement('div');"
                + "d.id='__devbar';d.textContent='DEV ↻';"
                + "d.style.cssText='position:fixed;right:10px;bottom:12px;z-index:2147483647;"
                + "padding:7px 11px;border-radius:14px;background:rgba(0,0,0,.42);"
                + "color:#8f8;font:600 12px/1 monospace;letter-spacing:.5px;"
                + "pointer-events:auto;-webkit-user-select:none;';"
                + "d.addEventListener('click',function(e){e.stopPropagation();location.reload();});"
                + "document.body.appendChild(d);})();";
        try {
            web.evaluateJavascript(js, null);
        } catch (Throwable ignored) {
        }
    }

    /** 沉浸式全屏：隐藏状态栏和导航栏，手势划出后会自动缩回（STICKY） */
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    /**
     * singleTask + 已在运行时，用 am start 再拉一次会走这里而不是新建 Activity。
     * 所以「开发模式 ↔ 正式模式」的切换、以及改完地址重进，都靠这个口子。
     * 关键点：每次都按新 intent 重新判定，不带 extra 就等于要求切回离线版
     * （点桌面图标启动正好就是这个场景）。
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String url = resolveDevUrl(intent);
        if (url != null || devMode) open(url);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) {
            web.onPause();
            // 切后台把 BGM 停掉；游戏里的 visibilitychange 也会兜一次，这里双保险
            music("window.NaiWa && window.NaiWa.audio && window.NaiWa.audio.pauseMusic()");
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
            // resumeMusic 内部看 bgmWanted：只有「本来就在跑」才恢复，
            // 结算画面切一下标签页回来不会自己响起来
            music("window.NaiWa && window.NaiWa.audio && window.NaiWa.audio.resumeMusic()");
        }
        hideSystemBars();
    }

    private void music(String js) {
        try {
            web.evaluateJavascript(js, null);
        } catch (Throwable ignored) {
            // 页面还没加载完时 NaiWa 不存在，短路表达式已经处理了，这里只防极端情况
        }
    }

    /** 双击返回键退出，避免游戏中手滑一按就退出 */
    @Override
    public void onBackPressed() {
        long now = System.currentTimeMillis();
        if (now - lastBackAt < 2000) {
            finish();
            return;
        }
        lastBackAt = now;
        Toast.makeText(this, "再按一次返回键退出", Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            try {
                web.loadUrl("about:blank");
                web.destroy();
            } catch (Throwable ignored) {
            }
            web = null;
        }
        super.onDestroy();
    }
}
