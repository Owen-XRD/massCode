param(
 [Parameter(Mandatory=$true)][string]$Root,
 [Parameter(Mandatory=$true)][ValidateSet('desktop','laptop')][string]$Role,
 [string]$Version='6.0.0-owen.1',
 [string]$ExpectedSha256='72666F0120C1D6C2AF12B0CE7F9BF8D5D7BA35022B76955CCC4E64A300E8F169',
 [string]$Receipt='',
 [string]$BackupRoot=$PSScriptRoot
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$reviewVersion=$Version
$reviewExecutable=Join-Path $Root "releases\$reviewVersion\massCode.exe"
$reviewAsar=Join-Path $Root "releases\$reviewVersion\resources\app.asar"
if((Get-FileHash -LiteralPath $reviewAsar).Hash -ne $ExpectedSha256){throw 'The verified local release hash does not match'}
$reviewProfile=if($Role -eq 'desktop'){'X:\Data\massCode\profile'}else{'H:\Data\massCode\profile'}
$reviewTask=Get-ScheduledTask -TaskName 'Owen-massCode-Manual'
$reviewOldAction=$reviewTask.Actions
$reviewVersionPath=Join-Path $Root 'VERSION'
$reviewOldVersion=[IO.File]::ReadAllText($reviewVersionPath)
$reviewBackup=Join-Path $BackupRoot ('activation-backup-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $reviewBackup | Out-Null
Export-ScheduledTask -TaskName 'Owen-massCode-Manual' | Set-Content -LiteralPath (Join-Path $reviewBackup 'task.xml') -Encoding Unicode
Copy-Item -LiteralPath $reviewVersionPath -Destination (Join-Path $reviewBackup 'VERSION')
$reviewArguments='--user-data-dir="'+$reviewProfile+'"'
$reviewAction=New-ScheduledTaskAction -Execute $reviewExecutable -Argument $reviewArguments -WorkingDirectory $Root
$reviewChanged=$false
try {
 Set-ScheduledTask -TaskName 'Owen-massCode-Manual' -Action $reviewAction | Out-Null
 $reviewChanged=$true
 [IO.File]::WriteAllText($reviewVersionPath,$reviewVersion+"`r`n",[Text.UTF8Encoding]::new($false))
 $reviewEntry=& (Join-Path $Root 'Update-DesktopShortcut.ps1') -Root $Root -Role $Role -CheckOnly
}catch {
 if($reviewChanged){Set-ScheduledTask -TaskName 'Owen-massCode-Manual' -Action $reviewOldAction | Out-Null}
 [IO.File]::WriteAllText($reviewVersionPath,$reviewOldVersion,[Text.UTF8Encoding]::new($false))
 throw
}
$reviewRunning=@(Get-CimInstance Win32_Process -Filter "Name='massCode.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine -notlike '*--type=*' -and $_.CommandLine.Contains($reviewProfile)} | Select-Object ProcessId,ExecutablePath,CreationDate)
$reviewReceipt=[ordered]@{checkedAt=(Get-Date).ToUniversalTime().ToString('o');role=$Role;version=$reviewVersion;selectedRuntime=$reviewExecutable;taskArguments=$reviewArguments;previousVersion=$reviewOldVersion.Trim();backup=$reviewBackup;desktopEntryPassed=$reviewEntry.passed;running=$reviewRunning;guiRestarted=$false;runningWindowAutomaticallyUpdated=$false;selectedRuntimeTakesEffectOnNextNormalLaunch=$true;dataOrProfileCopied=$false}
if(-not $Receipt){$Receipt=Join-Path $PSScriptRoot "$Role-release-activation.json"}
[IO.File]::WriteAllText($Receipt,($reviewReceipt|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
$reviewReceipt | ConvertTo-Json -Depth 5 -Compress
