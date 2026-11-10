# Runs NeverQuestAlone from this checkout on Windows, with no build (odd/tasks/nqa-voice.md T6):
# the app's core headless (bridge/nqa.mjs start), so this checkout's changes (the voice inbox, the
# new game data) serve the game, plus the voice companion. The signed screen-reading helper comes from
# the installed NeverQuestAlone app.
#
#   powershell -ExecutionPolicy Bypass -File tools\voice\run-from-source.ps1 [-Ai openai|anthropic|proxy] [-Model <id>] [-InstallAddon] [-NoVoice] [-Persona skeleton|orc-shaman] [-Companion]
#
# -Ai openai (default) or anthropic: the app's own provider with the key from the private key file
#   (%USERPROFILE%\.config\neverquestalone\api-keys.json), passed in NQA_API_KEY for this process only.
# -Ai proxy: the subscription proxy on 127.0.0.1:8787 (it must be running), no key.
# -InstallAddon: installs this checkout's addon into WoW Forever first (WoW must be closed).
# -Persona: who the voice companion is (tools/voice/server.mjs PERSONAS); orc-shaman uses a deeper voice.
# -Companion: turns on the app's companion switch (byok.privacy.companion), which the addon needs to send
#   full game data on its own (/nqa live on) and which also allows automatic check-in turns. Off by default.
# -ShowVoice: open the voice page as a normal browser tab instead of the hidden off-screen window.
# -NoWeb: no Wowhead lookups for the voice (on by default here: only quest, item, spell or NPC ids leave the PC).
# Quit the NeverQuestAlone app first: the app and this never serve one AddOns folder at once.
param(
  [ValidateSet('openai', 'anthropic', 'proxy')] [string]$Ai = 'openai',
  [string]$Model = '',
  [switch]$InstallAddon,
  [switch]$NoVoice,
  [ValidateSet('skeleton', 'orc-shaman')] [string]$Persona = 'skeleton',
  [switch]$Companion,
  [switch]$ShowVoice,
  [switch]$NoWeb
)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$flavor = 'C:\Program Files (x86)\World of Warcraft\_forever_'
$data = Join-Path $env:APPDATA 'NeverQuestAlone\dev'
$keys = Join-Path $env:USERPROFILE '.config\neverquestalone\api-keys.json'

if (Get-Process NeverQuestAlone -ErrorAction SilentlyContinue) { throw 'Quit the NeverQuestAlone app first (tray icon > Quit).' }

# The signed capture helper, where a run from source looks for it (bridge/transport/capture.mjs WINDOWS_EXE).
$helper = Join-Path $env:LOCALAPPDATA 'Programs\neverquestalone\resources\capture\nqa-capture.exe'
$dest = Join-Path $repo 'bridge\capture\windows\build'
if (-not (Test-Path (Join-Path $dest 'nqa-capture.exe'))) {
  if (-not (Test-Path $helper)) { throw "No capture helper at $helper (install the NeverQuestAlone app, or build it: npm run capture:build)." }
  New-Item -ItemType Directory -Force $dest | Out-Null
  Copy-Item $helper $dest
}

if ($InstallAddon) {
  if (Get-Process Wow -ErrorAction SilentlyContinue) { throw 'Close World of Warcraft first: new addon files only load when it starts.' }
  & node (Join-Path $repo 'bridge\nqa.mjs') install --wow $flavor --data $data
  if ($LASTEXITCODE) { throw 'The addon install failed.' }
}

# The dev data folder's settings: which AI, game data on, identity off (the app's defaults).
New-Item -ItemType Directory -Force $data | Out-Null
$cfgFile = Join-Path $data 'config.json'
$cfg = if (Test-Path $cfgFile) { Get-Content $cfgFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$byok = [ordered]@{ auth = 'key'; effort = 'low' }
switch ($Ai) {
  'openai'    { $byok.provider = 'openai'; if ($Model) { $byok.model = $Model } }
  'anthropic' { $byok.provider = 'anthropic'; if ($Model) { $byok.model = $Model } }
  'proxy'     { $m = if ($Model) { $Model } else { 'codex:gpt-reserve' }; $byok.provider = 'custom'; $byok.model = $m; $byok.custom = [ordered]@{ baseUrl = 'http://localhost:8787/v1'; model = $m } }
}
$cfg | Add-Member -Force -NotePropertyName wow -NotePropertyValue ([ordered]@{ flavorDir = $flavor; account = '' })
# The privacy switches as the app's defaults (bridge/config.mjs), with the companion on when asked;
# a switch already saved here is kept.
$privacy = [ordered]@{ identity = $false; otherNames = $false; companion = $false; echo = $false; gameContext = $true }
if ($cfg.byok -and $cfg.byok.privacy) { foreach ($p in $cfg.byok.privacy.PSObject.Properties) { $privacy[$p.Name] = $p.Value } }
if ($Companion) { $privacy.companion = $true }
$byok.privacy = $privacy
$cfg | Add-Member -Force -NotePropertyName byok -NotePropertyValue $byok
[IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))

if ($Ai -ne 'proxy') {
  $k = (Get-Content $keys -Raw | ConvertFrom-Json).$Ai
  if (-not $k) { throw "No $Ai key in $keys." }
  $env:NQA_API_KEY = $k
}

if (-not $NoVoice) {
  $env:NQA_APP_DATA = $data
  $voiceArgs = @((Join-Path $repo 'tools\voice\server.mjs'), '--key-file', $keys, '--app-data', $data, '--persona', $Persona)
  if (-not $NoWeb) { $voiceArgs += '--web' }
  Start-Process -WindowStyle Minimized -FilePath 'node' -ArgumentList $voiceArgs
  Start-Sleep 2
  # The voice page (odd/tasks/nqa-voice-controls.md T1): a Chrome app window off screen, with a profile of
  # its own that only ever opens this page, so nothing covers the game's top-left strip and the addon's
  # buttons drive it. --use-fake-ui-for-media-stream answers the microphone prompt (that profile only
  # visits localhost:8790); autoplay lets its answers play with no click. -ShowVoice opens it normally.
  $voiceUrl = 'http://localhost:8790/?auto=1'
  $chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  $profileDir = Join-Path $data 'voice-chrome'
  $running = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profileDir) }
  if ($ShowVoice -or -not $chrome) {
    if (-not $chrome) { Write-Warning 'Chrome not found: opening the voice page in the default browser (keep it off the game''s top-left corner).' }
    Start-Process $voiceUrl
  } elseif ($running) {
    Write-Host 'The hidden voice window is already open.'
  } else {
    Start-Process -FilePath $chrome -ArgumentList @("--user-data-dir=`"$profileDir`"", "--app=$voiceUrl", '--window-position=-32000,-32000', '--window-size=480,640',
      '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check')
  }
}

& node (Join-Path $repo 'bridge\nqa.mjs') start --wow $flavor --data $data
