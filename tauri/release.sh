# Релизная сборка Bar (Tauri): exe с папкой данных «Bar», установщик NSIS и latest.yml для обновления.
# Запуск: bash tauri/release.sh <версия>   → dist/Bar-Setup-<версия>.exe и dist/latest.yml
# Обновление из Electron-версии работает так же: она скачивает установщик из latest.yml, сверяет SHA-512 и запускает его.
set -e
cd "$(dirname "$0")/.."
VER="$1"; [ -n "$VER" ] || { echo "нужна версия"; exit 1; }
# имя, идентификатор и версия релиза — поверх tauri.conf.json (в нём настройки тестовой сборки Lab)
export TAURI_CONFIG="{\"productName\":\"Bar\",\"identifier\":\"app.bar.notch\",\"version\":\"$VER\"}"
BAR_DATA="Bar" bash tauri/build.sh
mkdir -p dist
w() { cygpath -wa "$1"; }   # NSIS понимает только пути Windows
MAKENSIS="$(ls -d "$LOCALAPPDATA"/electron-builder/Cache/nsis-3.0.4.1/*/makensis.exe | head -1)"
"$MAKENSIS" -V2 -DEXE="$(w native/target/release/bar-tauri.exe)" -DVER="$VER" -DOUT="$(w "dist/Bar-Setup-$VER.exe")" -DPM="$(w vendor/presentmon)" -DICON="$(w tauri/icons/icon.ico)" "$(w tauri/installer.nsi)"
VER="$VER" node -e "
const fs=require('fs'),c=require('crypto');const v=process.env.VER;const name='Bar-Setup-'+v+'.exe';const b=fs.readFileSync('dist/'+name);
const sha=c.createHash('sha512').update(b).digest('base64');
fs.writeFileSync('dist/latest.yml',['version: '+v,'files:','  - url: '+name,'    sha512: '+sha,'    size: '+b.length,'path: '+name,'sha512: '+sha,\"releaseDate: '\"+new Date().toISOString()+\"'\",''].join('\n'));
console.log(name, (b.length/1048576).toFixed(1)+' МБ')"
# проверка обновления «прошлый релиз → этот» (как кнопка «Скачать»); провал — релиз не выпускать. SKIP_UPDATE_CHECK=1 — пропустить
[ -n "$SKIP_UPDATE_CHECK" ] || powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/update-check.ps1 -Version "$VER"
