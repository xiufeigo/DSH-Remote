# JVM behavioral tests: production ProfileStore + real org.json, no emulator required.
$ErrorActionPreference = 'Stop'
$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { "$env:LOCALAPPDATA\Android\Sdk" }
$jdk = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "$env:ProgramFiles\Android\Android Studio\jbr" }
$out = Join-Path $PSScriptRoot 'test-build'
New-Item -ItemType Directory -Force "$out/classes" | Out-Null
$json = Join-Path $out 'json-20240303.jar'
if (!(Test-Path $json)) {
    Invoke-WebRequest 'https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar' -OutFile $json
}
$platform = Join-Path $sdk 'platforms/android-36/android.jar'
$src = Join-Path $PSScriptRoot 'app/src/main/java/top/d1studio/dshremote'
& "$jdk/bin/javac.exe" -encoding UTF-8 -cp "$json;$platform" -d "$out/classes" `
    "$PSScriptRoot/tests/stubs/android/text/TextUtils.java" "$src/VisitorConfig.java" "$src/ProfileStore.java" "$PSScriptRoot/tests/DirectNodesTest.java"
if ($LASTEXITCODE -ne 0) { throw 'JVM test compile failed' }
& "$jdk/bin/java.exe" -cp "$out/classes;$json;$platform" top.d1studio.dshremote.DirectNodesTest
if ($LASTEXITCODE -ne 0) { throw 'Direct node tests failed' }
