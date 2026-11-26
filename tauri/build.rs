fn main() {
    // папка данных (BAR_DATA) задаётся при сборке: релиз — «Bar», тестовая сборка Lab — «Bar Tauri»
    println!("cargo:rerun-if-env-changed=BAR_DATA");
    tauri_build::build()
}
