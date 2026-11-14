# Local SMTC module

Upstream: https://github.com/LeagueTavern/node-windows-smtc-monitor
Revision: `0e8b27a6ed739419881902b5e3e0fa751ee765ef` (npm 1.0.12), MIT.

The JavaScript API and native event interface are unchanged. The thumbnail reader
now reads the declared stream length in chunks instead of returning only the
first 1 MiB. A premature EOF or read failure discards the partial thumbnail while
preserving the other media properties.

Run `npm run smtc` before running or packaging the app. This builds and tests the
Windows x64 N-API module, then copies it to the installed local dependency.
Rust and MSVC libraries are build-time requirements only. The build also supports
Rust's bundled LLD linker with an xwin SDK cached at `.cache/native-tools/sdk`.
`SMTC_MSVC_LIB_PATH` can provide an alternate semicolon-separated library path.
No SDK, compiler or auxiliary runtime process is shipped with the application.
