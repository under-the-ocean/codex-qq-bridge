$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = (Get-Command python).Source
$Script = Join-Path $Root "codex_qq_bridge_cdp_relay.py"
$Log = Join-Path $Root "codex-qq-bridge-cdp-relay.log"
$PidFile = Join-Path $Root "codex-qq-bridge-cdp-relay.pid"

Remove-Item -Force -ErrorAction SilentlyContinue $Log

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $Python
$psi.Arguments = "`"$Script`""
$psi.WorkingDirectory = $Root
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $psi
$null = $process.Start()
$process.Id | Set-Content -Encoding ascii $PidFile

Start-Sleep -Milliseconds 1200

[pscustomobject]@{
  Id = $process.Id
  HasExited = $process.HasExited
  PidFile = $PidFile
  Log = $Log
}
