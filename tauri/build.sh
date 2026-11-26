# Сборка Bar на Tauri без скачиваний: окружение MSVC/SDK с диска D, локальный кэш crates.
# Запуск: bash tauri/build.sh (из корня Bar Lab). Готовый файл: native/target/release/bar-tauri.exe
cd "$(dirname "$0")/.." || exit 1
node tauri/make-ui.js || exit 1
. native/env.sh
export CARGO_TARGET_DIR="$(cd native && pwd -W 2>/dev/null || pwd)/target"
export BAR_DATA="${BAR_DATA-Bar Tauri}" # тестовая сборка Lab — своя папка данных
cd tauri && cargo build --release --offline "$@"
