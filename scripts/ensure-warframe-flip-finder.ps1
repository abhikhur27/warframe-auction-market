$ErrorActionPreference = 'Stop'

$repoPath = 'C:\Users\abhim\Documents\New project'
$serverScript = Join-Path $repoPath 'server.js'

if (-not (Test-Path -LiteralPath $serverScript)) {
  throw "server.js not found at $serverScript"
}

$portListener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($portListener) {
  Write-Output 'Port 3000 is already in use. Skip start.'
  exit 0
}

$existing = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'node.exe' -and
    $_.CommandLine -like '*server.js*'
  }

if ($existing) {
  Write-Output 'Warframe Flip Finder is already running.'
  exit 0
}

Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $repoPath -WindowStyle Hidden
Write-Output 'Warframe Flip Finder started.'
