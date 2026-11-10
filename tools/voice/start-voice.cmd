@echo off
rem Starts the NeverQuestAlone voice companion (tools/voice/server.mjs) and opens its page.
rem The OpenAI key comes from %OPENAI_API_KEY%, else from the private key file below.
rem Extra arguments go to the server, for example:  start-voice.cmd --web --voice cedar
setlocal
set "KEYFILE=%USERPROFILE%\.config\neverquestalone\api-keys.json"
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:8790/"
node "%~dp0server.mjs" --key-file "%KEYFILE%" %*
