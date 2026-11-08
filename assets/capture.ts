// Rebuilds media/preview.png and .claude-plugin/icon.png from the real drawings.
// Usage: bun assets/capture.ts <path-to-msedge.exe> <empty temp folder>
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { BG, TEXT, bandSvg, critterSvg, iconSvg } from '../hooks/art'

const [edge, temp] = process.argv.slice(2)
if (!edge || !temp) throw new Error('usage: capture.ts <msedge> <temp>')
mkdirSync(temp, { recursive: true })

const shoot = async (html: string, out: string, width: number, height: number) => {
  const page = join(temp, 'page.html')
  writeFileSync(page, html)
  const run = Bun.spawn([edge, '--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${width},${height}`, `--user-data-dir=${join(temp, 'profile')}`, `--screenshot=${resolve(out)}`, `file:///${resolve(page).replace(/\\/g, '/')}`])
  if ((await run.exited) !== 0) throw new Error(`edge failed for ${out}`)
}

const kinds = ['codex', 'agy', 'claude', 'shell'] as const
const states = ['running', 'done', 'failed', 'cancelled'] as const
const cells = kinds
  // Each cell wears another look, as neighbouring runs of one kind do in the pane.
  .map(kind => `<tr><td>${kind}</td>${states.map((state, i) => `<td>${iconSvg(kind, state, i * 3 + 1).source}</td>`).join('')}</tr>`)
  .join('')
await shoot(
  `<!doctype html><body style="margin:0;background:${BG};color:${TEXT};font:13px system-ui;padding:12px"><div>${bandSvg({ codex: 2, agy: 1, claude: 3, shell: 1 })?.source}</div>` +
    `<table style="margin-top:10px;border-spacing:14px 6px"><tr><td></td>${states.map(s => `<td>${s}</td>`).join('')}</tr>${cells}</table></body>`,
  'media/preview.png',
  470,
  290,
)
await shoot(
  `<!doctype html><body style="margin:0;background:${BG};display:grid;place-items:center;height:100vh"><div style="zoom:11">${critterSvg('agy', 'running', 0, 2, true).source}</div></body>`,
  '.claude-plugin/icon.png',
  512,
  512,
)
