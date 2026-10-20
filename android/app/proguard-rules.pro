# 当前工程不做代码混淆/压缩（纯 Java 壳，体积主要来自 WebView 资源与 AndroidX）。
# 如需开启 R8，请注意保留 @JavascriptInterface 注解方法（WebView 注入对象 PowerCardNative）。
-keepclassmembers class com.powercard.remote.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
