const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'vendor/windows-smtc-monitor');
const cargo = process.env.CARGO || path.join(os.homedir(), '.cargo/bin/cargo.exe');
const rustc = path.join(path.dirname(cargo), 'rustc.exe');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: source, windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
  return result;
}
const env = { ...process.env };
const sdk = path.join(root, '.cache/native-tools/sdk');
const libraryPaths = [
  path.join(sdk, 'crt/lib/x86_64'),
  path.join(sdk, 'sdk/lib/um/x86_64'),
  path.join(sdk, 'sdk/lib/ucrt/x86_64'),
];
if (env.SMTC_MSVC_LIB_PATH || libraryPaths.every(p => fs.existsSync(p))) {
  const sysroot = run(rustc, ['--print', 'sysroot'], { encoding: 'utf8' }).stdout.trim();
  const linker = path.join(sysroot, 'lib/rustlib/x86_64-pc-windows-msvc/bin/rust-lld.exe');
  if (!fs.existsSync(linker)) throw new Error('Rust LLD linker is missing');
  env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = linker;
  env.LIB = [env.SMTC_MSVC_LIB_PATH || libraryPaths.join(';'), env.LIB].filter(Boolean).join(';');
}
// Test the stream reader as a standalone executable, without a Node host.
fs.mkdirSync(path.join(source, 'target'), { recursive: true });
const testBinary = path.join(source, 'target/thumbnail-reader-tests.exe');
const testArgs = ['--edition=2021', '--test', 'src/thumbnail_reader.rs', '-o', testBinary];
if (env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER) {
  testArgs.push('-C', `linker=${env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER}`);
}
run(rustc, testArgs, { env, stdio: 'inherit' });
run(testBinary, [], { env, stdio: 'inherit' });
// No --target: build scripts and proc macros need the same native linker paths.
run(cargo, ['build', '--locked', '--release'], { env, stdio: 'inherit' });
const binary = 'windows-smtc-monitor.win32-x64-msvc.node';
const built = path.join(source, 'target/release/win_smtc_monitor.dll');
if (!fs.existsSync(built)) throw new Error('Built SMTC module is missing');
const installed = path.join(root, 'node_modules/@coooookies/windows-smtc-monitor');
if (!fs.existsSync(installed)) throw new Error('Run npm install --install-links first');
fs.copyFileSync(built, path.join(source, binary));
fs.copyFileSync(built, path.join(installed, binary));
fs.copyFileSync(path.join(source, 'binding.js'), path.join(installed, 'binding.js'));
console.log(`Built and installed full-stream SMTC module: ${built}`);
