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
# 签名密钥（AND-05 / CI-01 合约）：
#   - 开发构建（默认）：%USERPROFILE%\.android\dsh-remote.jks 首次构建自动生成
#     （PKCS12），口令随机生成并写入同目录 dsh-remote.pass（不再硬编码固定口令）。
#     升级安装必须沿用同一密钥与口令文件，请一并备份。
#   - 发布构建（环境变量 DSH_RELEASE=1）：要求 ~/.android/dsh-remote.jks 已就位，
#     口令来自 DSH_KEYSTORE_PASS / DSH_KEY_PASS（可选 DSH_KEY_ALIAS 指定别名）；
#     缺 keystore 或口令立即报错退出，绝不回落生成临时密钥。
#     CI 侧由 .github/workflows/release.yml 解码 GitHub secret 写入上述文件并设环境变量。

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
$Pkg = Get-Content -Raw -LiteralPath $PkgJson | ConvertFrom-Json
$AppVersion = $Pkg.version
if (-not $AppVersion) { throw "无法从 $PkgJson 读取 version" }

# ---- frp 版本（单一来源：根 package.json 的 config.frpVersion，OPS-05）----
# 读取失败（字段尚未添加等）回落硬编码版本并告警，不阻断构建。
$FrpVersion = ""
try { $FrpVersion = [string]$Pkg.config.frpVersion } catch { $FrpVersion = "" }
if (-not $FrpVersion) {
	$FrpVersion = "0.61.1"
	Write-Host "警告：未从根 package.json 读到 config.frpVersion，回落硬编码版本 $FrpVersion"
}
# versionCode：把版本号的数字段逐个按百进制折叠成整数（0.1.1-rc.2.6 -> 1010206）。
# 每段占两位十进制且各数字段 <100，因此任意一段递增 ⇒ 整体递增，满足 Android 升级安装要求。
$VersionCode = 0
foreach ($seg in [regex]::Matches($AppVersion, "\d+")) { $VersionCode = $VersionCode * 100 + [int]$seg.Value }
if ($VersionCode -ge 2100000000) { throw "versionCode 溢出 int32：$VersionCode（版本号数字段过多或过大）" }
Write-Host "== 版本：$AppVersion (versionCode $VersionCode) =="

# WEB-02：移动适配脚本单一源 = packages/gateway/assets/mobile-web.js（edge 网关注入
# 与安卓壳注入共用同一份代码，平台差异运行时探测）。这里字节级同步到 res/raw/mobile.js，
# 不做任何编码转换；res/raw 副本禁止手改。源文件缺失时直接报错（宁可不打包也不带旧脚本）。
$MobileSrc = Join-Path (Split-Path $PSScriptRoot -Parent) "packages/gateway/assets/mobile-web.js"
$MobileDst = Join-Path $AppDir "src/main/res/raw/mobile.js"
if (-not (Test-Path $MobileSrc)) { throw "移动适配脚本单一源缺失：$MobileSrc" }
New-Item -ItemType Directory -Force (Split-Path $MobileDst -Parent) | Out-Null
Copy-Item -Force -LiteralPath $MobileSrc -Destination $MobileDst
Write-Host "== 已同步 mobile.js 单一源（$((Get-Item $MobileSrc).Length) 字节）=="

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
	Write-Host "本地没有 libfrpc.so，自动下载 frp v$FrpVersion android_arm64 …"
	New-Item -ItemType Directory -Force (Split-Path $FrpcSo -Parent) | Out-Null
	$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dshr-frp-" + [guid]::NewGuid().ToString("N"))
	New-Item -ItemType Directory -Force $Tmp | Out-Null
	$tgz = Join-Path $Tmp "frp.tgz"
	$downloaded = $false
	foreach ($u in @(
			"https://github.com/fatedier/frp/releases/download/v$FrpVersion/frp_${FrpVersion}_android_arm64.tar.gz",
			"https://ghproxy.net/https://github.com/fatedier/frp/releases/download/v$FrpVersion/frp_${FrpVersion}_android_arm64.tar.gz")) {
		try {
			Invoke-WebRequest -Uri $u -OutFile $tgz -UseBasicParsing
			if ((Get-Item $tgz).Length -gt 1MB) { $downloaded = $true; break }
			Write-Host "下载不完整（$((Get-Item $tgz).Length) 字节），换源重试…"
		} catch { Write-Host "下载失败：$u —— $($_.Exception.Message)" }
	}
	if (-not $downloaded) { throw "frpc android_arm64 下载失败；请手动下载并放到 $FrpcSo" }
	tar -xzf $tgz -C $Tmp
	Copy-Item (Join-Path $Tmp "frp_${FrpVersion}_android_arm64/frpc") $FrpcSo -Force
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
# AND-05：发布/开发双模式签名。
#   发布（DSH_RELEASE=1，CI-01 合约）：release.yml 已把 GitHub secret 解码写入
#   ~/.android/dsh-remote.jks，并设置 DSH_RELEASE=1 与口令环境变量。发布路径
#   缺 keystore/口令一律报错退出——绝不就地生成临时密钥（否则每次发版签名不同，
#   APK 无法覆盖升级）。
#   开发（默认）：保留首次构建自动生成密钥，但口令改为随机生成并写入
#   同目录 dsh-remote.pass，不再硬编码固定口令；旧固定口令时代的存量密钥
#   缺口令文件时自动尝试找回（env DSH_KEYSTORE_PASS → 旧固定口令），找回后
#   补写 .pass 并沿用原密钥签名，保证已装设备可平滑覆盖升级。
$Keystore = if ($isWin) { Join-Path $env:USERPROFILE ".android/dsh-remote.jks" } else { Join-Path $env:HOME ".android/dsh-remote.jks" }
$ReleaseMode = ($env:DSH_RELEASE -eq "1")
$StorePass = ""
$KeyPass = ""
$KeyAlias = ""
if ($ReleaseMode) {
	if (-not (Test-Path $Keystore)) {
		throw "发布构建缺少 keystore：$Keystore（release.yml 应把 RELEASE_KEYSTORE_B64 解码写入该路径）"
	}
	$StorePass = $env:DSH_KEYSTORE_PASS
	$KeyPass = $env:DSH_KEY_PASS
	if (-not $StorePass) { throw "发布构建缺少环境变量 DSH_KEYSTORE_PASS" }
	if (-not $KeyPass) { $KeyPass = $StorePass }
	$KeyAlias = $env:DSH_KEY_ALIAS
	$SignMsg = "发布签名：$Keystore（口令来自环境变量"
	if ($KeyAlias) { $SignMsg += "，别名 $KeyAlias" }
	$SignMsg += "）"
	Write-Host $SignMsg
} else {
	$PassFile = Join-Path (Split-Path $Keystore -Parent) "dsh-remote.pass"
	if (-not (Test-Path $Keystore)) {
		New-Item -ItemType Directory -Force (Split-Path $Keystore -Parent) | Out-Null
		# 随机口令（64 位十六进制）：仅本次生成时产生，随后只从口令文件读取。
		$StorePass = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
		$KeyPass = $StorePass
		& $Keytool -genkeypair -keystore $Keystore -storetype PKCS12 `
			-alias dshremote -keyalg RSA -keysize 2048 -validity 10950 `
			-storepass $StorePass -keypass $KeyPass -dname "CN=DSH Remote Dev"
		if ($LASTEXITCODE -ne 0) { throw "生成签名密钥失败" }
		Set-Content -Path $PassFile -Value $StorePass -Encoding Ascii -NoNewline
		if (-not $isWin) {
			try { & chmod 600 $PassFile $Keystore 2>$null } catch { }
		}
		Write-Host "已生成开发签名密钥：$Keystore（随机口令保存在 $PassFile，请一并备份；丢失口令文件须删除密钥重新生成）"
	} else {
		if (-not (Test-Path $PassFile)) {
			# 旧密钥兼容找回：修复轮之前的 build.ps1 用硬编码固定口令创建开发密钥
			# （该口令已随 git 历史公开）。存量机器上的 keystore 缺配套口令文件时，
			# 依次尝试 DSH_KEYSTORE_PASS 与旧固定口令；找回成功即补写 .pass 并继续
			# 用**同一把密钥**签名——证书不变，已装设备可直接覆盖升级（平滑迁移）。
			# 注意：这只是找回通道，新生成的密钥仍然只用随机口令。
			$candidates = @()
			if ($env:DSH_KEYSTORE_PASS) { $candidates += $env:DSH_KEYSTORE_PASS }
			$candidates += "dsh-remote-2026"
			$recovered = ""
			foreach ($cand in $candidates) {
				& $Keytool -list -keystore $Keystore -storepass $cand 2>$null | Out-Null
				if ($LASTEXITCODE -eq 0) { $recovered = $cand; break }
			}
			if (-not $recovered) {
				throw "开发 keystore 存在但口令无法找回（缺 $PassFile，DSH_KEYSTORE_PASS 与旧固定口令均未打开密钥）。若不需要覆盖升级已装设备：删除 $Keystore 后重新构建（自动生成随机口令新密钥，旧调试包届时须卸载重装）；若需要：用 keytool -list 确认口令后手工写入 $PassFile。"
			}
			Set-Content -Path $PassFile -Value $recovered -Encoding Ascii -NoNewline
			if (-not $isWin) { try { & chmod 600 $PassFile 2>$null } catch { } }
			Write-Host "已找回旧开发密钥口令并补写 $PassFile（继续用原密钥签名，覆盖升级不受影响）"
		}
		$StorePass = (Get-Content -Raw -LiteralPath $PassFile).Trim()
		if (-not $StorePass) { throw "开发签名口令文件为空：$PassFile" }
		$KeyPass = $StorePass
	}
}
$Apk = Join-Path $DistDir "dsh-remote.apk"
$SignArgs = @("sign", "--ks", $Keystore, "--ks-pass", "pass:$StorePass")
if ($KeyAlias) { $SignArgs += @("--ks-key-alias", $KeyAlias) }
if ($KeyPass -ne $StorePass) { $SignArgs += @("--key-pass", "pass:$KeyPass") }
$SignArgs += @("--out", $Apk, "$OutDir/aligned.apk")
& $Java -jar (Join-Path $Bt "lib/apksigner.jar") @SignArgs
if ($LASTEXITCODE -ne 0) { throw "APK 签名失败" }

& $Java -jar (Join-Path $Bt "lib/apksigner.jar") verify $Apk
if ($LASTEXITCODE -ne 0) { throw "签名校验未通过" }

Write-Host ""
Write-Host "OK 构建完成：$Apk"
