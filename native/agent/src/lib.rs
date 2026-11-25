// Bar: нативная часть для Windows на Rust — звук, окна, устройства, сеть, музыка, OCR (PowerShell не используется).
// Библиотека: Core — все команды; events — фоновые режимы (уровень звука, события окон).
pub mod events;
mod hid;
pub mod img;
pub mod sys;
mod tools;
pub mod win;
mod core;
pub use crate::core::{Core, CMDS};
