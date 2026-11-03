package com.naiwa.runner;

import android.annotation.SuppressLint;
import android.app.Activity;
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
 *   - LAYER_TYPE_HARDWARE + hardwareAccelerated：Three.js 的 WebGL 需要
 *   - setAllowFileAccessFromFileURLs：file:// 页面加载同目录的 <script>/<audio>
 *   - noCompress wav/mp3（在 build.gradle）：>1MB 的压缩 assets 在部分 WebView 里无法 seek
 */
public class MainActivity extends Activity {

    private static final String GAME_URL = "file:///android_asset/www/index.html";
    private WebView web;
    private long lastBackAt = 0L;

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
        s.setBlockNetworkLoads(true);                  // 纯离线，别偷跑流量
        s.setBlockNetworkImage(true);

        web.setWebViewClient(new WebViewClient());      // 页面内跳转留在同一个 WebView
        web.setWebChromeClient(new WebChromeClient());
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);   // WebGL 必须
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

        web.loadUrl(GAME_URL);
        hideSystemBars();
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
