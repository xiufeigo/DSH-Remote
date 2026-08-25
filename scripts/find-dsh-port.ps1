$ErrorActionPreference = "SilentlyContinue"
Write-Host "--- DSH 相关进程的回环监听端口 ---"
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
foreach ($p in $procs) {
	if ($p.CommandLine -match "DSH Desktop" -or $p.ExecutablePath -match "DSH Desktop") {
		$conns = Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId
		foreach ($c in $conns) {
			Write-Host ("port={0} pid={1}" -f $c.LocalPort, $p.ProcessId)
		}
	}
}
$gui = Get-Process dsh-gui -ErrorAction SilentlyContinue
foreach ($g in $gui) {
	$conns = Get-NetTCPConnection -State Listen -OwningProcess $g.Id
	foreach ($c in $conns) {
		Write-Host ("port={0} pid={1} (gui)" -f $c.LocalPort, $g.Id)
	}
}
Write-Host "--- 全部 node 监听（兜底） ---"
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -in @("127.0.0.1","0.0.0.0","::1","::") } | ForEach-Object {
	$p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
	if ($null -ne $p -and $p.ProcessName -eq "node") {
		Write-Host ("port={0} pid={1}" -f $_.LocalPort, $_.OwningProcess)
	}
}
