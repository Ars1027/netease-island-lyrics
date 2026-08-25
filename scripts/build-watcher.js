const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(projectRoot, 'native-watcher', 'Watcher.cs');
const outputPath = path.join(projectRoot, 'assets', 'NeteaseIslandWatcher.exe');
const compilerCandidates = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];
const compilerPath = compilerCandidates.find((candidate) => fs.existsSync(candidate));

if (!compilerPath) throw new Error('未找到 .NET Framework C# 编译器');
if (!fs.existsSync(sourcePath)) throw new Error(`监听器源码不存在：${sourcePath}`);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const result = spawnSync(compilerPath, [
  '/nologo',
  '/warn:4',
  '/target:winexe',
  '/optimize+',
  '/platform:anycpu',
  `/out:${outputPath}`,
  '/reference:System.Management.dll',
  sourcePath,
], {
  cwd: projectRoot,
  encoding: 'utf8',
  windowsHide: true,
});

if (result.status !== 0) {
  process.stderr.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status || 1);
}

console.log(`Built watcher: ${outputPath}`);
