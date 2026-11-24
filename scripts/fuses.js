// Включает «предохранители» Electron в исполняемом файле (после каждой установки зависимостей).
// EnableCookieEncryption — cookie (в т.ч. вход в Google для музыки) шифруются средствами Windows, как в Chrome.
// Остальные — закрывают способы выполнить чужой код через Bar.
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options, getCurrentFuseWire } = require('@electron/fuses');

const exe = path.join(path.dirname(require.resolve('electron')), 'dist', 'electron.exe');

(async () => {
  await flipFuses(exe, {
    version: FuseVersion.V1,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  });
  const wire = await getCurrentFuseWire(exe);
  const names = Object.keys(FuseV1Options).filter((k) => isNaN(+k));
  for (const n of names) console.log(n.padEnd(42), wire[FuseV1Options[n]] === 49 || wire[FuseV1Options[n]] === '1' ? 'on' : String.fromCharCode(wire[FuseV1Options[n]]) === '1' ? 'on' : 'off');
})().catch((e) => { console.error('fuses:', e.message); process.exit(1); });
