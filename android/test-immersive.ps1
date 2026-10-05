# T94：「系统栏沉浸」源码契约的 JVM 测试（纯源码扫描，不需要模拟器/设备）。
# 只读 android/app/src/main/java/top/d1studio/dshremote/MainActivity.java，不写任何产品文件。
#
# 必须用 pwsh -File 运行（Windows PowerShell 5.1 会把 UTF-8 脚本读成 ANSI、非 ASCII 字面量会坏）。
$ErrorActionPreference = 'Stop'
$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { "$env:LOCALAPPDATA\Android\Sdk" }
$jdk = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "$env:ProgramFiles\Android\Android Studio\jbr" }
$out = Join-Path $PSScriptRoot 'test-build/t94'
New-Item -ItemType Directory -Force "$out/classes" | Out-Null
$platform = Join-Path $sdk 'platforms/android-36/android.jar'
$main = Join-Path $PSScriptRoot 'app/src/main/java/top/d1studio/dshremote/MainActivity.java'
$hook = Join-Path (Split-Path $PSScriptRoot -Parent) 'packages/gateway/assets/mobile-web.js'
if ($args.Count -ge 1 -and $args[0]) { $main = $args[0] }
if ($args.Count -ge 2 -and $args[1]) { $hook = $args[1] }

Write-Host "== T94/T115 源码契约测试：$main"
Write-Host "                       + hook：$hook"
& "$jdk/bin/javac.exe" -encoding UTF-8 -nowarn -cp "$platform" -d "$out/classes" "$PSScriptRoot/tests/T94ImmersiveTest.java"
if ($LASTEXITCODE -ne 0) { throw 'T94 test compile failed' }
& "$jdk/bin/java.exe" "-Dstdout.encoding=UTF-8" "-Dstderr.encoding=UTF-8" -cp "$out/classes;$platform" top.d1studio.dshremote.T94ImmersiveTest "$main" "$hook"
if ($LASTEXITCODE -ne 0) { throw 'T94 immersive tests failed' }
