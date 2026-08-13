$ErrorActionPreference="Stop"
$PipelineDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bat = Join-Path $PipelineDir "run_banklens.bat"
$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$Bat`""
$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday -At 10:00AM
Register-ScheduledTask -TaskName "BankLens Weekly Intelligence Pipeline" -Action $Action -Trigger $Trigger -Description "Fetch configured BankLens bank reports, extract/analyse locally, and publish through Wrangler to Cloudflare D1." -Force
Write-Host "Installed BankLens weekly task for Saturday 10:00."
