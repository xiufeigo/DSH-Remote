# 返回键的源码契约测试（臂①，纯源码扫描；文件与臂名沿用 T99）
#   + 探针在极简 DOM 桩上真跑的行为臂（臂②，需要 node）。
# 判据在 T102 之后钉的是**新语义**：先关官方弹层/右栏 → 没有可关的 ⇒ 退到后台（不再进设置页）。
# 只读 android/app/src/main/java/top/d1studio/dshremote/MainActivity.java，不写任何产品文件。
#
# 必须用 pwsh -File 运行（Windows PowerShell 5.1 会把 UTF-8 脚本读成 ANSI、非 ASCII 字面量会坏）。
$ErrorActionPreference = 'Stop'
$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { "$env:LOCALAPPDATA\Android\Sdk" }
$jdk = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "$env:ProgramFiles\Android\Android Studio\jbr" }
$out = Join-Path $PSScriptRoot 'test-build/t99'
New-Item -ItemType Directory -Force "$out/classes" | Out-Null
$platform = Join-Path $sdk 'platforms/android-36/android.jar'
$main = Join-Path $PSScriptRoot 'app/src/main/java/top/d1studio/dshremote/MainActivity.java'
if ($args.Count -ge 1 -and $args[0]) { $main = $args[0] }

Write-Host "== T99 源码契约测试：$main"
& "$jdk/bin/javac.exe" -encoding UTF-8 -nowarn -cp "$platform" -d "$out/classes" "$PSScriptRoot/tests/T99BackKeyTest.java"
if ($LASTEXITCODE -ne 0) { throw 'T99 test compile failed' }
& "$jdk/bin/java.exe" "-Dstdout.encoding=UTF-8" "-Dstderr.encoding=UTF-8" -cp "$out/classes;$platform" top.d1studio.dshremote.T99BackKeyTest "$main"
if ($LASTEXITCODE -ne 0) { throw 'T99 back-key source contract failed' }

# ── 臂②：真实探针字面量的 DOM 桩行为臂 ───────────────────────────────────
$node = (Get-Command node -ErrorAction SilentlyContinue)
if ($null -eq $node) {
	Write-Host 'T99 臂②跳过了：未找到 node'
	exit 0
}
Write-Host "== T99 探针 DOM 桩行为臂（node）=="
& node (Join-Path $PSScriptRoot 'tests/t99-probe-dom-stub.mjs') $main
if ($LASTEXITCODE -ne 0) { throw 'T99 probe DOM-stub failed' }
