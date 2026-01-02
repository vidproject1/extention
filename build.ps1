param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("chrome", "firefox")]
  [string]$Target
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceDir = $RepoRoot
$ManifestDir = Join-Path $RepoRoot "manifests"
$DistRoot = Join-Path $RepoRoot "dist"
$OutDir = Join-Path $DistRoot $Target

if (Test-Path $OutDir) {
  Remove-Item -Recurse -Force $OutDir
}
New-Item -ItemType Directory -Path $OutDir | Out-Null

$manifestTemplate = if ($Target -eq "chrome") {
  Join-Path $ManifestDir "manifest.chrome.mv3.json"
} else {
  Join-Path $ManifestDir "manifest.firefox.mv2.json"
}

Copy-Item (Join-Path $SourceDir "content-script.js") -Destination $OutDir
Copy-Item (Join-Path $SourceDir "options.html") -Destination $OutDir
Copy-Item (Join-Path $SourceDir "options.js") -Destination $OutDir
Copy-Item $manifestTemplate -Destination (Join-Path $OutDir "manifest.json")

Write-Output ("Built " + $Target + " extension at: " + $OutDir)
