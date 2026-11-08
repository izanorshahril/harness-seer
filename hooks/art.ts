// The drawings. Pure: each function returns an SVG string for Svg.
// Motion is CSS only, so a reduced-motion setting stops all of it.
// The characters are drawn here for this mod in the style of cache-seer's mascot; none is a vendor's mascot or logo.

import { ADVANCE, FONT } from './font'
import type { Kind, RunState } from '../types'

export const BG = '#24221c'
export const TEXT = '#e8e2d2'
export const MUTED = '#8d8775'
export const EMPTY = '#4a463b'

export const KIND_HUE: Readonly<Record<Kind, string>> = {
  codex: '#4eba65',
  agy: '#6ea8ff',
  claude: '#ff8a4c',
  shell: '#b9a7e8',
}

export const STATE_HUE: Readonly<Record<RunState, string>> = {
  running: '#f5b342',
  done: '#4eba65',
  failed: '#ff5f5f',
  cancelled: '#8d8775',
  lost: '#ff8a4c',
}

/** Usage tones, the same as cache-seer's, so the two mods colour a window alike. */
export const TONE: Readonly<Record<'ok' | 'watch' | 'high' | 'critical', string>> = {
  ok: '#6ea8ff',
  watch: '#f5b342',
  high: '#ff8a4c',
  critical: '#ff5f5f',
}

export type Drawing = { source: string; width: number; height: number }

const STILL = '@media (prefers-reduced-motion:reduce){*{animation:none!important}}'

const doc = (width: number, height: number, css: string, body: string, hasFont = false) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>` +
  (hasFont
    ? `@font-face{font-family:RK;font-weight:400 700;src:url(data:font/woff2;base64,${FONT}) format('woff2')}` +
      `text{font-family:RK,'Segoe UI',system-ui,sans-serif}`
    : '') +
  css +
  STILL +
  `</style>${body}</svg>`

// ---------- The crew ----------
// One pixel character a kind. Each run of a kind gets its own look (a hat and a coat),
// so two Codex runs side by side are told apart at a glance.

type Palette = Readonly<Record<string, string>>

/** One coat a kind, so a harness is always the same colour; runs differ by what they wear. */
const COATS: Readonly<Record<Kind, Palette>> = {
  codex: { H: '#9fe0ad', B: '#4eba65', S: '#2f8a45', D: '#1d5a2c', K: '#10241a', G: '#c8ffd4' },
  agy: { H: '#c2d9ff', B: '#6ea8ff', S: '#3f78d6', D: '#28508f', V: '#152238', W: '#e8f1ff' },
  claude: { H: '#f0a285', B: '#d97757', S: '#b95d3f', D: '#8c452e', E: '#22140e', C: '#ee9c84' },
  shell: { H: '#ddd3f7', B: '#b9a7e8', S: '#8b77c4', D: '#5e4e8f', E: '#1d1729' },
}

type Body = { rows: readonly string[]; x: number; y: number; eyes: readonly [number, number]; eyeRow: number; lid: string }

// Bodies on a 20 by 18 grid; the hat takes the rows above each.
const BODY: Readonly<Record<Kind, Body>> = {
  // A little CRT on two feet: a dim screen with two eyes and a cursor for a mouth.
  codex: {
    x: 2,
    y: 4,
    eyes: [6, 12],
    eyeRow: 7,
    lid: 'K',
    rows: [
      '.HHHHHHHHHHHHHH.',
      'HBBBBBBBBBBBBBBS',
      'HBKKKKKKKKKKKKBS',
      'HBKKGGKKKKGGKKBS',
      'HBKKGGKKKKGGKKBS',
      'HBKKKKKKKKKKKKBS',
      'HBKKKKKKKKKKKKBS',
      'HBBBBBBBBBBBBBBS',
      '.SSSSSSSSSSSSSS.',
      '...DD......DD...',
    ],
  },
  // A round hoverer with a visor; it has no feet and floats on a thruster.
  agy: {
    x: 2,
    y: 4,
    eyes: [7, 11],
    eyeRow: 8,
    lid: 'V',
    rows: [
      '.....HHHHHH.....',
      '...HHBBBBBBSS...',
      '..HBBBBBBBBBBS..',
      '.HBBVVVVVVVVBBS.',
      '.HBVVWWVVWWVVBS.',
      '.HBVVWWVVWWVVBS.',
      '.HBBVVVVVVVVBBS.',
      '..HBBBBBBBBBBS..',
      '...SBBBBBBBBS...',
      '....SSSSSSSS....',
      '......DDDD......',
    ],
  },
  // cache-seer's critter, so the two mods share a cast.
  claude: {
    x: 3,
    y: 4,
    eyes: [6, 13],
    eyeRow: 7,
    lid: 'B',
    rows: [
      '.HHHHHHHHHHHH.',
      'HHBBBBBBBBBBBS',
      'HBBBBBBBBBBBBS',
      'HBBEEBBBBBBEES',
      'HBBEEBBBBBBEES',
      'HBBBBBBBBBBBSS',
      'HBCCBBBBBBCCBS',
      'HBBBBBDDBBBBSS',
      'BBBBBBBBBBBSSS',
      '.SSSSSSSSSSSS.',
      '.SD.SD...SD.SD',
    ],
  },
  // A crate with a face, on two feet.
  shell: {
    x: 3,
    y: 5,
    eyes: [6, 12],
    eyeRow: 8,
    lid: 'B',
    rows: [
      'HHHHHHHHHHHHHH',
      'HBDBBBBBBBBDBS',
      'HBBBBBBBBBBBBS',
      'HBBEEBBBBEEBBS',
      'HBBEEBBBBEEBBS',
      'HBBBBBBBBBBBBS',
      'HBBBBDDDDBBBBS',
      'SSSSSSSSSSSSSS',
      '..SD......SD..',
    ],
  },
}

// Hats, 14 columns wide from column 3, sitting on the body's top row. Their inks are their own,
// in three sets, so the same hat comes in three colourways.
const HAT_INKS: readonly Palette[] = [
  { y: '#f5c542', Y: '#c99a1f', w: '#f2efe6', r: '#e8574b', R: '#a8392f', g: '#53c26b', b: '#4f8df5', k: '#2b2a26', p: '#ff8ac0', o: '#ffd27a', s: '#9a9488' },
  { y: '#ff9f43', Y: '#c46f1c', w: '#2b2a26', r: '#4f8df5', R: '#2f5fb0', g: '#e8574b', b: '#f5c542', k: '#f2efe6', p: '#9a86f0', o: '#f2efe6', s: '#c9c3b3' },
  { y: '#e8e2d2', Y: '#a8a290', w: '#e8574b', r: '#2b2a26', R: '#111111', g: '#f5c542', b: '#e8574b', k: '#4f8df5', p: '#53c26b', o: '#ff8ac0', s: '#6f6a5c' },
]
const HATS: readonly { rows: readonly string[]; cls?: string }[] = [
  // A small crown.
  { rows: ['....y..y..y...', '....yyyyyyy...', '....yYyyyYy...'] },
  // A hard hat.
  { rows: ['....yyyyyy....', '...yyyYyyyyy..', '.yyyyyyyyyyyyY'] },
  // A cap with its brim to the right.
  { rows: ['.....rrrrr....', '....rrrrrrr...', '....rRrrrrrwww'] },
  // A beanie with a bobble.
  { rows: ['......oo......', '....bbbbbb....', '...bbbbbbbb...', '...wwwwwwww...'] },
  // A propeller cap that spins while the run works.
  { rows: ['....kkskk.....', '......s.......', '....gggggg....', '...gggggggg...'], cls: 'prop' },
  // A little flag on a pole.
  { rows: ['..........rrr.', '..........rrR.', '..........s...', '..........s...'], cls: 'flag' },
  // A bow.
  { rows: ['....pp..pp....', '.....pppp.....', '....pp..pp....'] },
  // An antenna with a light.
  { rows: ['.......o......', '.......s......', '.......s......', '......sss.....'], cls: 'bulb' },
]

/** One path per colour: separate rects at fractional sizes leave seams. */
const pixels = (rows: readonly string[], palette: Palette, ox: number, oy: number): string => {
  const paths = new Map<string, string>()
  rows.forEach((row, y) => {
    ;[...row].forEach((ch, x) => {
      if (palette[ch]) paths.set(ch, `${paths.get(ch) ?? ''}M${ox + x} ${oy + y}h1v1h-1z`)
    })
  })
  return [...paths].map(([ch, d]) => `<path d="${d}" fill="${palette[ch]}"/>`).join('')
}

/** How many distinct looks a kind has: every hat in every colourway. */
export const LOOKS = HATS.length * 3

const CREW_CSS =
  '.fig,.hat,.prop,.flag,.flame,.cur,.bulb{transform-box:fill-box;transform-origin:center}' +
  '.lids{opacity:0;animation:blink 4.2s steps(1) infinite}@keyframes blink{0%,91%,100%{opacity:0}92%,96%{opacity:1}}' +
  '.prop{animation:prop .5s linear infinite}@keyframes prop{50%{transform:scaleX(.2)}}' +
  '.flag{transform-origin:left center;animation:flag 1s ease-in-out infinite}@keyframes flag{50%{transform:skewY(-8deg)}}' +
  '.bulb{animation:bulb 1.4s steps(2) infinite}@keyframes bulb{50%{opacity:.45}}'

const MOTION: Readonly<Record<Kind, string>> = {
  codex:
    '.fig{animation:bob 1.6s ease-in-out infinite}@keyframes bob{50%{transform:translateY(-.8px)}}' +
    '.cur{animation:cur 1s steps(2) infinite}@keyframes cur{50%{opacity:0}}',
  agy:
    '.fig{animation:hover 2.4s ease-in-out infinite}@keyframes hover{50%{transform:translateY(-1.6px)}}' +
    '.flame{animation:flame .32s steps(2) infinite}@keyframes flame{50%{transform:scaleY(.55)}}',
  claude:
    '.fig{animation:walk .9s ease-in-out infinite}@keyframes walk{25%{transform:translate(.4px,-.7px)}75%{transform:translate(-.4px,-.7px)}}',
  shell: '.fig{animation:hop 1.2s ease-in-out infinite}@keyframes hop{0%,60%,100%{transform:none}30%{transform:translateY(-1.4px)}}',
}

const GRID = { width: 20, height: 18 }

const badge = (state: RunState) => {
  if (state === 'running') return ''
  const hue = STATE_HUE[state]
  const mark =
    state === 'done'
      ? '<path d="M15.5 15.2l1 1 1.8-1.9" fill="none" stroke="#17150f" stroke-width=".9" stroke-linecap="round" stroke-linejoin="round"/>'
      : state === 'failed'
        ? '<path d="M15.8 14.4l1.9 1.9m0-1.9l-1.9 1.9" stroke="#17150f" stroke-width=".9" stroke-linecap="round"/>'
        : '<path d="M15.6 15.3h2.4" stroke="#17150f" stroke-width=".9" stroke-linecap="round"/>'
  return `<circle cx="16.8" cy="15.3" r="2.7" fill="${hue}" stroke="${BG}" stroke-width=".6"/>${mark}`
}

/** Which hat and colourway a look number picks: hats first, so neighbouring runs differ most. */
export const lookParts = (look: number) => {
  const n = ((Math.floor(look) % LOOKS) + LOOKS) % LOOKS
  return { hat: n % HATS.length, ink: Math.floor(n / HATS.length) % HAT_INKS.length }
}

/** The body, hat and extras of one look, and its motion while it runs. */
const crew = (kind: Kind, look: number, live: boolean) => {
  const parts = lookParts(look)
  const hat = HATS[parts.hat] ?? { rows: [] }
  const coat = COATS[kind]
  const body = BODY[kind]
  const hatY = body.y - hat.rows.length + (kind === 'agy' ? 1 : 0)
  let art = pixels(body.rows, coat, body.x, body.y)
  if (kind === 'codex') art += `<path class="cur" d="M8 ${body.y + 6}h4v1h-4z" fill="${coat.G}"/>`
  if (kind === 'agy') art += `<path class="flame" d="M8 ${body.y + 11}h4v1h-1v1h-2v-1h-1z" fill="#ffb347"/>`
  // Eyelids that blink shut over the open eyes now and then.
  const [left, right] = body.eyes
  const lids = `<path class="lids" d="M${left} ${body.eyeRow}h2v1h-2zM${right} ${body.eyeRow}h2v1h-2z" fill="${coat[body.lid]}"/>`
  const hatArt = hat.rows.length > 0 ? `<g class="hat${hat.cls ? ` ${hat.cls}` : ''}">${pixels(hat.rows, HAT_INKS[parts.ink] ?? HAT_INKS[0] ?? {}, 3, hatY)}</g>` : ''
  return {
    css: live ? CREW_CSS + MOTION[kind] : '',
    body: `<g class="fig" shape-rendering="crispEdges">${art}${live ? lids : ''}${hatArt}</g>`,
  }
}

/** A run's character: its kind's body in its own look, moving while it runs (unless held still), badged once it ends. */
export const critterSvg = (kind: Kind, state: RunState, look = 0, scale = 2, still = false): Drawing => {
  // `still` holds a running character's first frame, so a long list does not all move at once.
  const live = state === 'running' && !still
  const { css, body } = crew(kind, look, live)
  const dim = state === 'cancelled' || state === 'lost' ? ' opacity=".55"' : ''
  const shadow = `<ellipse cx="10" cy="17.3" rx="${kind === 'agy' ? 4 : 6.5}" ry=".6" fill="#000" opacity=".35"/>`
  const width = Math.round(GRID.width * scale)
  const height = Math.round(GRID.height * scale)
  return {
    source: doc(width, height, css, `<g transform="scale(${scale})">${shadow}<g${dim}>${body}</g>${badge(state)}</g>`),
    width,
    height,
  }
}

/** The pane's icon for a run: its character in its look. */
export const iconSvg = (kind: Kind, state: RunState, look = 0): Drawing => critterSvg(kind, state, look)

const widthOf = (text: string, size: number) => [...text].reduce((sum, ch) => sum + (ADVANCE[ch] ?? 0.6) * size, 0)

const NAME: Readonly<Record<Kind, string>> = { codex: 'CODEX', agy: 'AGY', claude: 'AGENTS', shell: 'TASKS' }

/** The band: each kind that is running, with its live character and count. */
export const bandSvg = (counts: Partial<Record<Kind, number>>): Drawing | null => {
  const height = 26
  let x = 2
  let css = ''
  let body = ''
  for (const kind of ['codex', 'agy', 'claude', 'shell'] as const) {
    const count = counts[kind]
    if (!count) continue
    const art = crew(kind, 0, true)
    // The characters share class names, so each kind's motion is scoped to its own group.
    css += art.css.replace(/\.(fig|cur|flame|lids|hat|prop|flag|bulb)\b/g, `.${kind} .$1`)
    body += `<g class="${kind}" transform="translate(${x} 1.5) scale(1.25)">${art.body}</g>`
    x += 27
    const name = NAME[kind]
    body += `<text x="${x}" y="17" font-size="11" font-weight="600" letter-spacing=".4" fill="${MUTED}">${name}</text>`
    x += widthOf(name, 11) + name.length * 0.4 + 5
    body += `<text x="${x.toFixed(1)}" y="17.5" font-size="13" font-weight="700" fill="${KIND_HUE[kind]}">${count}</text>`
    x += widthOf(String(count), 13) + 14
  }
  if (!body) return null
  const width = Math.ceil(x)
  return { source: doc(width, height, css, body, true), width, height }
}
