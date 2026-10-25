param([Parameter(Mandatory=$true)][string]$Serial)
$ErrorActionPreference = 'Stop'
$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { "$env:LOCALAPPDATA/Android/Sdk" }
$jdk = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "$env:ProgramFiles/Android/Android Studio/jbr" }
$out = Join-Path $PSScriptRoot 'test-build/process-device'
$platform = Join-Path $sdk 'platforms/android-36/android.jar'
$bt = Join-Path $sdk 'build-tools/35.0.0'
$adb = Join-Path $sdk 'platform-tools/adb.exe'
New-Item -ItemType Directory -Force "$out/classes", "$out/dex" | Out-Null
& "$jdk/bin/javac.exe" -encoding UTF-8 -nowarn -source 8 -target 8 `
    -bootclasspath "$platform;$bt/core-lambda-stubs.jar" -d "$out/classes" `
    "$PSScriptRoot/app/src/main/java/top/d1studio/dshremote/ChildProcess.java" "$PSScriptRoot/tests/ChildProcessDeviceTest.java"
if ($LASTEXITCODE -ne 0) { throw 'Child process device test compile failed' }
Get-ChildItem -Recurse "$out/classes" -Filter *.class | ForEach-Object FullName | Set-Content "$out/classes.txt" -Encoding Ascii
& "$jdk/bin/java.exe" -cp "$bt/lib/d8.jar" com.android.tools.r8.D8 --release --lib $platform --min-api 24 --output "$out/dex" "@$out/classes.txt"
if ($LASTEXITCODE -ne 0) { throw 'Child process device test dex failed' }
& "$jdk/bin/jar.exe" cf "$out/test.jar" -C "$out/dex" classes.dex
if ($LASTEXITCODE -ne 0) { throw 'Child process device test package failed' }
$remote = '/data/local/tmp/dshr-child-process-test.jar'
try {
    & $adb -s $Serial push "$out/test.jar" $remote
    if ($LASTEXITCODE -ne 0) { throw 'Child process device test push failed' }
    & $adb -s $Serial shell "CLASSPATH=$remote app_process /system/bin top.d1studio.dshremote.ChildProcessDeviceTest"
    if ($LASTEXITCODE -ne 0) { throw 'Android child process lifecycle test failed' }
} finally {
    & $adb -s $Serial shell rm -f $remote
}
