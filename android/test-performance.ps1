$ErrorActionPreference = 'Stop'
$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { "$env:LOCALAPPDATA\Android\Sdk" }
$jdk = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "$env:ProgramFiles\Android\Android Studio\jbr" }
$out = Join-Path $PSScriptRoot 'test-build/performance'
New-Item -ItemType Directory -Force $out | Out-Null
$platform = Join-Path $sdk 'platforms/android-36/android.jar'
$src = Join-Path $PSScriptRoot 'app/src/main/java/top/d1studio/dshremote'
& "$jdk/bin/javac.exe" -encoding UTF-8 -cp $platform -d $out `
    "$PSScriptRoot/tests/stubs/android/util/Log.java" "$PSScriptRoot/tests/stubs/android/webkit/CookieManager.java" `
    "$src/FetchRequest.java" "$src/PinnedFetch.java" "$src/CertPin.java" "$src/StuckRescue.java" `
    "$PSScriptRoot/tests/FetchRequestTest.java" "$PSScriptRoot/tests/FetchHttpsTest.java" "$PSScriptRoot/tests/StuckRescueTest.java" "$PSScriptRoot/tests/T114CredentialInjectionTest.java"
if ($LASTEXITCODE -ne 0) { throw 'Performance test compile failed' }
& "$jdk/bin/java.exe" '-Dfile.encoding=UTF-8' -cp "$out;$platform" top.d1studio.dshremote.FetchRequestTest
if ($LASTEXITCODE -ne 0) { throw 'Fetch lifecycle tests failed' }
& "$jdk/bin/java.exe" '-Dfile.encoding=UTF-8' -cp "$out;$platform" top.d1studio.dshremote.StuckRescueTest "$src/MainActivity.java" "$src/StuckRescue.java"
if ($LASTEXITCODE -ne 0) { throw 'Rescue regression tests failed' }
& "$jdk/bin/java.exe" '-Dfile.encoding=UTF-8' -cp "$out;$platform" top.d1studio.dshremote.T114CredentialInjectionTest (Split-Path $PSScriptRoot)
if ($LASTEXITCODE -ne 0) { throw 'Fetch regression tests failed' }
$fixturePass = [guid]::NewGuid().ToString('N')
# Use a disposable test certificate, separate from the app signing key.
$fixtureKey = Join-Path $out ("https-" + [guid]::NewGuid().ToString('N') + '.p12')
try {
    # Windows PowerShell 5 treats keytool's informational stderr as an error.
    # Capture it, and let the native exit code determine whether generation failed.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $keyOutput = & "$jdk/bin/keytool.exe" -genkeypair -alias fixture -keyalg RSA -keystore $fixtureKey -storetype PKCS12 -storepass $fixturePass -keypass $fixturePass -dname 'CN=localhost' -ext 'SAN=ip:127.0.0.1,dns:localhost' -validity 1 2>&1
        $keyExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($keyExitCode -ne 0) { throw ("HTTPS fixture key generation failed:`n" + ($keyOutput -join "`n")) }
    & "$jdk/bin/java.exe" '-Dfile.encoding=UTF-8' -cp "$out;$platform" top.d1studio.dshremote.FetchHttpsTest $fixtureKey $fixturePass
    if ($LASTEXITCODE -ne 0) { throw 'Real HTTPS lifecycle tests failed' }
} finally { if (Test-Path -LiteralPath $fixtureKey) { Remove-Item -LiteralPath $fixtureKey } }
