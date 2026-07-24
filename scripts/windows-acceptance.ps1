[CmdletBinding()]
param(
    [string]$Binary,
    [string]$Root = (Join-Path ([IO.Path]::GetTempPath()) 'myterminal-acceptance'),
    [switch]$ApiOnly
)

$ErrorActionPreference = 'Stop'
$RunRoot = [IO.Path]::GetFullPath($Root)
if ((Split-Path -Leaf $RunRoot) -notlike 'myterminal-acceptance*') {
    throw "Acceptance root must be a dedicated directory named myterminal-acceptance*: $RunRoot"
}

$ConfigDir = Join-Path $RunRoot 'config'
$WorkspaceDir = Join-Path $RunRoot 'workspace'
$Candidate = Join-Path $RunRoot 'myterminal.exe'
$StdoutPath = Join-Path $RunRoot 'runtime.stdout.log'
$StderrPath = Join-Path $RunRoot 'runtime.stderr.log'

function Invoke-CandidateCheck([string[]]$CandidateArguments, [string]$Label) {
    $LastOutput = ''
    for ($Attempt = 1; $Attempt -le 10; $Attempt++) {
        $LastOutput = (& $Candidate @CandidateArguments 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -eq 0 -and $LastOutput) { return $LastOutput }
        Start-Sleep -Milliseconds 750
    }
    throw "$Label failed after bounded retries. Last output: $LastOutput"
}

if ($ApiOnly) {
    if (-not (Test-Path -LiteralPath $Candidate)) { throw "Prepared candidate not found: $Candidate" }
    $Settings = Get-Content -Raw -LiteralPath (Join-Path $ConfigDir 'config.json') | ConvertFrom-Json
    $Port = [int]$Settings.port
    $ActionsToken = [string]$Settings.actionsToken
    $Version = Invoke-CandidateCheck -CandidateArguments @('--version') -Label 'Candidate --version'
} else {
    if (-not $Binary) { throw 'Binary is required unless -ApiOnly is used.' }
    $SourceBinary = (Resolve-Path -LiteralPath $Binary).Path
    if (Test-Path -LiteralPath $RunRoot) {
        throw "Acceptance root already exists. Preserve it for diagnosis or remove that exact test directory before rerunning: $RunRoot"
    }
    New-Item -ItemType Directory -Force -Path $ConfigDir, $WorkspaceDir | Out-Null
    Copy-Item -LiteralPath $SourceBinary -Destination $Candidate
    # Defender and the x64 compatibility layer can briefly hold a freshly copied
    # standalone executable. Use the same bounded retry policy as the installer.
    $Version = Invoke-CandidateCheck -CandidateArguments @('--version') -Label 'Candidate --version'
    $Verification = Invoke-CandidateCheck -CandidateArguments @('--verify-installation') -Label 'Candidate --verify-installation'
    $Listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $Listener.Start()
    $Port = ([Net.IPEndPoint]$Listener.LocalEndpoint).Port
    $Listener.Stop()
    $ActionsToken = 'windows-acceptance-actions-token-1234567890'
    $ConnectorKey = 'windows-acceptance-connector-key-1234567890'
    $Settings = [ordered]@{
        schemaVersion = 1
        workspaceDir = $WorkspaceDir
        host = '127.0.0.1'
        port = $Port
        connectorKey = $ConnectorKey
        actionsToken = $ActionsToken
        publicBaseUrl = ''
        maxOutputChars = 120000
        commandTimeoutSec = 10
        uiLanguage = 'zh-CN'
        uiTheme = 'dark'
        passiveLockEnabled = $false
        actionsContinuationMode = 'off'
        nonBlockingTasksEnabled = $false
    }
    $Utf8NoBom = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText((Join-Path $ConfigDir 'config.json'), ($Settings | ConvertTo-Json -Depth 10), $Utf8NoBom)
    [IO.File]::WriteAllText((Join-Path $WorkspaceDir 'windows-smoke.txt'), "PowerShell acceptance workspace`r`n", $Utf8NoBom)
}

$PreviousConfig = $env:MYTERMINAL_CONFIG_DIR
$env:MYTERMINAL_CONFIG_DIR = $ConfigDir
$Process = $null
function Invoke-JsonPost([string]$Uri, [hashtable]$Headers, [string]$Body) {
    try {
        return Invoke-RestMethod -Method Post -Uri $Uri -Headers $Headers -ContentType 'application/json' -Body $Body
    } catch {
        if ($_.ErrorDetails.Message) {
            try { return ($_.ErrorDetails.Message | ConvertFrom-Json) } catch { }
        }
        $Response = $_.Exception.Response
        if (-not $Response) { throw }
        if ($Response.PSObject.Properties.Name -contains 'Content') {
            $ResponseText = $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            return ($ResponseText | ConvertFrom-Json)
        }
        $Reader = [IO.StreamReader]::new($Response.GetResponseStream())
        try { return ($Reader.ReadToEnd() | ConvertFrom-Json) }
        finally { $Reader.Dispose() }
    }
}
try {
    $BaseUrl = "http://127.0.0.1:$Port"
    $Health = $null
    if ($ApiOnly) {
        $Health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 2
    } else {
        for ($RuntimeAttempt = 1; $RuntimeAttempt -le 5 -and -not $Health; $RuntimeAttempt++) {
            $Process = Start-Process -FilePath $Candidate -ArgumentList '--headless' -PassThru -NoNewWindow -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath
            for ($Attempt = 1; $Attempt -le 50; $Attempt++) {
                if ($Process.HasExited) { break }
                try {
                    $Health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 1
                    if ($Health.product -eq 'myterminal') { break }
                } catch {
                    Start-Sleep -Milliseconds 200
                }
            }
            if (-not $Health) { Start-Sleep -Milliseconds 750 }
        }
    }
    if (-not $Health -or $Health.product -ne 'myterminal') { throw "Runtime health check did not become ready after bounded retries. See $StderrPath" }

    $Headers = @{ Authorization = "Bearer $ActionsToken" }
    $SmokeSessionName = "windows-powershell-smoke-$([DateTime]::UtcNow.ToString('HHmmssfff'))"
    $RegisterBody = @{ tool = 'session_register'; input = @{ mode = 'root'; name = $SmokeSessionName; role = 'lead' } } | ConvertTo-Json -Depth 10
    $Registration = Invoke-JsonPost -Uri "$BaseUrl/actions/extensions/call" -Headers $Headers -Body $RegisterBody
    if (-not $Registration.ok) { throw 'Windows session registration failed.' }
    $Identity = $Registration.data.result.identity

    $CommandBody = @{
        tool = 'execute_cli'
        input = @{ command = 'echo windows-command-ok'; timeoutSec = 5 }
        identity = $Identity
    } | ConvertTo-Json -Depth 12
    $Command = Invoke-JsonPost -Uri "$BaseUrl/actions/extensions/call" -Headers $Headers -Body $CommandBody
    if (-not $Command.ok -or $Command.data.result.stdout -notmatch 'windows-command-ok') { throw 'Windows cmd.exe command smoke test failed.' }

    $TimeoutBody = @{
        tool = 'execute_cli'
        input = @{ command = 'powershell.exe -NoProfile -Command "Start-Sleep -Seconds 3"'; timeoutSec = 1 }
        identity = $Identity
    } | ConvertTo-Json -Depth 12
    $Timeout = Invoke-JsonPost -Uri "$BaseUrl/actions/extensions/call" -Headers $Headers -Body $TimeoutBody
    if ($Timeout.ok -or $Timeout.error.code -ne 'ACTION_TIMEOUT') {
        throw "Windows command-tree timeout smoke test failed: $($Timeout | ConvertTo-Json -Depth 12 -Compress)"
    }
    if ($Timeout.data.continuation) { throw 'Harness-off failure unexpectedly injected a continuation plan.' }
    if ($Timeout.data.result.durationMs -gt 2500) { throw "Windows command tree was not stopped promptly: $($Timeout.data.result.durationMs)ms" }
    $HealthAfterTimeout = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 2
    if ($HealthAfterTimeout.product -ne 'myterminal') { throw 'Runtime did not survive Windows command-tree termination.' }
} finally {
    if ($Process -and -not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        $Process.WaitForExit(5000) | Out-Null
    }
    if ($null -eq $PreviousConfig) { Remove-Item Env:MYTERMINAL_CONFIG_DIR -ErrorAction SilentlyContinue }
    else { $env:MYTERMINAL_CONFIG_DIR = $PreviousConfig }
}

Write-Host "PASS: MyTerminal $Version Windows/PowerShell automated smoke checks."
Write-Host "Candidate: $Candidate"
Write-Host "Isolated config: $ConfigDir"
Write-Host 'Manual TUI command:'
Write-Host "  `$env:MYTERMINAL_CONFIG_DIR='$ConfigDir'; & '$Candidate'"
