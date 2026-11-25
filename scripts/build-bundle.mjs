// Build the Claude Desktop extension (.mcpb) and the skill zip.
//   node scripts/build-bundle.mjs
// Output: dist/capcut-mcp.mcpb  (double-click to install in Claude Desktop)
//         dist/capcut-reels-skill.zip  (Claude Desktop → Customize → Skills → Upload)
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

// 1. keep manifest.tools + version in sync with the real server
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const client = new Client({ name: 'build', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/server.js')], stderr: 'ignore' }));
const { tools } = await client.listTools();
await client.close();
manifest.version = pkg.version;
manifest.tools = tools.map(t => ({ name: t.name, description: t.description.split(/(?<=\.)\s+(?=[A-ZÈ])/)[0].slice(0, 220) }));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest: v${manifest.version}, ${manifest.tools.length} tools`);

// 2. pack the bundle (production deps only are installed in this repo)
const out = path.join(dist, 'capcut-mcp.mcpb');
execSync(`npx -y @anthropic-ai/mcpb@2.1.2 pack "${root}" "${out}"`, { stdio: 'inherit', cwd: root });

// 3. skill zip: <skill>/SKILL.md at the top level
const zip = path.join(dist, 'capcut-reels-skill.zip');
fs.rmSync(zip, { force: true });
if (process.platform === 'win32') {
  // Windows' bsdtar writes "/" separators (PowerShell 5.1 Compress-Archive writes "\", which uploads reject)
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  execSync(`"${tar}" -a -c -f "${zip}" -C "${path.join(root, 'skills')}" capcut-reels`, { stdio: 'inherit' });
} else {
  execSync(`cd "${path.join(root, 'skills')}" && zip -r "${zip}" capcut-reels`, { stdio: 'inherit' });
}
console.log(`\nfatto:\n  ${out}\n  ${zip}`);
