@echo off
REM scripts/wao-cli.cmd
REM Worker-side WAO CLI entry point (TD-90 fix).
REM Points WAO_CLI at this .cmd so workers get v22 node automatically,
REM instead of bare src/cli.js which hits the v24 guard (dogfood r7).
REM v22 resolution mirrors scripts/wao-node.cjs: WAO_NODE env, then system v22.

setlocal
if defined WAO_NODE (
  set "V22=%WAO_NODE%"
) else (
  set "V22=%LOCALAPPDATA%\Programs\nodejs-v22\node.exe"
)
if not exist "%V22%" (
  echo WAO requires Node v22, not found: %V22% 1>&2
  echo Install Node v22 or set WAO_NODE env to v22 node.exe path 1>&2
  exit /b 127
)
"%V22%" "%~dp0..\src\cli.js" %*
