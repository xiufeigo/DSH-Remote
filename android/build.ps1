# DSH Remote Android APK 构建脚本（无 Gradle，直接编排 SDK 工具链）。
#
# 依赖：
#   - JDK 17+：缺省用 Android Studio 自带 JBR（Windows）；CI 上走 JAVA_HOME
#   - Android SDK：ANDROID_SDK_ROOT 或 %LOCALAPPDATA%\Android\Sdk
#     （需要 build-tools 35.0.0 + platforms;android-36）
# 输出：android/dist/dsh-remote.apk（已签名，可直接侧载安装）
#
# frpc 二进制：首次构建若缺少 android/jniLibs/arm64-v8a/libfrpc.so，
# 自动从 GitHub Releases 下载 frp android_arm64 版打包进 APK
# （APK 内路径 lib/arm64-v8a/libfrpc.so，安装后由系统解压到 nativeLibraryDir，
# Android 仅允许执行该目录——这也是把 frpc 改名为 lib*.so 的原因）。
#
# 签名密钥：%USERPROFILE%\.android\dsh-remote.jks（首次构建自动生成，
# PKCS12 / 口令 dsh-remote-2026。升级安装必须沿用同一密钥，请自行备份。）

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$isWin = ($env:OS -like "*NT*")
$exe = if ($isWin) { ".exe" } else { "" }

# ---- 工具链定位 ----
$Sdk = $env:ANDROID_SDK_ROOT
if (-not $Sdk) {
	if ($isWin) { $Sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk" } else { $Sdk = "/opt/android-sdk" }
}
$Bt = Join-Path $Sdk "build-tools/35.0.0"
$PlatformJar = Join-Path $Sdk "platforms/android-36/android.jar"

$JavaHome = $env:JAVA_HOME
if (-not $JavaHome) {
	if ($isWin) { $JavaHome = Join-Path $env:ProgramFiles "Android/Android Studio/jbr" }
	else { $JavaHome = "/usr/lib/jvm/default-java" }
}
$JavaHome = (Resolve-Path $JavaHome).Path
$Java = Join-Path $JavaHome "bin/java$exe"
$Javac = Join-Path $JavaHome "bin/javac$exe"
$Keytool = Join-Path $JavaHome "bin/keytool$exe"
$Jar = Join-Path $JavaHome "bin/jar$exe"

foreach ($tool in @((Join-Path $Bt "aapt2$exe"), (Join-Path $Bt "zipalign$exe"), (Join-Path $Bt "lib/d8.jar"), (Join-Path $Bt "lib/apksigner.jar"), $PlatformJar, $Java, $Javac)) {
	if (-not (Test-Path $tool)) { throw "缺少工具或平台：$tool" }
}

$AppDir = Join-Path $PSScriptRoot "app"
$OutDir = Join-Path $PSScriptRoot "build"
$DistDir = Join-Path $PSScriptRoot "dist"
Remove-Item -Recurse -Force $OutDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$OutDir/classes", "$OutDir/gen", "$OutDir/dex", "$DistDir" | Out-Null

# ---- 版本号（单一来源：仓库根 package.json；规则见 docs/versioning.md）----
# 版本号 = <deepseek-harness 基线版本>.<发版号>，如 0.1.1-rc.2.6
$PkgJson = Join-Path (Split-Path $PSScriptRoot -Parent) "package.json"
$AppVersion = (Get-Content -Raw -LiteralPath $PkgJson | ConvertFrom-Json).version
if (-not $AppVersion) { throw "无法从 $PkgJson 读取 version" }
# versionCode：把版本号的数字段逐个按百进制折叠成整数（0.1.1-rc.2.6 -> 1010206）。
# 每段占两位十进制且各数字段 <100，因此任意一段递增 ⇒ 整体递增，满足 Android 升级安装要求。
$VersionCode = 0
foreach ($seg in [regex]::Matches($AppVersion, "\d+")) { $VersionCode = $VersionCode * 100 + [int]$seg.Value }
if ($VersionCode -ge 2100000000) { throw "versionCode 溢出 int32：$VersionCode（版本号数字段过多或过大）" }
Write-Host "== 版本：$AppVersion (versionCode $VersionCode) =="

Write-Host "== aapt2 compile =="
& "$Bt/aapt2$exe" compile --dir (Join-Path $AppDir "src/main/res") -o "$OutDir/res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile 失败" }

Write-Host "== aapt2 link（同时生成 R.java）=="
& "$Bt/aapt2$exe" link -o "$OutDir/base.apk" -I $PlatformJar `
	--manifest (Join-Path $AppDir "src/main/AndroidManifest.xml") `
	--java "$OutDir/gen" `
	--min-sdk-version 24 --target-sdk-version 34 `
	--version-code $VersionCode --version-name $AppVersion `
	"$OutDir/res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 link 失败" }

Write-Host "== javac =="
$sources = @(Get-ChildItem -Recurse (Join-Path $AppDir "src/main/java") -Filter *.java | ForEach-Object { $_.FullName })
$sources += @(Get-ChildItem -Recurse "$OutDir/gen" -Filter *.java | ForEach-Object { $_.FullName })
if ($sources.Count -eq 0) { throw "未找到任何 Java 源文件" }
# PS 5.1 对原生命令的数组展开不可靠：统一走 @argfile
Set-Content -Path "$OutDir/sources.txt" -Value $sources -Encoding Ascii
# core-lambda-stubs 提供 LambdaMetafactory 编译期符号（dex 期由 d8 脱糖），AGP 同款做法
$LambdaStubs = Join-Path $Bt "core-lambda-stubs.jar"
& $Javac -encoding UTF-8 -nowarn -source 8 -target 8 `
	-bootclasspath "$PlatformJar$([System.IO.Path]::PathSeparator)$LambdaStubs" `
	-d "$OutDir/classes" "@$OutDir/sources.txt"
if ($LASTEXITCODE -ne 0) { throw "javac 失败" }

Write-Host "== d8 dex =="
$classFiles = Get-ChildItem -Recurse "$OutDir/classes" -Filter *.class |
	ForEach-Object { $_.FullName }
Set-Content -Path "$OutDir/classes.txt" -Value $classFiles -Encoding Ascii
& $Java -cp (Join-Path $Bt "lib/d8.jar") com.android.tools.r8.D8 `
	--release --lib $PlatformJar --min-api 24 --output "$OutDir/dex" "@$OutDir/classes.txt"
if ($LASTEXITCODE -ne 0) { throw "d8 失败" }

Copy-Item "$OutDir/base.apk" "$OutDir/unsigned.apk" -Force
& $Jar uf "$OutDir/unsigned.apk" -C "$OutDir/dex" classes.dex
if ($LASTEXITCODE -ne 0) { throw "打包 classes.dex 失败" }

# ---- 内嵌 frpc（访客隧道核心）----
Write-Host "== 打包 frpc（android arm64）=="
$FrpcSo = Join-Path $PSScriptRoot "jniLibs/arm64-v8a/libfrpc.so"
if (-not (Test-Path $FrpcSo)) {
	Write-Host "本地没有 libfrpc.so，自动下载 frp v0.61.1 android_arm64 …"
	New-Item -ItemType Directory -Force (Split-Path $FrpcSo -Parent) | Out-Null
	$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dshr-frp-" + [guid]::NewGuid().ToString("N"))
	New-Item -ItemType Directory -Force $Tmp | Out-Null
	$tgz = Join-Path $Tmp "frp.tgz"
	$downloaded = $false
	foreach ($u in @(
			"https://github.com/fatedier/frp/releases/download/v0.61.1/frp_0.61.1_android_arm64.tar.gz",
			"https://ghproxy.net/https://github.com/fatedier/frp/releases/download/v0.61.1/frp_0.61.1_android_arm64.tar.gz")) {
		try {
			Invoke-WebRequest -Uri $u -OutFile $tgz -UseBasicParsing
			if ((Get-Item $tgz).Length -gt 1MB) { $downloaded = $true; break }
			Write-Host "下载不完整（$((Get-Item $tgz).Length) 字节），换源重试…"
		} catch { Write-Host "下载失败：$u —— $($_.Exception.Message)" }
	}
	if (-not $downloaded) { throw "frpc android_arm64 下载失败；请手动下载并放到 $FrpcSo" }
	tar -xzf $tgz -C $Tmp
	Copy-Item (Join-Path $Tmp "frp_0.61.1_android_arm64/frpc") $FrpcSo -Force
	Remove-Item -Recurse -Force $Tmp
	Write-Host "已就位：$FrpcSo ($([math]::Round((Get-Item $FrpcSo).Length / 1MB, 1)) MB)"
}
# APK 内固定布局 lib/<abi>/lib*.so
$Stage = Join-Path $OutDir "libstage"
New-Item -ItemType Directory -Force (Join-Path $Stage "lib/arm64-v8a") | Out-Null
Copy-Item $FrpcSo (Join-Path $Stage "lib/arm64-v8a/libfrpc.so") -Force
& $Jar uf "$OutDir/unsigned.apk" -C $Stage lib
if ($LASTEXITCODE -ne 0) { throw "打包 libfrpc.so 失败" }

Write-Host "== zipalign =="
& "$Bt/zipalign$exe" -f 4 "$OutDir/unsigned.apk" "$OutDir/aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign 失败" }

Write-Host "== apksigner =="
$Keystore = if ($isWin) { Join-Path $env:USERPROFILE ".android/dsh-remote.jks" } else { Join-Path $env:HOME ".android/dsh-remote.jks" }
if (-not (Test-Path $Keystore)) {
	New-Item -ItemType Directory -Force (Split-Path $Keystore -Parent) | Out-Null
	& $Keytool -genkeypair -keystore $Keystore -storetype PKCS12 `
		-alias dshremote -keyalg RSA -keysize 2048 -validity 10950 `
		-storepass dsh-remote-2026 -dname "CN=DSH Remote"
	if ($LASTEXITCODE -ne 0) { throw "生成签名密钥失败" }
}
$Apk = Join-Path $DistDir "dsh-remote.apk"
& $Java -jar (Join-Path $Bt "lib/apksigner.jar") sign `
	--ks $Keystore --ks-pass pass:dsh-remote-2026 --out $Apk "$OutDir/aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "APK 签名失败" }

& $Java -jar (Join-Path $Bt "lib/apksigner.jar") verify $Apk
if ($LASTEXITCODE -ne 0) { throw "签名校验未通过" }

Write-Host ""
Write-Host "OK 构建完成：$Apk"
