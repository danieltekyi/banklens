param(
    [switch]$Uninstall,
    [string]$TaskName = "BankLens Weekly Intelligence Pipeline",
    [string]$ExtraArguments = ""
)

$ErrorActionPreference = "Stop"
$PipelineDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bat = Join-Path $PipelineDir "run_banklens.bat"

if (!(Test-Path $Bat)) {
    throw "run_banklens.bat not found at $Bat"
}

if ($Uninstall) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Uninstalled scheduled task '$TaskName'."
    } else {
        Write-Host "Scheduled task '$TaskName' is not installed."
    }
    exit 0
}

$quotedBat = '"' + $Bat + '"'
$argument = "/d /c $quotedBat $ExtraArguments"
$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $argument -WorkingDirectory $PipelineDir
$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday -At 10:00AM
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 6)
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel LeastPrivilege

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description "Fetch configured BankLens bank reports, extract/analyse locally, and publish through Wrangler to Cloudflare D1." -Force | Out-Null
Write-Host "Installed/updated '$TaskName' for Saturday 10:00 local time."
Write-Host "Command: $Bat $ExtraArguments"
