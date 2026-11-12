<#
.SYNOPSIS
    Installs (or removes) VRCX Status Report as VRCX's custom.js.

.DESCRIPTION
    Copies custom.js from this folder to %AppData%\VRCX\custom.js.
    If a different custom.js is already there, it is backed up first
    (custom.js.bak-<date>) so nothing you had is lost.
    Restart VRCX afterwards.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#>
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$vrcxDir = Join-Path $env:APPDATA 'VRCX'
$target = Join-Path $vrcxDir 'custom.js'
$source = Join-Path $PSScriptRoot 'custom.js'
$marker = 'VRCX Status Report'

if (-not (Test-Path $vrcxDir)) {
    Write-Error "VRCX data folder not found at $vrcxDir. Install and run VRCX once first."
}

if ($Uninstall) {
    if (-not (Test-Path $target)) { Write-Host 'Nothing to remove: no custom.js installed.'; exit 0 }
    if (-not (Select-String -Path $target -Pattern $marker -SimpleMatch -Quiet)) {
        Write-Error "$target is not VRCX Status Report; leaving it alone."
    }
    Remove-Item $target
    Write-Host "Removed $target. Restart VRCX."
    exit 0
}

if (-not (Test-Path $source)) { Write-Error "custom.js not found next to this script ($source)." }

if (Test-Path $target) {
    $isOurs = Select-String -Path $target -Pattern $marker -SimpleMatch -Quiet
    if (-not $isOurs) {
        $backup = "$target.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
        Copy-Item $target $backup
        Write-Host "Backed up your existing custom.js to $backup"
    }
}

Copy-Item $source $target -Force
Write-Host "Installed to $target"
Write-Host 'Restart VRCX, then open "Status Report" in the left sidebar (or press Ctrl+Shift+O).'
