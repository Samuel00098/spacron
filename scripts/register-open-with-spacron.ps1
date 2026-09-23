<##
.SYNOPSIS
  Adds or removes Spacron from the current user's Windows Explorer menus.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\register-open-with-spacron.ps1 `
    -ExecutablePath "$env:LOCALAPPDATA\Spacron\spacron.exe"

  The NSIS installer does this automatically. This script is for portable,
  development, or MSI installs where an installer hook is not available.
#>
[CmdletBinding()]
param(
  [string]$ExecutablePath,
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$menuNames = @(
  'HKCU:\Software\Classes\Directory\shell\Spacron',
  'HKCU:\Software\Classes\Directory\Background\shell\Spacron',
  'HKCU:\Software\Classes\*\shell\Spacron'
)

if ($Unregister) {
  foreach ($menuName in $menuNames) {
    Remove-Item -LiteralPath $menuName -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host 'Removed Open with Spacron from the current user''s Explorer menus.'
  exit 0
}

if (-not $ExecutablePath) {
  $candidates = @(
    (Join-Path $PSScriptRoot '..\src-tauri\target\release\spacron.exe'),
    (Join-Path $PSScriptRoot '..\src-tauri\target\debug\spacron.exe'),
    (Join-Path $env:LOCALAPPDATA 'Spacron\spacron.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Spacron\spacron.exe')
  )
  $ExecutablePath = $candidates |
    ForEach-Object { try { (Resolve-Path -LiteralPath $_ -ErrorAction Stop).Path } catch {} } |
    Select-Object -First 1
}

if (-not $ExecutablePath) {
  throw 'Spacron.exe was not found. Pass -ExecutablePath with the full path to the app executable.'
}

$ExecutablePath = (Resolve-Path -LiteralPath $ExecutablePath -ErrorAction Stop).Path
$commandFor = {
  param([string]$argument)
  '"' + $ExecutablePath + '" "' + $argument + '"'
}

$entries = @(
  @{ Key = $menuNames[0]; Label = 'Open with Spacron'; Argument = '%1' },
  @{ Key = $menuNames[1]; Label = 'Open with Spacron'; Argument = '%V' },
  @{ Key = $menuNames[2]; Label = 'Open with Spacron'; Argument = '%1' }
)

foreach ($entry in $entries) {
  New-Item -Path $entry.Key -Force | Out-Null
  New-Item -Path (Join-Path $entry.Key 'command') -Force | Out-Null
  Set-ItemProperty -LiteralPath $entry.Key -Name '(default)' -Value $entry.Label
  Set-ItemProperty -LiteralPath $entry.Key -Name 'Icon' -Value $ExecutablePath
  Set-ItemProperty -LiteralPath (Join-Path $entry.Key 'command') -Name '(default)' -Value (& $commandFor $entry.Argument)
}

Write-Host "Added Open with Spacron using $ExecutablePath."
