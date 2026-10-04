# T78：重连横幅状态机 / 判据 / 探针只读性的 JVM 行为测试（生产 ReconnectBanner，无模拟器）。
# 与 test-direct-nodes.ps1 同一套编译/运行方式：只用 android.jar 当编译期符号，
# 逻辑全在纯 Java 部分（Debouncer / isOnScreen / shouldSuppress / PROBE_JS 常量），
# 运行时不触达任何 Android stub 方法。
$ErrorActionPreference = 'Stop'
$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { "$env:LOCALAPPDATA\Android\Sdk" }
$jdk = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "$env:ProgramFiles\Android\Android Studio\jbr" }
$out = Join-Path $PSScriptRoot 'test-build/reconnect'
New-Item -ItemType Directory -Force "$out/classes" | Out-Null
$platform = Join-Path $sdk 'platforms/android-36/android.jar'
$src = Join-Path $PSScriptRoot 'app/src/main/java/top/d1studio/dshremote'
# 单一源：hook 里的 RECONNECT_STATUS_RE（断言 7 逐字符比对，上游换文案时先红）
$hook = Join-Path (Split-Path $PSScriptRoot -Parent) 'packages/gateway/assets/mobile-web.js'
Write-Host "== hook 单一源（断言 7 比对对象）：$hook"
Write-Host "== jdk：$jdk"
& "$jdk/bin/javac.exe" -encoding UTF-8 -nowarn -cp "$platform" -d "$out/classes" `
    "$src/ReconnectBanner.java" "$PSScriptRoot/tests/ReconnectBannerTest.java"
if ($LASTEXITCODE -ne 0) { throw 'JVM test compile failed' }
& "$jdk/bin/java.exe" "-Dstdout.encoding=UTF-8" "-Dstderr.encoding=UTF-8" -cp "$out/classes;$platform" top.d1studio.dshremote.ReconnectBannerTest $hook
if ($LASTEXITCODE -ne 0) { throw 'ReconnectBanner tests failed' }
