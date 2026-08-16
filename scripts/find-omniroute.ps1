# Locates the running OmniRoute process and install/config paths (Windows).
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  ForEach-Object {
    $cmd = $_.CommandLine
    if ($cmd -and $cmd -match 'omniroute') {
      Write-Output ("PID={0}`nCMD={1}`n" -f $_.ProcessId, $cmd)
    }
  }

Write-Output "=== search for omniroute install dirs ==="
$roots = @(
  "$env:USERPROFILE\npm-global\node_modules\omniroute",
  "$env:APPDATA\npm\node_modules\omniroute",
  "$env:USERPROFILE\AppData\Roaming\npm\node_modules\omniroute",
  "C:\node24\node_modules\omniroute",
  "C:\node24\npm-global\node_modules\omniroute"
)
foreach ($r in $roots) {
  if (Test-Path $r) { Write-Output "FOUND: $r" }
}

Write-Output "=== search data dirs ==="
$dataDirs = @(
  "$env:APPDATA\omniroute",
  "$env:USERPROFILE\.omniroute",
  "$env:LOCALAPPDATA\omniroute",
  "$env:USERPROFILE\.omniroute-run"
)
foreach ($d in $dataDirs) {
  if (Test-Path $d) {
    Write-Output "DATA DIR: $d"
    Get-ChildItem $d | Select-Object Name, Length | Format-Table -AutoSize | Out-String | ForEach-Object { Write-Output $_ }
  }
}
