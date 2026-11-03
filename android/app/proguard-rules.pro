# 本项目没有第三方库，WebView 只加载 assets 里的本地页面。
# 保险起见保留 WebView 相关类名，避免以后加 JS 桥时被混淆掉。
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
