$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = (Get-Command node).Source
$Script = Join-Path $Root "codex-qq-bridge-cdp-relay.js"
$Log = Join-Path $Root "codex-qq-bridge-cdp-relay.log"
$ErrorLog = Join-Path $Root "codex-qq-bridge-cdp-relay.err.log"
$PidFile = Join-Path $Root "codex-qq-bridge-cdp-relay.pid"

Remove-Item -Force -ErrorAction SilentlyContinue $Log
Remove-Item -Force -ErrorAction SilentlyContinue $ErrorLog

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $Node
$psi.Arguments = "`"$Script`""
$psi.WorkingDirectory = $Root
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.EnvironmentVariables["CODEX_RELAY_LOG"] = $Log

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $psi
$null = $process.Start()
$process.Id | Set-Content -Encoding ascii $PidFile

Start-Sleep -Milliseconds 1000

[pscustomobject]@{
  Id = $process.Id
  HasExited = $process.HasExited
  PidFile = $PidFile
  Log = $Log
  ErrorLog = $ErrorLog
}
