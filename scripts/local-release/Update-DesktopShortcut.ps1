param(
 [string]$Root=$PSScriptRoot,
 [ValidateSet('desktop','laptop')][string]$Role,
 [switch]$CheckOnly,
 [string]$Receipt=''
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$rootPath=(Resolve-Path -LiteralPath $Root).ProviderPath.TrimEnd('\')
if(-not $Role){$Role=if($rootPath -eq 'D:\Engineering\Tools\massCode'){'desktop'}elseif($rootPath -eq 'I:\ManagedSoftware\Apps\massCode'){'laptop'}else{throw 'Specify the machine role for a different installation root.'}}
$desktop=[Environment]::GetFolderPath('Desktop')
if(-not $desktop -or -not [IO.Path]::IsPathRooted($desktop)){throw 'An actual user desktop is required.'}
$toolsPath=Join-Path $desktop 'tools'
$entryPath=Join-Path $toolsPath 'massCode.lnk'
$launcher=Join-Path $rootPath 'Start-massCode.vbs'
$version=[IO.File]::ReadAllText((Join-Path $rootPath 'VERSION')).Trim()
$localReceipt=Join-Path $rootPath "releases\$version\LOCAL_PATCH.json"
$upstreamVersion=$version
$runtime=Join-Path $rootPath "downloads\massCode-$version-x64-portable.exe"
if(Test-Path -LiteralPath $localReceipt){
 $releaseMetadata=Get-Content -LiteralPath $localReceipt -Raw | ConvertFrom-Json
 if($releaseMetadata.version -ne $version){throw 'The selected local release receipt does not match VERSION.'}
 $upstreamVersion=$releaseMetadata.upstreamVersion
 $runtime=Join-Path $rootPath "releases\$version\massCode.exe"
}
$product=Join-Path $rootPath "downloads\massCode-$upstreamVersion-x64-portable.exe"
$target=Join-Path $env:WINDIR 'System32\wscript.exe'
$arguments='"'+$launcher+'"'
$icon=$product+',0'
$description="massCode $version - local snippets, notes and HTTP"
foreach($required in @($launcher,$product,$runtime,$target)){if(-not(Test-Path -LiteralPath $required -PathType Leaf)){throw "Required project file is missing: $required"}}
$shell=New-Object -ComObject WScript.Shell
function Read-Entry([string]$FilePath){
 if(-not(Test-Path -LiteralPath $FilePath -PathType Leaf)){return $null}
 $item=Get-Item -LiteralPath $FilePath
 if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Shortcut links must be ordinary files: $FilePath"}
 $s=$shell.CreateShortcut($FilePath)
 [pscustomobject]@{path=$FilePath;target=$s.TargetPath;arguments=$s.Arguments;icon=$s.IconLocation;workingDirectory=$s.WorkingDirectory;description=$s.Description}
}
function Own-Entry($Entry){$null -ne $Entry -and $Entry.target -eq $target -and $Entry.arguments -eq $arguments}
$before=Read-Entry $entryPath
if($before -and -not(Own-Entry $before)){throw 'The destination shortcut belongs to another launcher; it was preserved.'}
$changed=$false
$launchChanged=($null -eq $before -or $before.target -ne $target -or $before.arguments -ne $arguments -or $before.workingDirectory -ne $rootPath)
$backups=@()
if(-not $CheckOnly){
 if(-not(Test-Path -LiteralPath $toolsPath)){New-Item -ItemType Directory -Path $toolsPath|Out-Null}
 if(-not $before -or $before.icon -ne $icon -or $before.workingDirectory -ne $rootPath -or $before.description -ne $description){
  $s=$shell.CreateShortcut($entryPath);$s.TargetPath=$target;$s.Arguments=$arguments;$s.WorkingDirectory=$rootPath;$s.IconLocation=$icon;$s.Description=$description;$s.Save();$changed=$true
 }
 foreach($folder in @($desktop,$toolsPath)){
  foreach($file in @(Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -File)){
   if($file.FullName -eq $entryPath){continue}
   $entry=Read-Entry $file.FullName
   if(Own-Entry $entry){
    $backupDir=Join-Path $rootPath 'work\desktop-shortcuts-backup'
    if(-not(Test-Path -LiteralPath $backupDir)){New-Item -ItemType Directory -Path $backupDir|Out-Null}
    $destination=Join-Path $backupDir ($Role+'-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff')+'-'+$file.Name)
    Move-Item -LiteralPath $file.FullName -Destination $destination
    $backups+=@([ordered]@{original=$file.FullName;preservedAt=$destination;target=$entry.target;arguments=$entry.arguments})
   }
  }
 }
}
if(-not('MassCodeShortcutIcon' -as [type])){
 Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MassCodeShortcutIcon {
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)] public static extern uint ExtractIconEx(string file,int index,IntPtr large,IntPtr small,uint count);
}
'@
}
$after=Read-Entry $entryPath
$ownedTools=@(Get-ChildItem -LiteralPath $toolsPath -Filter '*.lnk' -File -ErrorAction SilentlyContinue|ForEach-Object{Read-Entry $_.FullName}|Where-Object{Own-Entry $_})
$ownedRoot=@(Get-ChildItem -LiteralPath $desktop -Filter '*.lnk' -File|ForEach-Object{Read-Entry $_.FullName}|Where-Object{Own-Entry $_})
$iconCount=[MassCodeShortcutIcon]::ExtractIconEx($product,-1,[IntPtr]::Zero,[IntPtr]::Zero,0)
$task=Get-ScheduledTask -TaskName 'Owen-massCode-Manual'
$profile=if($Role -eq 'desktop'){'X:\Data\massCode\profile'}else{'H:\Data\massCode\profile'}
$expectedTaskArguments='--user-data-dir="'+$profile+'"'
$taskMatches=($task.Actions.Execute -eq $runtime -and $task.Actions.Arguments -eq $expectedTaskArguments -and $task.Actions.WorkingDirectory -eq $rootPath)
$currentGui=@(Get-CimInstance Win32_Process -Filter "Name='massCode.exe'"|Where-Object{$_.CommandLine -and $_.CommandLine -notlike '*--type=*' -and $_.CommandLine.Contains($profile)}|Select-Object ProcessId,SessionId)
$result=[ordered]@{checkedAt=(Get-Date).ToString('o');role=$Role;version=$version;desktop=$desktop;toolsDirectory=$toolsPath;entry=$after;sourceGenerator=Join-Path $rootPath 'Update-DesktopShortcut.ps1';changed=$changed;launchBehaviorUnchanged=(-not $launchChanged);ownedToolsEntries=$ownedTools.Count;ownedDesktopRootEntries=$ownedRoot.Count;productIconResourceCount=$iconCount;backupEntries=$backups;launcherSha256=(Get-FileHash -LiteralPath $launcher).Hash;taskExecutable=$task.Actions.Execute;taskArguments=$task.Actions.Arguments;reusedBusinessEvidence=@('outputs\VALIDATION.md',"outputs\$Role-final-runtime.json","outputs\$Role-final-launcher-job.json");businessChecksRepeated=$false;guiRestarted=$false;checkOnly=[bool]$CheckOnly}
$result.passed=($null -ne $after -and (Own-Entry $after) -and $after.workingDirectory -eq $rootPath -and $after.icon -eq $icon -and $iconCount -gt 0 -and $ownedTools.Count -eq 1 -and $ownedRoot.Count -eq 0)
$result.taskWorkingDirectory=$task.Actions.WorkingDirectory
$result.taskMatchesUnchangedProjectLauncher=$taskMatches
$result.selectedRuntime=$runtime
$result.upstreamVersion=$upstreamVersion
$result.currentGui=$currentGui
$result.passed=($result.passed -and $taskMatches)
if(-not $Receipt){$Receipt=Join-Path $rootPath "outputs\$Role-tools-entry.json"}
[IO.File]::WriteAllText($Receipt,($result|ConvertTo-Json -Depth 7),[Text.UTF8Encoding]::new($false))
if(-not $result.passed){throw 'The project desktop tools entry does not match the expected launcher and icon.'}
[pscustomobject]$result
