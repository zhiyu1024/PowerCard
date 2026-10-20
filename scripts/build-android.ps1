# =============================================================================
# 构建“远程电脑控制”Android APK（Java 原生壳 + WebViewAssetLoader + 桌面小组件）
#
# 用法（PowerShell 7 / Windows PowerShell 5.1 均可）：
#   powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1            # 单测 + debug + release
#   powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1 -Target debug
#   powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1 -Target release
#   powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1 -SkipTests
#
# 前置条件：.android-toolchain/ 下已就位 jdk / gradle-8.9 / android-sdk（见 docs/android-build.md）。
# 脚本会：同步 public/ 到 assets → 跑 Java 单元测试 → 构建 → 生成/复用 release keystore
#         → 输出 dist/ → apksigner/aapt2/unzip 校验（含小组件 receiver/meta-data/layout）。
# 不会启动模拟器或真机。
# =============================================================================
[CmdletBinding()]
param(
    [ValidateSet('all', 'debug', 'release')]
    [string]$Target = 'all',

    # 交付版本号/版本代码（与 android/app/build.gradle 保持一致）
    [string]$Version = '1.1.0',
    [int]$VersionCode = 2,

    # 跳过 APK 校验（apksigner/aapt2/unzip 检查），仅用于本地快速迭代
    [switch]$SkipChecks,

    # 跳过 Java 单元测试
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$tc = Join-Path $root '.android-toolchain'
$jdk = Join-Path $tc 'jdk'
$sdk = Join-Path $tc 'android-sdk'
$gradleBat = Join-Path $tc 'gradle-8.9\bin\gradle.bat'
$buildTools = Join-Path $sdk 'build-tools\35.0.0'
$androidDir = Join-Path $root 'android'
$distDir = Join-Path $root 'dist'
$publicDir = Join-Path $root 'public'

function Assert-Path([string]$path, [string]$hint) {
    if (-not (Test-Path $path)) {
        throw "缺少 $path。$hint"
    }
}

Assert-Path $jdk '请先把 jdk17.zip 解压到 .android-toolchain/jdk（见 docs/android-build.md）。'
Assert-Path $gradleBat '请先把 gradle-8.9-bin.zip 解压到 .android-toolchain/gradle-8.9。'
Assert-Path $sdk '请先安装 Android SDK 到 .android-toolchain/android-sdk。'
Assert-Path (Join-Path $sdk 'platforms\android-35') '缺少 platforms;android-35。'
Assert-Path (Join-Path $buildTools 'apksigner.bat') '缺少 build-tools;35.0.0。'
Assert-Path $publicDir '缺少仓库根 public/ 前端资源。'

# --- 工具链环境 ---------------------------------------------------------------
$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:GRADLE_USER_HOME = Join-Path $tc 'gradle-home'
# 本机 %USERPROFILE%\.android 不可写：把 AGP 偏好目录/debug keystore 放到工具链目录内
$env:ANDROID_USER_HOME = Join-Path $tc '.android-home'
$env:PATH = "$jdk\bin;$sdk\platform-tools;$env:PATH"
New-Item -ItemType Directory -Force -Path $env:GRADLE_USER_HOME | Out-Null
New-Item -ItemType Directory -Force -Path $env:ANDROID_USER_HOME | Out-Null
# 本机 %TEMP% 不可写（AGP mergeJavaResource 会报 AccessDeniedException）：临时目录也放到工具链内
$env:TEMP = Join-Path $tc 'tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

Write-Host "版本: $Version (versionCode $VersionCode)"
Write-Host "工具链: JDK=$jdk"
Write-Host "        Gradle=$gradleBat"
Write-Host "        SDK=$sdk (platform 35 / build-tools 35.0.0)"

# --- release keystore ---------------------------------------------------------
# 密钥与口令保存在 android/keystore/（已被 android/.gitignore 忽略，绝不提交）。
# 口令随机生成，只写到 keystore.properties；文档中不出现任何口令。
function Ensure-ReleaseKeystore {
    $keystoreDir = Join-Path $androidDir 'keystore'
    $keystoreFile = Join-Path $keystoreDir 'powercard-release.jks'
    $propsFile = Join-Path $keystoreDir 'keystore.properties'
    New-Item -ItemType Directory -Force -Path $keystoreDir | Out-Null

    if ((Test-Path $keystoreFile) -and (Test-Path $propsFile)) {
        Write-Host "复用已存在的 release keystore: android/keystore/powercard-release.jks"
        return
    }

    $storePassword = if ($env:POWERCARD_STORE_PASSWORD) {
        $env:POWERCARD_STORE_PASSWORD
    } else {
        ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')).Substring(0, 32)
    }
    $keyPassword = if ($env:POWERCARD_KEY_PASSWORD) { $env:POWERCARD_KEY_PASSWORD } else { $storePassword }

    Write-Host '生成 release keystore（口令随机，写入 android/keystore/keystore.properties，不提交）...'
    & (Join-Path $jdk 'bin\keytool.exe') -genkeypair -v `
        -keystore $keystoreFile `
        -alias powercard `
        -keyalg RSA -keysize 2048 -validity 10000 `
        -storetype PKCS12 `
        -storepass $storePassword -keypass $keyPassword `
        -dname 'CN=PowerCard Remote, OU=PowerCard, O=PowerCard, L=Local, ST=Local, C=CN' | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $keystoreFile)) {
        throw 'keytool 生成 release keystore 失败'
    }

    $props = @"
# 本文件包含签名口令，已被 android/.gitignore 忽略，请勿提交或分享。
storeFile=keystore/powercard-release.jks
storePassword=$storePassword
keyAlias=powercard
keyPassword=$keyPassword
"@
    Set-Content -Path $propsFile -Value $props -Encoding ASCII
    Write-Host 'keystore 生成完成（口令仅保存在 android/keystore/keystore.properties）'
}

# --- Gradle -------------------------------------------------------------------
function Invoke-Gradle([string[]]$tasks) {
    Push-Location $androidDir
    try {
        Write-Host ("运行: gradle " + ($tasks -join ' '))
        & cmd.exe /c "`"$gradleBat`" $($tasks -join ' ') --no-daemon --console=plain"
        if ($LASTEXITCODE -ne 0) {
            throw ("Gradle 构建失败（exit $LASTEXITCODE）: " + ($tasks -join ' '))
        }
    } finally {
        Pop-Location
    }
}

# --- Java 单元测试 ------------------------------------------------------------
function Invoke-JavaUnitTests {
    Invoke-Gradle @('testDebugUnitTest')
    $resultsDir = Join-Path $androidDir 'app\build\test-results\testDebugUnitTest'
    if (-not (Test-Path $resultsDir)) {
        throw '未找到 Java 单元测试结果目录 app/build/test-results/testDebugUnitTest'
    }
    $total = 0; $failures = 0; $errors = 0; $skipped = 0
    foreach ($xmlFile in Get-ChildItem $resultsDir -Filter '*.xml') {
        [xml]$document = Get-Content $xmlFile.FullName
        $suite = $document.testsuite
        $total += [int]$suite.tests
        $failures += [int]$suite.failures
        $errors += [int]$suite.errors
        $skipped += [int]$suite.skipped
        Write-Host ("  {0}: tests={1} failures={2} errors={3}" -f $suite.name, $suite.tests, $suite.failures, $suite.errors)
    }
    Write-Host ("Java 单元测试合计: {0} 个，失败 {1}，错误 {2}，跳过 {3}" -f $total, $failures, $errors, $skipped)
    if ($total -le 0) {
        throw 'Java 单元测试数量为 0'
    }
    if ($failures -gt 0 -or $errors -gt 0) {
        throw 'Java 单元测试未全部通过'
    }
}

# --- APK 校验 -----------------------------------------------------------------
function Get-Sha256([string]$file) {
    return (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLowerInvariant()
}

function Test-Apk([string]$apk, [string]$kind) {
    Write-Host "--- 校验 $kind APK：$apk ---"
    $apksigner = Join-Path $buildTools 'apksigner.bat'
    $aapt2 = Join-Path $buildTools 'aapt2.exe'

    & cmd.exe /c "`"$apksigner`" verify --verbose --print-certs `"$apk`""
    if ($LASTEXITCODE -ne 0) {
        throw "apksigner verify 失败（$kind）"
    }

    $badging = & cmd.exe /c "`"$aapt2`" dump badging `"$apk`""
    $badging | Select-String -Pattern 'package:|sdkVersion|targetSdkVersion|uses-permission|application-label|application-debuggable'
    # 注意：PowerShell 里对数组使用 -notmatch 会返回“不匹配的元素”而不是布尔值，先合并为单字符串
    $badgingText = ($badging | Out-String)
    if ($badgingText -notmatch "package: name='com\.powercard\.remote' versionCode='$VersionCode' versionName='$([regex]::Escape($Version))'") {
        throw "aapt2 badging 包名/版本不是 com.powercard.remote versionCode=$VersionCode versionName=$Version（$kind）"
    }
    if ($badgingText -notmatch "sdkVersion:'26'") {
        throw "aapt2 badging minSdk 不是 26（$kind）"
    }
    if ($badgingText -notmatch "targetSdkVersion:'35'") {
        throw "aapt2 badging targetSdk 不是 35（$kind）"
    }
    if ($badgingText -notmatch 'android\.permission\.INTERNET') {
        throw "aapt2 badging 缺少 INTERNET 权限（$kind）"
    }
    if ($kind -eq 'release' -and ($badgingText -match 'application-debuggable')) {
        throw 'release APK 不允许 application-debuggable'
    }

    Write-Host '--- Manifest / 桌面小组件检查 ---'
    $tree = ((& cmd.exe /c "`"$aapt2`" dump xmltree --file AndroidManifest.xml `"$apk`"") | Out-String)
    if ($tree -notmatch 'allowBackup\(0x01010280\)=false') {
        throw "AndroidManifest allowBackup 不是 false（$kind）"
    }
    if ($tree -notmatch 'usesCleartextTraffic\(0x010104ec\)=true') {
        throw "AndroidManifest usesCleartextTraffic 不是 true（$kind）"
    }
    if ($tree -notmatch 'com\.powercard\.remote\.PowerCardWidgetProvider') {
        throw "AndroidManifest 缺少 PowerCardWidgetProvider receiver（$kind）"
    }
    if ($tree -notmatch 'android\.appwidget\.provider') {
        throw "AndroidManifest 缺少 meta-data android.appwidget.provider（$kind）"
    }
    if ($tree -notmatch 'android\.appwidget\.action\.APPWIDGET_UPDATE') {
        throw "AndroidManifest 缺少 APPWIDGET_UPDATE intent-filter（$kind）"
    }
    if ($tree -notmatch 'E: receiver[\s\S]{0,2000}?com\.powercard\.remote\.PowerCardWidgetProvider[\s\S]{0,2000}?exported\(0x01010010\)=false') {
        throw "小组件 receiver 必须 exported=false（$kind）"
    }
    Write-Host '  ok  receiver / meta-data / APPWIDGET_UPDATE / exported=false'

    Write-Host '--- 小组件资源检查 ---'
    $resources = ((& cmd.exe /c "`"$aapt2`" dump resources `"$apk`"") | Out-String)
    $widgetResources = @(
        'layout/widget_powercard_4x2',
        'layout/widget_powercard_2x2',
        'layout/widget_powercard_4x2_confirm',
        'layout/widget_powercard_2x2_confirm',
        'xml/widget_info',
        'string/widget_label',
        'string/widget_unconfigured_full'
    )
    foreach ($name in $widgetResources) {
        if ($resources -notmatch [regex]::Escape($name)) {
            throw "APK 缺少小组件资源 $name（$kind）"
        }
    }
    Write-Host '  ok  4x2 / 2x2 / confirm layouts + widget_info + strings'

    Write-Host '--- APK 内容检查（assets / dex / manifest）---'
    $entries = & cmd.exe /c "tar.exe -tf `"$apk`""
    $required = @(
        'assets/public/index.html',
        'assets/public/app.js',
        'assets/public/styles.css',
        'assets/public/native-bridge.js',
        'assets/public/shared/native-api.js',
        'assets/public/shared/parser.js',
        'classes.dex',
        'AndroidManifest.xml'
    )
    foreach ($entry in $required) {
        $found = $entries | Where-Object { $_ -eq $entry }
        if (-not $found) {
            throw "APK 中缺少 $entry（$kind）"
        }
        Write-Host "  ok  $entry"
    }
    $overview = $entries | Where-Object { $_ -match '^(classes\d*\.dex|AndroidManifest\.xml|assets/public/index\.html)$' }
    Write-Host ("  条目统计: " + ($entries | Measure-Object).Count + " 个；关键条目: " + ($overview -join ', '))

    Write-Host '--- assets/public 与仓库 public 一致性 ---'
    Test-AssetsMatchPublic $apk
}

function Test-AssetsMatchPublic([string]$apk) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    $publicFiles = Get-ChildItem -Recurse -File $publicDir
    $zip = [System.IO.Compression.ZipFile]::OpenRead($apk)
    try {
        $assetEntries = @($zip.Entries | Where-Object { $_.FullName.StartsWith('assets/public/') })
        if ($assetEntries.Count -ne $publicFiles.Count) {
            throw ("APK assets/public 条目数 " + $assetEntries.Count + " 与仓库 public 文件数 " + $publicFiles.Count + " 不一致")
        }
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            foreach ($file in $publicFiles) {
                $relative = $file.FullName.Substring($publicDir.Length + 1).Replace('\', '/')
                $entry = $zip.GetEntry("assets/public/$relative")
                if ($null -eq $entry) {
                    throw "APK 缺少 assets/public/$relative"
                }
                $stream = $entry.Open()
                try {
                    $hash = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
                } finally {
                    $stream.Dispose()
                }
                $localHash = (Get-FileHash -Algorithm SHA256 -Path $file.FullName).Hash.ToLowerInvariant()
                if ($hash -ne $localHash) {
                    throw "assets/public/$relative 与仓库 public 不一致"
                }
            }
        } finally {
            $sha256.Dispose()
        }
        Write-Host ("  ok  assets/public 与仓库 public 完全一致（" + $publicFiles.Count + " 个文件）")
    } finally {
        $zip.Dispose()
    }
}

# --- 主流程 -------------------------------------------------------------------
if ($Target -eq 'all' -or $Target -eq 'release') {
    Ensure-ReleaseKeystore
}

if (-not $SkipTests) {
    Write-Host ''
    Write-Host '=== Java 单元测试（小组件状态解析器）==='
    Invoke-JavaUnitTests
}

if ($Target -eq 'all' -or $Target -eq 'debug') {
    Invoke-Gradle @('assembleDebug')
    $debugApk = Join-Path $androidDir 'app\build\outputs\apk\debug\app-debug.apk'
    Assert-Path $debugApk 'Gradle 未产出 debug APK'
    $debugName = "PowerCard-v$Version-debug.apk"
    $distDebug = Join-Path $distDir $debugName
    Copy-Item -Force $debugApk $distDebug
    if (-not $SkipChecks) { Test-Apk $distDebug 'debug' }
    Write-Host ("debug APK: dist\$debugName  SHA256=" + (Get-Sha256 $distDebug))
}

if ($Target -eq 'all' -or $Target -eq 'release') {
    Invoke-Gradle @('assembleRelease')
    $releaseApk = Join-Path $androidDir 'app\build\outputs\apk\release\app-release.apk'
    Assert-Path $releaseApk 'Gradle 未产出 release APK'

    $releaseName = "PowerCard-v$Version.apk"
    $distRelease = Join-Path $distDir $releaseName
    Copy-Item -Force $releaseApk $distRelease

    $hash = Get-Sha256 $distRelease
    $shaFile = "$distRelease.sha256"
    Set-Content -Path $shaFile -Value ("$hash  $releaseName") -Encoding ASCII
    Write-Host ("release APK: dist\$releaseName  SHA256=" + $hash)
    Write-Host "SHA256 文件: dist\$releaseName.sha256"

    if (-not $SkipChecks) { Test-Apk $distRelease 'release' }
}

Write-Host ''
Write-Host '完成。产物位于 dist/：'
Get-ChildItem $distDir | Sort-Object Name | Select-Object Name, Length
