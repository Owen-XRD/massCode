param(
 [Parameter(Mandatory=$true)][string]$Root,
 [Parameter(Mandatory=$true)][ValidateSet('desktop','laptop')][string]$Role,
 [string]$Version='',
 [string]$ExpectedSha256='',
 [string]$Receipt='',
 [string]$BackupRoot=$PSScriptRoot
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
# Use the current Windows PowerShell modules even when a Core parent supplied PSModulePath.
if($PSVersionTable.PSEdition -eq 'Desktop'){
 foreach($entryModule in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility','ScheduledTasks')){
  Import-Module ([IO.Path]::Combine($PSHOME,'Modules',$entryModule)) -ErrorAction Stop
 }
}
if(-not $Version){$Version=[IO.File]::ReadAllText((Join-Path $Root 'VERSION')).Trim()}
$reviewVersion=$Version
$reviewExecutable=Join-Path $Root "releases\$reviewVersion\massCode.exe"
$reviewAsar=Join-Path $Root "releases\$reviewVersion\resources\app.asar"
if(-not $ExpectedSha256){
 $identity=Get-Content -LiteralPath (Join-Path $Root "releases\$reviewVersion\LOCAL_PATCH.json") -Raw|ConvertFrom-Json
 if($identity.version -ne $reviewVersion){throw 'The selected release identity differs from VERSION'}
 $ExpectedSha256=$identity.asarSha256
}
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
 $reviewEntry=& (Join-Path $Root 'Update-DesktopShortcut.ps1') -Root $Root -Role $Role -CheckOnly -Receipt (Join-Path $BackupRoot "$Role-tools-entry-activation.json")
}catch {
 if($reviewChanged){Set-ScheduledTask -TaskName 'Owen-massCode-Manual' -Action $reviewOldAction | Out-Null}
 [IO.File]::WriteAllText($reviewVersionPath,$reviewOldVersion,[Text.UTF8Encoding]::new($false))
 throw
}
$reviewRunning=@(Get-Process -Name massCode -ErrorAction SilentlyContinue | Where-Object {$_.Path -and $_.Path.StartsWith(([IO.Path]::GetFullPath($Root).TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)} | Select-Object @{Name='ProcessId';Expression={$_.Id}},@{Name='ExecutablePath';Expression={$_.Path}},@{Name='CreationDate';Expression={$_.StartTime.ToUniversalTime().ToString('o')}})
$reviewReceipt=[ordered]@{checkedAt=(Get-Date).ToUniversalTime().ToString('o');role=$Role;version=$reviewVersion;selectedRuntime=$reviewExecutable;taskArguments=$reviewArguments;previousVersion=$reviewOldVersion.Trim();backup=$reviewBackup;desktopEntryPassed=$reviewEntry.passed;running=$reviewRunning;guiRestarted=$false;runningWindowAutomaticallyUpdated=$false;selectedRuntimeTakesEffectOnNextNormalLaunch=$true;dataOrProfileCopied=$false}
if(-not $Receipt){$Receipt=Join-Path $PSScriptRoot "$Role-release-activation.json"}
[IO.File]::WriteAllText($Receipt,($reviewReceipt|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
$reviewReceipt | ConvertTo-Json -Depth 5 -Compress
