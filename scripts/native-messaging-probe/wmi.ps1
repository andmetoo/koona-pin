# Runs run.mjs outside the job object of the calling shell (terminals and agent
# sandboxes often put their children in a job). WMI creates the process from
# its own service, so the browsers get the same job state as when the user
# starts them.
param([Parameter(ValueFromRemainingArguments)] [string[]] $Browsers = @())
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$output = Join-Path $root ".test-data\native-messaging-wmi.txt"
Remove-Item $output -ErrorAction SilentlyContinue
# A WMI process does not inherit this session's environment.
$edge = if ($env:NETAMIPIN_PROBE_EDGE) { "set `"NETAMIPIN_PROBE_EDGE=$env:NETAMIPIN_PROBE_EDGE`" && " } else { "" }
$command = "cmd /c $edge node scripts\native-messaging-probe\run.mjs $($Browsers -join ' ') > `"$output`" 2>&1"
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = $command
  CurrentDirectory = "$root"
}
if ($created.ReturnValue -ne 0) { throw "Win32_Process.Create failed: $($created.ReturnValue)" }
while (Get-Process -Id $created.ProcessId -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 1 }
Get-Content $output
