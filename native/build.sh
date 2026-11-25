# Сборка нативного агента Bar (Rust) без скачиваний: окружение MSVC/SDK с диска D и локальный кэш crates.
# Запуск: bash native/build.sh   (из корня Bar Lab). Готовый файл: native/target/release/bar-agent.exe
cd "$(dirname "$0")/.." || exit 1
. native/env.sh
export CARGO_TARGET_DIR="$(cd native && pwd -W 2>/dev/null || pwd)/target"
cd native/agent && cargo build --release --offline "$@"
