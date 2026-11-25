# окружение сборки нативной части Bar (Git Bash): Rust в D:/rust, MSVC и Windows SDK в D:/VSBuildTools; системный PATH не меняется
# . native/env.sh; cd native/agent; cargo build --release --offline
export RUSTUP_HOME='D:\rust\rustup' CARGO_HOME='D:\rust\cargo'
export LIB='D:\VSBuildTools\VC\Tools\MSVC\14.44.35207\lib\x64;D:\VSBuildTools\sdkx\Windows Kits\10\Lib\10.0.26100.0\um\x64;D:\VSBuildTools\sdkx\Windows Kits\10\Lib\10.0.26100.0\ucrt\x64'
export INCLUDE='D:\VSBuildTools\VC\Tools\MSVC\14.44.35207\include;D:\VSBuildTools\sdkx\Windows Kits\10\Include\10.0.26100.0\ucrt;D:\VSBuildTools\sdkx\Windows Kits\10\Include\10.0.26100.0\um;D:\VSBuildTools\sdkx\Windows Kits\10\Include\10.0.26100.0\shared;D:\VSBuildTools\sdkx\Windows Kits\10\Include\10.0.26100.0\winrt'
export PATH="/d/VSBuildTools/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64:/d/VSBuildTools/sdkx/Windows Kits/10/bin/10.0.26100.0/x64:/d/rust/cargo/bin:$PATH"
