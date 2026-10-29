import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ElementRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowRight,
  Camera,
  Check,
  Download,
  Hand,
  Plus,
  RotateCcw,
  Scissors,
  Share2,
  Utensils,
  Volume2,
  VolumeX,
} from 'lucide-react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { ContactShadows, OrbitControls } from '@react-three/drei'

/* ════════════════════════════════════════════════════════════════════════
 * 1. State machine
 *   upload → processing → filling → coating → wrapping → shaping → play → done
 * ════════════════════════════════════════════════════════════════════════ */

type Phase = 'upload' | 'processing' | 'filling' | 'coating' | 'wrapping' | 'shaping' | 'play' | 'done'
type Mode = 'squish' | 'bite'
type Anko = 'red' | 'white'

/** 누끼가 따진 피사체 */
type Subject = {
  cutout: HTMLCanvasElement // bbox로 잘라낸 투명 배경 이미지
  ox: number // 무게중심 (cutout px)
  oy: number
  scale: number // 3D 단위 / px
  radii: Float32Array // 무게중심 기준 외곽선 반지름 (3D 단위, 이미지 좌표계 각도)
  alphaAt: (u: number, v: number) => number // 레이캐스트용 알파 조회 (0..255)
  cut: boolean
}

type State = {
  session: number // 다시 만들기마다 증가 → 3D 씬 전체를 새로 마운트
  phase: Phase
  loadMsg: string
  subject: Subject | null
  alt: Subject | null
  anko: Anko
  cover: number
  roll: number
  mode: Mode
  bites: number
  remaining: number
  result: string | null
}

type Action =
  | { type: 'PROCESS_START' }
  | { type: 'PROCESS_MSG'; msg: string }
  | { type: 'SUBJECT_READY'; subject: Subject; alt: Subject | null }
  | { type: 'PROCESS_FAILED' }
  | { type: 'TOGGLE_CUTOUT' }
  | { type: 'START_COAT' }
  | { type: 'SET_ANKO'; anko: Anko }
  | { type: 'START_WRAP' }
  | { type: 'SET_COVER'; cover: number }
  | { type: 'WRAPPED' }
  | { type: 'SET_ROLL'; value: number }
  | { type: 'SHAPED' }
  | { type: 'SET_MODE'; mode: Mode }
  | { type: 'BITE'; remaining: number }
  | { type: 'DONE'; result: string }
  | { type: 'RESET' }

const initialState: State = {
  session: 0,
  phase: 'upload',
  loadMsg: '',
  subject: null,
  alt: null,
  anko: 'red',
  cover: 0,
  roll: 0,
  mode: 'squish',
  bites: 0,
  remaining: 1,
  result: null,
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'PROCESS_START':
      return s.phase === 'upload' ? { ...s, phase: 'processing', loadMsg: '이미지를 읽는 중' } : s
    case 'PROCESS_MSG':
      return s.phase === 'processing' ? { ...s, loadMsg: a.msg } : s
    case 'SUBJECT_READY':
      return s.phase === 'processing' ? { ...s, phase: 'filling', subject: a.subject, alt: a.alt } : s
    case 'PROCESS_FAILED':
      return s.phase === 'processing' ? { ...initialState, session: s.session } : s
    case 'TOGGLE_CUTOUT':
      return s.phase === 'filling' && s.alt ? { ...s, subject: s.alt, alt: s.subject } : s
    case 'START_COAT':
      return s.phase === 'filling' ? { ...s, phase: 'coating' } : s
    case 'SET_ANKO':
      return s.phase === 'coating' ? { ...s, anko: a.anko } : s
    case 'START_WRAP':
      return s.phase === 'coating' ? { ...s, phase: 'wrapping', cover: 0 } : s
    case 'SET_COVER':
      return s.phase === 'wrapping' ? { ...s, cover: a.cover } : s
    case 'WRAPPED':
      return s.phase === 'wrapping' ? { ...s, phase: 'shaping', roll: 0 } : s
    case 'SET_ROLL':
      return s.phase === 'shaping' ? { ...s, roll: clamp(a.value, 0, 1) } : s
    case 'SHAPED':
      return s.phase === 'shaping' ? { ...s, phase: 'play', mode: 'squish', remaining: 1, bites: 0 } : s
    case 'SET_MODE':
      return s.phase === 'play' ? { ...s, mode: a.mode } : s
    case 'BITE':
      return s.phase === 'play' ? { ...s, bites: s.bites + 1, remaining: a.remaining } : s
    case 'DONE':
      return s.phase === 'play' ? { ...s, phase: 'done', result: a.result } : s
    case 'RESET':
      // 이미지·결과·진행도 전부 비우고 세션을 올려 3D 메시/머티리얼까지 새로 만든다
      return { ...initialState, session: s.session + 1 }
  }
}

const STEPS = ['피사체', '앙금', '감싸기', '빚기', '맛보기'] as const
const stepIndex = (p: Phase) =>
  p === 'upload' || p === 'processing' || p === 'filling' ? 0 : p === 'coating' ? 1 : p === 'wrapping' ? 2 : p === 'shaping' ? 3 : 4

/* ════════════════════════════════════════════════════════════════════════
 * 2. Math & shape constants  (3D 단위: 모찌 반지름 ≈ 1, y가 위)
 * ════════════════════════════════════════════════════════════════════════ */

const TAU = Math.PI * 2
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const gauss = (d: number, w: number) => Math.exp(-(d * d) / (2 * w * w))
const angDiff = (a: number, b: number) => {
  const d = (((a - b) % TAU) + TAU) % TAU
  return d > Math.PI ? TAU - d : d
}
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

const RX = 1 // 모찌 가로 반지름
const TOP_Y = 0.9 // 돔 높이
const BOTTOM_Y = 0.8 // 중력으로 퍼진 바닥까지
const FLOOR_Y = -BOTTOM_Y
const CORE_Y = -0.02
const COAT = 0.07 // 앙금 코팅 두께
const GRAB_RHO = 0.42 // 이보다 바깥(앙금 발밑을 벗어난 시트)만 잡아 늘릴 수 있음
const SHEET_R = 1.75 // 바닥에 평평하게 펴 둔 반죽 시트의 반지름
const SIL_N = 72
const BITE_R = 0.46
const BITE_TEX = 512 // 저장 가능한 베어문 자국 수 (사실상 무제한)
const TARGET = new THREE.Vector3(0, -0.12, 0)

/** 닫힌 모찌 표면: 위는 돔, 아래는 펑퍼짐하게 퍼진 바닥 */
function mochiShape(dx: number, dy: number, dz: number): [number, number, number] {
  const widen = 1 + 0.08 * Math.max(0, -dy)
  const y = dy >= 0 ? dy * TOP_Y : -BOTTOM_Y * Math.pow(-dy, 0.75)
  return [dx * RX * widen, y, dz * RX * widen]
}

function hash3(x: number, y: number, z: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453
  return s - Math.floor(s)
}
function noise3(x: number, y: number, z: number) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)
  const xf = x - xi
  const yf = y - yi
  const zf = z - zi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const w = zf * zf * (3 - 2 * zf)
  const l = (a: number, b: number, t: number) => a + (b - a) * t
  return l(
    l(l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
    l(
      l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u),
      l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u),
      v,
    ),
    w,
  )
}

/* ════════════════════════════════════════════════════════════════════════
 * 3. AI 누끼 — RMBG-1.4 (Transformers.js) 를 Web Worker에서 실행
 * ════════════════════════════════════════════════════════════════════════ */

let segWorker: Worker | null = null
let segSeq = 0

function runSegmentation(photo: HTMLCanvasElement, onMsg: (m: string) => void): Promise<Uint8Array> {
  segWorker ??= new Worker(new URL('./segment.worker.ts', import.meta.url), { type: 'module' })
  const worker = segWorker
  const id = ++segSeq
  const data = photo.getContext('2d')!.getImageData(0, 0, photo.width, photo.height).data
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      worker.removeEventListener('message', onMessage)
      reject(new Error('timeout'))
    }, 180_000)
    function onMessage(e: MessageEvent) {
      const m = e.data as { type: string; id?: number; percent?: number; mask?: Uint8Array; message?: string }
      if (m.type === 'progress') onMsg(`AI 모델을 불러오는 중 ${Math.round(m.percent ?? 0)}%`)
      if (m.id !== id) return
      if (m.type === 'running') onMsg('피사체를 오려내는 중')
      if (m.type === 'result' || m.type === 'error') {
        window.clearTimeout(timer)
        worker.removeEventListener('message', onMessage)
        if (m.type === 'result' && m.mask) resolve(m.mask)
        else reject(new Error(m.message ?? 'segmentation failed'))
      }
    }
    worker.addEventListener('message', onMessage)
    onMsg('AI 모델을 준비하는 중')
    worker.postMessage({ id, width: photo.width, height: photo.height, data }, [data.buffer])
  })
}

function hasTransparency(photo: HTMLCanvasElement) {
  const d = photo.getContext('2d')!.getImageData(0, 0, photo.width, photo.height).data
  let t = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) t++
  return t > (d.length / 4) * 0.02
}

function largestComponent(m: Uint8Array, w: number, h: number) {
  const n = w * h
  const label = new Int32Array(n)
  const q = new Int32Array(n)
  let best = 0
  let bestId = 0
  let id = 0
  for (let i = 0; i < n; i++) {
    if (!m[i] || label[i]) continue
    id++
    let head = 0
    let tail = 0
    q[tail++] = i
    label[i] = id
    while (head < tail) {
      const j = q[head++]
      const x = j % w
      const nb = [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j - w, j + w]
      for (const k of nb) {
        if (k < 0 || k >= n || !m[k] || label[k]) continue
        label[k] = id
        q[tail++] = k
      }
    }
    if (tail > best) {
      best = tail
      bestId = id
    }
  }
  for (let i = 0; i < n; i++) m[i] = bestId && label[i] === bestId ? 1 : 0
}

/**
 * 알파 마스크(사진과 같은 해상도, 0..255)로 피사체를 만든다.
 * alpha가 null이면 원본 알파(투명 PNG) — mode='plain'이면 부드러운 타원 크롭.
 */
function buildSubject(photo: HTMLCanvasElement, alpha: Uint8Array | null, mode: 'mask' | 'png' | 'plain'): Subject {
  const W = photo.width
  const H = photo.height
  const img = photo.getContext('2d')!.getImageData(0, 0, W, H)
  const px = img.data
  const A = new Uint8Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (mode === 'mask' && alpha) A[i] = clamp((alpha[i] - 20) * 1.12, 0, 255)
      else if (mode === 'png') A[i] = px[i * 4 + 3]
      else {
        const dn = Math.hypot((x + 0.5 - W / 2) / (W * 0.48), (y + 0.5 - H / 2) / (H * 0.48))
        A[i] = clamp((1 - dn) * 2400, 0, 255)
      }
    }

  // 작은 해상도에서 가장 큰 덩어리만 남겨 잡티 제거
  const sc = Math.min(1, 200 / Math.max(W, H))
  const w = Math.max(8, Math.round(W * sc))
  const h = Math.max(8, Math.round(H * sc))
  const small = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) small[y * w + x] = A[Math.min(H - 1, Math.floor(y / sc)) * W + Math.min(W - 1, Math.floor(x / sc))] >= 128 ? 1 : 0
  largestComponent(small, w, h)
  if (!small.some((v) => v)) small.fill(1)
  const keep = small.slice()
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!small[y * w + x]) continue
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) keep[clamp(y + oy, 0, h - 1) * w + clamp(x + ox, 0, w - 1)] = 1
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const k = keep[Math.min(h - 1, Math.floor(y * sc)) * w + Math.min(w - 1, Math.floor(x * sc))]
      px[i * 4 + 3] = k ? Math.min(px[i * 4 + 3], A[i]) : 0
    }
  const full = document.createElement('canvas')
  full.width = W
  full.height = H
  full.getContext('2d')!.putImageData(img, 0, 0)

  // bbox + 무게중심
  let minX = w
  let minY = h
  let maxX = 0
  let maxY = 0
  let sx = 0
  let sy = 0
  let cnt = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!small[y * w + x]) continue
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      sx += x + 0.5
      sy += y + 0.5
      cnt++
    }
  const cx = sx / cnt
  const cy = sy / cnt
  const k = 1 / sc
  const bx = Math.max(0, Math.floor((minX - 1) * k))
  const by = Math.max(0, Math.floor((minY - 1) * k))
  const bw = Math.max(1, Math.min(W, Math.ceil((maxX + 2) * k)) - bx)
  const bh = Math.max(1, Math.min(H, Math.ceil((maxY + 2) * k)) - by)
  const cutout = document.createElement('canvas')
  cutout.width = bw
  cutout.height = bh
  cutout.getContext('2d')!.drawImage(full, bx, by, bw, bh, 0, 0, bw, bh)

  // 방사형 외곽선
  const raw = new Float32Array(SIL_N)
  for (let s = 0; s < SIL_N; s++) {
    const a = (s / SIL_N) * TAU
    let last = 0
    for (let r = 0; r < w + h; r += 0.5) {
      const x = Math.floor(cx + Math.cos(a) * r)
      const y = Math.floor(cy + Math.sin(a) * r)
      if (x < 0 || y < 0 || x >= w || y >= h) break
      if (small[y * w + x]) last = r
    }
    raw[s] = last + 0.7
  }
  let sm = raw
  for (let pass = 0; pass < 2; pass++) {
    const nx = new Float32Array(SIL_N)
    for (let s = 0; s < SIL_N; s++) {
      let acc = 0
      for (let o = -2; o <= 2; o++) acc += sm[(s + o + SIL_N) % SIL_N]
      nx[s] = Math.max(acc / 5, sm[s] * 0.92)
    }
    sm = nx
  }
  const rpx = sm.map((v) => v * k) // cutout px

  // 앙금 + 베벨까지 포함해 반죽 안쪽 타원에 들어가는 배율
  const pad = COAT + 0.05
  const fits = (s: number) => {
    for (let i = 0; i < SIL_N; i++) {
      const a = (i / SIL_N) * TAU
      const r = rpx[i] * s + pad
      if (Math.hypot((Math.cos(a) * r) / 0.74, (Math.sin(a) * r) / 0.64) > 1) return false
    }
    return true
  }
  let lo = 0
  let hi = 2 / Math.max(...rpx)
  for (let it = 0; it < 24; it++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }

  // 레이캐스트용 저해상도 알파
  const aw = Math.min(160, bw)
  const ah = Math.max(1, Math.round((bh / bw) * aw))
  const ac = document.createElement('canvas')
  ac.width = aw
  ac.height = ah
  const actx = ac.getContext('2d', { willReadFrequently: true })!
  actx.drawImage(cutout, 0, 0, aw, ah)
  const ad = actx.getImageData(0, 0, aw, ah).data
  const alphaAt = (u: number, v: number) =>
    ad[(clamp(Math.floor((1 - v) * ah), 0, ah - 1) * aw + clamp(Math.floor(u * aw), 0, aw - 1)) * 4 + 3]

  return {
    cutout,
    ox: (cx * k - bx),
    oy: (cy * k - by),
    scale: lo,
    radii: rpx.map((v) => v * lo),
    alphaAt,
    cut: mode !== 'plain',
  }
}

/** 샘플: 연회색 배경 위의 복숭아 */
function makeSamplePhoto() {
  const c = document.createElement('canvas')
  c.width = c.height = 900
  const ctx = c.getContext('2d')!
  const bg = ctx.createLinearGradient(0, 0, 0, 900)
  bg.addColorStop(0, '#f1f1ef')
  bg.addColorStop(1, '#e6e5e2')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, 900, 900)
  const g = ctx.createRadialGradient(380, 360, 30, 450, 470, 300)
  g.addColorStop(0, '#ffd2b8')
  g.addColorStop(0.5, '#f4917a')
  g.addColorStop(1, '#c2523f')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.moveTo(450, 230)
  ctx.bezierCurveTo(650, 190, 730, 420, 680, 560)
  ctx.bezierCurveTo(630, 700, 520, 740, 450, 740)
  ctx.bezierCurveTo(380, 740, 270, 700, 220, 560)
  ctx.bezierCurveTo(170, 420, 250, 190, 450, 230)
  ctx.fill()
  ctx.fillStyle = '#6f8f4e'
  ctx.beginPath()
  ctx.ellipse(500, 215, 70, 26, -0.4, 0, TAU)
  ctx.fill()
  return c
}

async function fileToCanvas(file: File) {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const s = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(img.naturalWidth * s))
    c.height = Math.max(1, Math.round(img.naturalHeight * s))
    c.getContext('2d', { willReadFrequently: true })!.drawImage(img, 0, 0, c.width, c.height)
    return c
  } finally {
    URL.revokeObjectURL(url)
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * 4. 3D 엔진 상태 (React 렌더와 분리된 가변 상태 — useFrame과 포인터 핸들러가 공유)
 * ════════════════════════════════════════════════════════════════════════ */

/** 반죽 원판 메시: 중심은 바닥 극점, 가장자리는 감싸면 꼭대기 봉합점으로 모인다 */
type DoughSim = {
  n: number
  geo: THREE.BufferGeometry
  F: Float32Array // 닫힌 모찌 위치
  O: Float32Array // 바닥에 평평하게 펼쳐진 시트 위치
  nrm: Float32Array // 방사 방향 (닫힌 형태 기준)
  phi: Float32Array
  rho: Float32Array
  c: Float32Array // 덮인 정도 (0 펼침 → 1 감쌈)
  cBase: Float32Array // 붙어서 고정된 정도
  w: Float32Array // 지금 잡은 지점에 함께 끌려오는 가중치
  str: Float32Array // 늘어난 오프셋 (손가락을 끈적하게 늦게 따라감)
  col: Float32Array // 잡을 수 있는 곳 하이라이트용 버텍스 컬러
  seam: Float32Array // 이음매 (성형 전 울퉁불퉁함)
  disp: Float32Array // 점탄성 변위
  vel: Float32Array
  plast: Float32Array // 소성 변형
}

type Engine = {
  camera: THREE.PerspectiveCamera | null
  gl: THREE.WebGLRenderer | null
  scene: THREE.Scene | null
  controls: { enabled: boolean } | null
  squashG: THREE.Group | null
  mochiG: THREE.Group | null
  dough: THREE.Mesh | null
  slab: THREE.Mesh | null
  photo: THREE.Mesh | null
  sim: DoughSim | null
  coreSim: CoreSim | null
  roundK: number // 코어가 동그래진 정도
  coreDrag: { x: number; y: number; z: number; vx: number; vy: number; vz: number }
  subject: Subject | null
  uniforms: {
    uBites: { value: THREE.DataTexture }
    uBiteCount: { value: number }
    uWorldToMochi: { value: THREE.Matrix4 }
  }
  bites: { x: number; y: number; z: number; r: number }[]
  samples: Float32Array
  alive: Uint8Array
  aliveCount: number
  squash: { y: number; vy: number; ty: number }
  coatT: number
  phase: Phase
  roll: number
  rollPhase: number
  pull: { active: boolean; gi: number; dx: number; dy: number; dz: number }
  press: {
    active: boolean
    gx: number
    gy: number
    gz: number
    dx: number
    dy: number
    dz: number
    dragging: boolean
    vx: number // 시선 방향 (모찌 좌표계)
    vy: number
    vz: number
  }
  pulls: number
  camNudge: number // 단계 진입 시 카메라 높이를 부드럽게 맞추는 남은 시간
  camFront: number // 다 빚은 뒤 정면으로 돌아오는 남은 시간
}

function createEngine(): Engine {
  const tex = new THREE.DataTexture(new Float32Array(BITE_TEX * 2 * 4), BITE_TEX, 2, THREE.RGBAFormat, THREE.FloatType)
  tex.minFilter = tex.magFilter = THREE.NearestFilter
  tex.needsUpdate = true
  // 남은 양 계산용 부피 샘플
  const pts: number[] = []
  while (pts.length < 3600 * 3) {
    const x = (Math.random() * 2 - 1) * 1.1
    const y = (Math.random() * 2 - 1) * 1.0
    const z = (Math.random() * 2 - 1) * 1.1
    const l = Math.hypot(x, y, z) || 1
    const [fx, fy, fz] = mochiShape(x / l, y / l, z / l)
    if (l <= Math.hypot(fx, fy, fz)) pts.push(x, y, z)
  }
  const samples = new Float32Array(pts)
  return {
    camera: null,
    gl: null,
    scene: null,
    controls: null,
    squashG: null,
    mochiG: null,
    dough: null,
    slab: null,
    photo: null,
    sim: null,
    coreSim: null,
    roundK: 0,
    coreDrag: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    subject: null,
    uniforms: { uBites: { value: tex }, uBiteCount: { value: 0 }, uWorldToMochi: { value: new THREE.Matrix4() } },
    bites: [],
    samples,
    alive: new Uint8Array(samples.length / 3).fill(1),
    aliveCount: samples.length / 3,
    squash: { y: 1, vy: 0, ty: 1 },
    coatT: 0,
    phase: 'upload',
    roll: 0,
    rollPhase: 0,
    pull: { active: false, gi: -1, dx: 0, dy: 0, dz: 0 },
    press: { active: false, gx: 0, gy: 0, gz: 0, dx: 0, dy: 0, dz: 0, dragging: false, vx: 0, vy: 0, vz: -1 },
    pulls: 0,
    camNudge: 0,
    camFront: 0,
  }
}

function buildDough(): DoughSim {
  const NR = 56
  const NS = 128
  const n = 1 + NR * NS
  const F = new Float32Array(n * 3)
  const O = new Float32Array(n * 3)
  const nrm = new Float32Array(n * 3)
  const phi = new Float32Array(n)
  const rho = new Float32Array(n)
  const c = new Float32Array(n)
  const cBase = new Float32Array(n)
  const set = (i: number, r: number, p: number) => {
    const th = r * Math.PI
    const dx = Math.sin(th) * Math.cos(p)
    const dy = -Math.cos(th)
    const dz = Math.sin(th) * Math.sin(p)
    const [fx, fy, fz] = mochiShape(dx, dy, dz)
    F.set([fx, fy, fz], i * 3)
    const l = Math.hypot(fx, fy, fz) || 1
    nrm.set([fx / l, fy / l, fz / l], i * 3)
    phi[i] = p
    rho[i] = r
    // 바닥에 평평하게 펴 둔 반죽 시트 (손으로 편 듯 가장자리만 살짝 울퉁불퉁)
    const rr = SHEET_R * r * (1 + 0.025 * Math.sin(5 * p + 1) * r)
    O.set([Math.cos(p) * rr, FLOOR_Y + 0.012, Math.sin(p) * rr], i * 3)
  }
  set(0, 0, 0)
  for (let j = 1; j <= NR; j++) for (let s = 0; s < NS; s++) set(1 + (j - 1) * NS + s, j / NR, (s / NS) * TAU)
  const idx: number[] = []
  const ring = (j: number, s: number) => 1 + (j - 1) * NS + (((s % NS) + NS) % NS)
  for (let s = 0; s < NS; s++) idx.push(0, ring(1, s), ring(1, s + 1))
  for (let j = 1; j < NR; j++)
    for (let s = 0; s < NS; s++) {
      const a = ring(j, s)
      const b = ring(j, s + 1)
      const cc = ring(j + 1, s)
      const d = ring(j + 1, s + 1)
      idx.push(a, cc, d, a, d, b)
    }
  const geo = new THREE.BufferGeometry()
  const col = new Float32Array(n * 3).fill(1)
  geo.setAttribute('position', new THREE.BufferAttribute(O.slice(), 3).setUsage(THREE.DynamicDrawUsage))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3.2)
  return {
    n,
    geo,
    F,
    O,
    nrm,
    phi,
    rho,
    c,
    cBase,
    w: new Float32Array(n),
    str: new Float32Array(n * 3),
    col,
    seam: new Float32Array(n),
    disp: new Float32Array(n * 3),
    vel: new Float32Array(n * 3),
    plast: new Float32Array(n * 3),
  }
}

/** 매 프레임: 카메라 거리, 눌림 스프링, 앙금 코팅, 반죽 시뮬레이션 */
function stepEngine(e: Engine, dt: number) {
  const { camera, mochiG, squashG, sim } = e
  if (!camera || !mochiG || !squashG) return

  // 단계에 맞게 카메라가 물러나거나 다가감 (궤도 각도는 사용자가 정한 그대로)
  const want = e.phase === 'wrapping' ? 2.0 : e.phase === 'filling' || e.phase === 'coating' ? 1.0 : 1.2
  const dist = want / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.min(1, camera.aspect) + 0.6
  const off = camera.position.clone().sub(TARGET)
  if (e.camNudge > 0) {
    // 감싸기 단계: 펼친 반죽이 잘 보이도록 위에서 내려다보는 각도로
    e.camNudge -= dt
    const sp = new THREE.Spherical().setFromVector3(off)
    sp.phi += (0.82 - sp.phi) * (1 - Math.exp(-dt * 4))
    off.setFromSpherical(sp)
  }
  if (e.camFront > 0) {
    // 다 빚은 모찌는 정면에서: 동그래진 피사체가 바로 보이도록
    e.camFront -= dt
    const sp = new THREE.Spherical().setFromVector3(off)
    const k = 1 - Math.exp(-dt * 3)
    sp.theta += wrapAngle(0 - sp.theta) * k
    sp.phi += (1.36 - sp.phi) * k
    off.setFromSpherical(sp)
  }
  const len = off.length() || 1
  camera.position.copy(TARGET).addScaledVector(off, (len + (dist - len) * (1 - Math.exp(-dt * 2.5))) / len)

  // 바닥 접점을 기준으로 눌리는 묵직한 스프링 (과감쇠 — 반동 없음)
  const sq = e.squash
  sq.vy += ((18 * (sq.ty - sq.y) - 14 * sq.vy) / 2.2) * dt
  sq.y += sq.vy * dt
  const xz = 1 / Math.sqrt(sq.y)
  squashG.scale.set(xz, sq.y, xz)
  squashG.updateMatrixWorld(true)
  e.uniforms.uWorldToMochi.value.copy(mochiG.matrixWorld).invert()

  const coated = e.phase !== 'upload' && e.phase !== 'processing' && e.phase !== 'filling'
  if (coated) e.coatT = Math.min(1, e.coatT + dt / 0.8)
  const ce = Math.max(0.02, easeOut(e.coatT))
  if (e.slab) e.slab.visible = coated
  stepCore(e, dt, coated, ce)

  if (sim && e.dough) {
    e.dough.visible = e.phase === 'wrapping' || e.phase === 'shaping' || e.phase === 'play' || e.phase === 'done'
    // 펼친 시트는 나중에 바깥이 될 면이 바닥을 향하므로 감싸기 동안만 양면, 이후엔 앞면 + 단면 캡
    const sheet = e.phase === 'wrapping'
    const mat = e.dough.material as THREE.Material
    const side = sheet ? THREE.DoubleSide : THREE.FrontSide
    if (mat.side !== side) {
      mat.side = side
      mat.needsUpdate = true
    }
    if (e.dough.children[0]) e.dough.children[0].visible = !sheet
    if (e.dough.visible) stepDough(e, sim, dt)
  }
}

function stepDough(e: Engine, s: DoughSim, dt: number) {
  const pos = s.geo.attributes.position.array as Float32Array
  const colAttr = s.geo.attributes.color as THREE.BufferAttribute
  if (e.phase === 'wrapping') {
    const kc = 1 - Math.exp(-dt * 5) // 붙는 반죽이 스르륵 자리 잡음
    const ks = 1 - Math.exp(-dt * (e.pull.active ? 7 : 3.5)) // 늘어남: 끈적하게 따라오고, 놓으면 천천히 되돌아감
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 380)
    const pl = e.pull
    for (let i = 0; i < s.n; i++) {
      const j = i * 3
      s.c[i] += (s.cBase[i] - s.c[i]) * kc
      const c = s.c[i]
      const w = pl.active ? s.w[i] : 0
      // 잡은 지점을 중심으로 치즈처럼 늘어남 (종이접기처럼 꺾이지 않음)
      s.str[j] += (pl.dx * w - s.str[j]) * ks
      s.str[j + 1] += (pl.dy * w - s.str[j + 1]) * ks
      s.str[j + 2] += (pl.dz * w - s.str[j + 2]) * ks
      let x = s.O[j] + (s.F[j] - s.O[j]) * c + s.str[j] * (1 - c)
      let y = s.O[j + 1] + (s.F[j + 1] - s.O[j + 1]) * c + s.str[j + 1] * (1 - c)
      let z = s.O[j + 2] + (s.F[j + 2] - s.O[j + 2]) * c + s.str[j + 2] * (1 - c)
      // 들려 있는 반죽은 앙금(모찌 형태) 안으로 파고들지 않고 그 위로 덮이듯 걸쳐짐
      const lifted = Math.abs(s.str[j]) + Math.abs(s.str[j + 1]) + Math.abs(s.str[j + 2]) > 0.03 || (c > 0.02 && c < 0.98)
      if (lifted && y > FLOOR_Y + 0.03) {
        const l = Math.hypot(x, y, z) || 1
        const [fx, fy, fz] = mochiShape(x / l, y / l, z / l)
        const surf = Math.hypot(fx, fy, fz) * 1.01
        if (l < surf) {
          x *= surf / l
          y *= surf / l
          z *= surf / l
        }
      }
      pos[j] = x
      pos[j + 1] = y
      pos[j + 2] = z
      // 하이라이트: 아직 덮지 않은 가장자리는 은은하게 숨 쉬듯, 잡은 부분은 또렷하게
      const open = smoothstep(GRAB_RHO, GRAB_RHO + 0.25, s.rho[i]) * (1 - s.cBase[i])
      const rim = smoothstep(0.76, 0.9, s.rho[i]) * (1 - s.cBase[i]) // 손잡이처럼 또렷한 가장자리 띠
      // 화면상 밝기 차이(sRGB)로 정한 뒤 선형 공간 값으로 변환 — 버텍스 컬러는 선형으로 곱해짐
      const d = Math.min(0.32, open * 0.02 + rim * (0.1 + 0.12 * pulse) + w * 0.14)
      const v = Math.pow(1 - d, 2.2)
      s.col[j] = v
      s.col[j + 1] = v
      s.col[j + 2] = v
    }
    colAttr.needsUpdate = true
  } else {
    // 점탄성 소프트바디: 피는 가볍고 끈적해 살짝만 끌어도 길게 늘어남
    const p = e.press
    const sig2 = 2 * 0.5 * 0.5
    const h = dt / 2
    for (let sub = 0; sub < 2; sub++) {
      for (let i = 0; i < s.n; i++) {
        const j = i * 3
        let tx = s.plast[j]
        let ty = s.plast[j + 1]
        let tz = s.plast[j + 2]
        if (p.active) {
          // 화면에서 가까운 꼭짓점이 함께 끌려오도록 시선에 수직인 평면에서의 거리로 가중치 (카메라를 향한 면만)
          let ddx = s.F[j] - p.gx
          let ddy = s.F[j + 1] - p.gy
          let ddz = s.F[j + 2] - p.gz
          const along = ddx * p.vx + ddy * p.vy + ddz * p.vz
          ddx -= along * p.vx
          ddy -= along * p.vy
          ddz -= along * p.vz
          const facing = smoothstep(-0.35, 0.15, -(s.nrm[j] * p.vx + s.nrm[j + 1] * p.vy + s.nrm[j + 2] * p.vz))
          const w = Math.exp(-(ddx * ddx + ddy * ddy + ddz * ddz) / sig2) * facing
          if (w > 0.001) {
            if (p.dragging) {
              tx += p.dx * 1.6 * w
              ty += p.dy * 1.6 * w
              tz += p.dz * 1.6 * w
            } else {
              tx -= s.nrm[j] * 0.11 * w
              ty -= s.nrm[j + 1] * 0.11 * w
              tz -= s.nrm[j + 2] * 0.11 * w
            }
          }
        }
        const dx = s.disp[j]
        const dy = s.disp[j + 1]
        const dz = s.disp[j + 2]
        const sag = 3.2 * Math.hypot(dx, dy, dz) // 늘어난 만큼 중력으로 처짐
        s.vel[j] += (12 * (tx - dx) - 8 * s.vel[j]) * h
        s.vel[j + 1] += (12 * (ty - dy) - 8 * s.vel[j + 1] - sag) * h
        s.vel[j + 2] += (12 * (tz - dz) - 8 * s.vel[j + 2]) * h
        s.disp[j] += s.vel[j] * h
        s.disp[j + 1] += s.vel[j + 1] * h
        s.disp[j + 2] += s.vel[j + 2] * h
      }
    }
    const pulling = p.active && p.dragging
    const relax = Math.exp(-0.6 * dt)
    for (let j = 0; j < s.n * 3; j++) {
      if (pulling) s.plast[j] += (0.55 * s.disp[j] - s.plast[j]) * Math.min(1, dt)
      else s.plast[j] *= relax
    }
    if (s.col[0] !== 1) {
      s.col.fill(1)
      colAttr.needsUpdate = true
    }
    // 자기 교차 방지: 안쪽으로는 반죽 두께 이상 파고들지 못하게, 전체 늘어남도 상한
    for (let i = 0; i < s.n; i++) {
      const j = i * 3
      const inward = s.disp[j] * s.nrm[j] + s.disp[j + 1] * s.nrm[j + 1] + s.disp[j + 2] * s.nrm[j + 2]
      if (inward < -0.14) {
        const fix = -0.14 - inward
        s.disp[j] += s.nrm[j] * fix
        s.disp[j + 1] += s.nrm[j + 1] * fix
        s.disp[j + 2] += s.nrm[j + 2] * fix
        const vin = s.vel[j] * s.nrm[j] + s.vel[j + 1] * s.nrm[j + 1] + s.vel[j + 2] * s.nrm[j + 2]
        if (vin < 0) {
          s.vel[j] -= s.nrm[j] * vin
          s.vel[j + 1] -= s.nrm[j + 1] * vin
          s.vel[j + 2] -= s.nrm[j + 2] * vin
        }
      }
      const m = Math.hypot(s.disp[j], s.disp[j + 1], s.disp[j + 2])
      if (m > 1.5) {
        s.disp[j] *= 1.5 / m
        s.disp[j + 1] *= 1.5 / m
        s.disp[j + 2] *= 1.5 / m
      }
    }
    const shaping = e.phase === 'shaping'
    const eRoll = shaping ? easeInOut(e.roll) : 1
    const rp = e.rollPhase * 0.3
    for (let i = 0; i < s.n; i++) {
      const j = i * 3
      let lump = 0
      if (shaping && eRoll < 1) {
        lump = ((noise3(s.F[j] * 2.4 + rp, s.F[j + 1] * 2.4, s.F[j + 2] * 2.4 - rp) - 0.5) * 0.2 + s.seam[i] * 0.07) * (1 - eRoll)
      }
      pos[j] = s.F[j] + s.nrm[j] * lump + s.disp[j]
      pos[j + 1] = s.F[j + 1] + s.nrm[j + 1] * lump + s.disp[j + 1]
      pos[j + 2] = s.F[j + 2] + s.nrm[j + 2] * lump + s.disp[j + 2]
    }
  }
  s.geo.attributes.position.needsUpdate = true
  s.geo.computeVertexNormals()
}

/* ════════════════════════════════════════════════════════════════════════
 * 5. Materials — 베어문 자국은 셰이더 discard로 실제 구멍을 낸다
 * ════════════════════════════════════════════════════════════════════════ */

const BITE_GLSL = /* glsl */ `
uniform sampler2D uBites;
uniform int uBiteCount;
uniform mat4 uWorldToMochi;
uniform vec3 uInterior;
uniform float uGrain;
uniform float uGrainScale;
uniform vec3 uSSS;
varying vec3 vMochiWorld;
bool mochiBitten(vec3 p) {
  for (int i = 0; i < ${BITE_TEX}; i++) {
    if (i >= uBiteCount) break;
    vec4 b = texelFetch(uBites, ivec2(i, 0), 0);
    vec3 v = p - b.xyz;
    float d = length(v);
    if (d > b.w) continue;
    vec4 o = texelFetch(uBites, ivec2(i, 1), 0);
    vec3 ax = normalize(o.xyz);
    vec3 t1 = normalize(cross(ax, abs(ax.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(ax, t1);
    float th = atan(dot(v, t2), dot(v, t1));
    float teeth = 8.0 + mod(floor(o.w), 3.0);
    // 이빨 자국: 작은 원호가 이어진 울퉁불퉁한 가장자리
    float sc = 1.0 - 0.1 * (1.0 - sqrt(abs(sin(th * teeth * 0.5 + o.w))));
    if (d < b.w * sc) return true;
  }
  return false;
}
`

type BiteLocal = {
  uInterior: { value: THREE.Color }
  uGrain: { value: number }
  uGrainScale: { value: number }
  uSSS: { value: THREE.Color }
}

function biteMaterial<T extends THREE.MeshStandardMaterial>(
  mat: T,
  shared: Engine['uniforms'],
  opts: { interior: string; grain: number; grainScale: number; sss?: string; sssAmt?: number },
) {
  const local: BiteLocal = {
    uInterior: { value: new THREE.Color(opts.interior) },
    uGrain: { value: opts.grain },
    uGrainScale: { value: opts.grainScale },
    uSSS: { value: new THREE.Color(opts.sss ?? '#000000').multiplyScalar(opts.sssAmt ?? 0) },
  }
  mat.userData.local = local
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared, local)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMochiWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvMochiWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${BITE_GLSL}`)
      .replace(
        'void main() {',
        'void main() {\n  vec3 mochiP = (uWorldToMochi * vec4(vMochiWorld, 1.0)).xyz;\n  if (mochiBitten(mochiP)) discard;',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  diffuseColor.rgb *= 1.0 + uGrain * (fract(sin(dot(floor(mochiP * uGrainScale), vec3(12.9898, 78.233, 37.719))) * 43758.5453) - 0.5);`,
      )
      .replace(
        '#include <opaque_fragment>',
        // 가장자리로 갈수록 빛이 스며 나오는 가짜 서브서피스 스캐터링
        'outgoingLight += uSSS * pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 2.0);\n#include <opaque_fragment>',
      )
  }
  return mat
}

/**
 * 베어문 단면: 안쪽 면(BackSide)을 거의 자체 발광으로 고르게 칠함.
 * 조명을 받으면 구멍마다 둥근 음영(물방울 얼룩)이 생기므로 빛의 영향을 최소화.
 */
function capMaterial(hex: string) {
  const m = new THREE.MeshStandardMaterial({ roughness: 1, side: THREE.BackSide })
  setCapColor(m, hex)
  return m
}
function setCapColor(m: THREE.MeshStandardMaterial, hex: string) {
  const c = new THREE.Color(hex)
  m.color.copy(c).multiplyScalar(0.18)
  m.emissive.copy(c).multiplyScalar(0.82)
}

type AnkoStyle = { label: string; swatch: string; mid: string; lo: string }
const ANKO_STYLE: Record<Anko, AnkoStyle> = {
  red: { label: '팥앙금', swatch: '#4b2622', mid: '#4b2622', lo: '#2a120f' },
  white: { label: '백앙금', swatch: '#e9ddc6', mid: '#e3d4b8', lo: '#bfa77f' },
}

/* ── 변형되는 코어 (앙금 쿠션 + 사진) ─────────────────────────────── */

const NRA = 24 // 앙금 쿠션 링 수
const NSA = 96 // 앙금 쿠션 분할 수
const ROUND_R = 0.56 // 동그랗게 빚었을 때 피사체 원의 반지름
const PHOTO_GAP = 0.022 // 앙금 표면과 사진 사이 간격 (깊이 충돌 방지)

/** 3D 각도(y 위)에서의 피사체 외곽선 반지름 — radii는 이미지 좌표계(y 아래) 각도 */
function silR(s: Subject, th: number) {
  const t = (((((-th) % TAU) + TAU) % TAU) / TAU) * SIL_N
  const i = Math.floor(t) % SIL_N
  return lerp(s.radii[i], s.radii[(i + 1) % SIL_N], t - Math.floor(t))
}
const coatLump = (th: number) => 1 + 0.14 * Math.sin(-5 * th + 1) + 0.08 * Math.sin(-9 * th + 0.4)

type CoreSim = {
  subject: Subject
  photo: THREE.BufferGeometry
  photoBase: Float32Array // 원래 평면 위치 (무게중심 기준)
  anko: THREE.BufferGeometry
  ankoParam: Float32Array // [t(0..1 정규화 반지름), θ, side(±1)]
  tex: THREE.CanvasTexture
}

function buildCore(s: Subject): CoreSim {
  const w = s.cutout.width * s.scale
  const h = s.cutout.height * s.scale
  const photo = new THREE.PlaneGeometry(w, h, 80, 80)
  photo.translate((s.cutout.width / 2 - s.ox) * s.scale, -(s.cutout.height / 2 - s.oy) * s.scale, 0)
  ;(photo.attributes.position as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage)
  photo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3)
  const photoBase = (photo.attributes.position.array as Float32Array).slice()

  // 앞/뒤 두 장의 원판이 가장자리 링을 공유하는 쿠션 → 외곽선을 따르다가 둥근 렌즈로
  const param: number[] = [0, 0, 1]
  for (let j = 1; j <= NRA; j++) for (let k = 0; k < NSA; k++) param.push(j / NRA, (k / NSA) * TAU, 1)
  const backC = param.length / 3
  param.push(0, 0, -1)
  for (let j = 1; j < NRA; j++) for (let k = 0; k < NSA; k++) param.push(j / NRA, (k / NSA) * TAU, -1)
  const f = (j: number, k: number) => (j === 0 ? 0 : 1 + (j - 1) * NSA + (((k % NSA) + NSA) % NSA))
  const b = (j: number, k: number) => (j === 0 ? backC : j === NRA ? f(NRA, k) : backC + 1 + (j - 1) * NSA + (((k % NSA) + NSA) % NSA))
  const idx: number[] = []
  for (let k = 0; k < NSA; k++) {
    idx.push(f(0, k), f(1, k), f(1, k + 1))
    idx.push(b(0, k), b(1, k + 1), b(1, k))
  }
  for (let j = 1; j < NRA; j++)
    for (let k = 0; k < NSA; k++) {
      idx.push(f(j, k), f(j + 1, k), f(j + 1, k + 1), f(j, k), f(j + 1, k + 1), f(j, k + 1))
      idx.push(b(j, k), b(j + 1, k + 1), b(j + 1, k), b(j, k), b(j, k + 1), b(j + 1, k + 1))
    }
  const anko = new THREE.BufferGeometry()
  anko.setAttribute('position', new THREE.BufferAttribute(new Float32Array(param.length), 3).setUsage(THREE.DynamicDrawUsage))
  anko.setIndex(idx)
  anko.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3)

  const tex = new THREE.CanvasTexture(s.cutout)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return { subject: s, photo, photoBase, anko, ankoParam: new Float32Array(param), tex }
}

/**
 * 코어 갱신: 성형 진행도(roundK)에 맞춰 피사체/앙금이 어안렌즈처럼 동그랗게 차오르고,
 * 반죽을 끌면 같은 방향으로 함께 늘어남.
 */
function stepCore(e: Engine, dt: number, coated: boolean, ce: number) {
  const c = e.coreSim
  if (!c) return
  const s = c.subject
  const target = e.phase === 'shaping' ? easeInOut(e.roll) : e.phase === 'play' || e.phase === 'done' ? 1 : 0
  e.roundK += (target - e.roundK) * (1 - Math.exp(-dt * 4))
  const k = e.roundK

  // 끌림: 반죽과 같은 점탄성 스프링을 따라가되 피보다 덜 늘어남 (심지 역할)
  const p = e.press
  const cd = e.coreDrag
  const pulling = p.active && p.dragging && e.phase === 'play'
  for (const [ax, tv] of [
    ['x', pulling ? p.dx : 0],
    ['y', pulling ? p.dy : 0],
    ['z', pulling ? p.dz : 0],
  ] as const) {
    const vk = ('v' + ax) as 'vx' | 'vy' | 'vz'
    cd[vk] += (12 * (tv - cd[ax]) - 8 * cd[vk]) * dt
    cd[ax] += cd[vk] * dt
  }
  const dragOn = Math.abs(cd.x) + Math.abs(cd.y) + Math.abs(cd.z) > 1e-4
  const sig2 = 2 * 0.55 * 0.55
  const gx = p.gx
  const gy = p.gy - CORE_Y
  const gz = p.gz
  const dragW = (x: number, y: number, z: number) => {
    if (!dragOn) return 0
    let dx = x - gx
    let dy = y - gy
    let dz = z - gz
    const along = dx * p.vx + dy * p.vy + dz * p.vz
    dx -= along * p.vx
    dy -= along * p.vy
    dz -= along * p.vz
    return Math.exp(-(dx * dx + dy * dy + dz * dz) / sig2) * 0.75
  }

  const grow = 0.9 + 0.1 * ce
  const T = lerp(0.15, 0.42, k) * ce // 쿠션 두께 → 둥글어질수록 볼록한 렌즈
  const pexp = lerp(4, 2, k) // 납작한 면 → 돔
  const ankoR = (th: number) => lerp(silR(s, th) + COAT * coatLump(th), ROUND_R + COAT + 0.03, k) * grow
  const frontZ = (r: number, th: number) => {
    const ta = Math.min(1, r / ankoR(th))
    return T * Math.sqrt(Math.max(0, 1 - Math.pow(ta, pexp)))
  }

  if (coated) {
    const pos = c.anko.attributes.position.array as Float32Array
    const P = c.ankoParam
    for (let i = 0; i < P.length / 3; i++) {
      const th = P[i * 3 + 1]
      const r = P[i * 3] * ankoR(th)
      let x = Math.cos(th) * r
      let y = Math.sin(th) * r
      let z = P[i * 3 + 2] * frontZ(r, th)
      const w = dragW(x, y, z)
      x += cd.x * w
      y += cd.y * w
      z += cd.z * w
      pos[i * 3] = x
      pos[i * 3 + 1] = y
      pos[i * 3 + 2] = z
    }
    c.anko.attributes.position.needsUpdate = true
    c.anko.computeVertexNormals()
  }

  const pos = c.photo.attributes.position.array as Float32Array
  const B = c.photoBase
  for (let i = 0; i < B.length / 3; i++) {
    const x0 = B[i * 3]
    const y0 = B[i * 3 + 1]
    const r0 = Math.hypot(x0, y0)
    const th = Math.atan2(y0, x0)
    // 외곽선 → 원으로 정규화 + 중심이 살짝 부푸는 어안 곡선 (빈 곳은 늘려서 채움)
    const xn = r0 / Math.max(1e-3, silR(s, th))
    const fe = xn < 1 ? Math.sin((xn * Math.PI) / 2) * 0.65 + xn * 0.35 : 1 + (xn - 1) * 0.7
    const r = lerp(r0, ROUND_R * fe * grow, k)
    let x = Math.cos(th) * r
    let y = Math.sin(th) * r
    let z = coated ? frontZ(r, th) + PHOTO_GAP : 0
    const w = dragW(x, y, z)
    x += cd.x * w
    y += cd.y * w
    z += cd.z * w
    pos[i * 3] = x
    pos[i * 3 + 1] = y
    pos[i * 3 + 2] = z
  }
  c.photo.attributes.position.needsUpdate = true
  c.photo.computeVertexNormals()
}

/* ════════════════════════════════════════════════════════════════════════
 * 6. Scene (React Three Fiber)
 * ════════════════════════════════════════════════════════════════════════ */

function Scene({ engine, subject, anko }: { engine: Engine; subject: Subject | null; anko: Anko }) {
  const { camera, gl, scene } = useThree()
  const squashRef = useRef<THREE.Group>(null)
  const mochiRef = useRef<THREE.Group>(null)
  const doughRef = useRef<THREE.Mesh>(null)
  const slabRef = useRef<THREE.Mesh>(null)
  const photoRef = useRef<THREE.Mesh>(null)
  const controlsRef = useRef<ElementRef<typeof OrbitControls>>(null)

  const sim = useMemo(() => buildDough(), [])
  const doughMat = useMemo(
    () =>
      biteMaterial(
        new THREE.MeshPhysicalMaterial({
          color: '#fbf9f5',
          roughness: 0.82,
          sheen: 1,
          sheenColor: new THREE.Color('#ffffff'),
          sheenRoughness: 0.85, // 뽀송한 전분 가루의 벨벳 같은 산란
          vertexColors: true, // 감싸기 단계의 잡을 수 있는 곳 하이라이트
          side: THREE.FrontSide,
        }),
        engine.uniforms,
        { interior: '#d9cfbf', grain: 0.05, grainScale: 160, sss: '#fff1e2', sssAmt: 0.3 },
      ),
    [engine],
  )
  const ankoMat = useMemo(
    () =>
      biteMaterial(new THREE.MeshStandardMaterial({ roughness: 0.96, side: THREE.FrontSide }), engine.uniforms, {
        interior: '#2a120f',
        grain: 0.22,
        grainScale: 70,
      }),
    [engine],
  )
  // 베어문 단면: 같은 지오메트리의 안쪽 면(BackSide)만 단면 색으로 그림 → 구멍 너머가 꽉 찬 속처럼 보임
  const doughCap = useMemo(
    () =>
      biteMaterial(capMaterial('#e6ddd0'), engine.uniforms, {
        interior: '#e6ddd0',
        grain: 0.04,
        grainScale: 120,
      }),
    [engine],
  )
  const ankoCap = useMemo(
    () =>
      biteMaterial(capMaterial('#2a120f'), engine.uniforms, {
        interior: '#2a120f',
        grain: 0.18,
        grainScale: 70,
      }),
    [engine],
  )
  const core = useMemo(() => (subject ? buildCore(subject) : null), [subject])
  const photoMat = useMemo(
    () =>
      core
        ? biteMaterial(
            new THREE.MeshStandardMaterial({
              map: core.tex,
              alphaTest: 0.5,
              roughness: 0.72,
              side: THREE.FrontSide,
              // 앙금 표면보다 항상 앞에 그려지도록 깊이를 살짝 당김
              polygonOffset: true,
              polygonOffsetFactor: -2,
              polygonOffsetUnits: -4,
            }),
            engine.uniforms,
            { interior: '#2a120f', grain: 0, grainScale: 1 },
          )
        : null,
    [core, engine],
  )

  useEffect(() => {
    const st = ANKO_STYLE[anko]
    ankoMat.color.set(st.mid)
    setCapColor(ankoCap, st.lo)
    ;(ankoMat.userData.local as BiteLocal).uInterior.value.set(st.lo)
    if (photoMat) (photoMat.userData.local as BiteLocal).uInterior.value.set(st.lo)
  }, [anko, ankoMat, ankoCap, photoMat])

  useEffect(
    () => () => {
      core?.anko.dispose()
      core?.photo.dispose()
      core?.tex.dispose()
      photoMat?.dispose()
    },
    [core, photoMat],
  )
  useEffect(
    () => () => {
      sim.geo.dispose()
      doughMat.dispose()
      ankoMat.dispose()
      doughCap.dispose()
      ankoCap.dispose()
    },
    [sim, doughMat, ankoMat, doughCap, ankoCap],
  )

  useEffect(() => {
    engine.camera = camera as THREE.PerspectiveCamera
    engine.gl = gl
    engine.scene = scene
    engine.sim = sim
    engine.coreSim = core
    engine.subject = subject
    engine.squashG = squashRef.current
    engine.mochiG = mochiRef.current
    engine.dough = doughRef.current
    engine.slab = slabRef.current
    engine.photo = photoRef.current
    engine.controls = controlsRef.current
  })

  useFrame((_, dt) => stepEngine(engine, Math.min(dt, 1 / 30)))

  return (
    <>
      <color attach="background" args={['#fafafa']} />
      <hemisphereLight args={['#ffffff', '#e8e2d8', 1.15]} />
      <directionalLight position={[2.5, 4.5, 3]} intensity={1.7} />
      <directionalLight position={[0, -1, 1.5]} intensity={0.3} />
      <directionalLight position={[-3, 1.5, -2]} intensity={0.5} />
      <directionalLight position={[0, 1, 4]} intensity={0.35} />
      <group ref={squashRef} position={[0, FLOOR_Y, 0]}>
        <group ref={mochiRef} position={[0, -FLOOR_Y, 0]}>
          {core && photoMat && (
            <group position={[0, CORE_Y, 0]}>
              <mesh ref={slabRef} geometry={core.anko} material={ankoMat} visible={false} renderOrder={1}>
                <mesh geometry={core.anko} material={ankoCap} renderOrder={1} />
              </mesh>
              <mesh ref={photoRef} geometry={core.photo} material={photoMat} renderOrder={2} />
            </group>
          )}
          <mesh ref={doughRef} geometry={sim.geo} material={doughMat} visible={false} renderOrder={3}>
            <mesh geometry={sim.geo} material={doughCap} renderOrder={3} />
          </mesh>
        </group>
      </group>
      {/* 바닥 접촉 그림자: 모찌 높이만큼만 잡아 짙게 뭉치지 않도록 */}
      <ContactShadows position={[0, FLOOR_Y + 0.002, 0]} scale={6} blur={2.8} opacity={0.36} far={1.4} resolution={512} />
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enablePan={false}
        enableZoom={false}
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.6}
        minPolarAngle={0.3}
        maxPolarAngle={1.42}
        target={[TARGET.x, TARGET.y, TARGET.z]}
      />
    </>
  )
}

/* ════════════════════════════════════════════════════════════════════════
 * 7. Sound — 촉촉하고 찰진 찹쌀떡 사운드 (Web Audio 합성)
 * ════════════════════════════════════════════════════════════════════════ */

const sfx = (() => {
  let ac: AudioContext | null = null
  let bus: GainNode | null = null
  let muted = false
  let lastRub = 0
  let lastCrackle = 0
  let voice: { o: OscillatorNode; lfo: OscillatorNode; f: BiquadFilterNode; g: GainNode } | null = null

  const impulse = (a: AudioContext, dur: number) => {
    const len = Math.ceil(a.sampleRate * dur)
    const buf = a.createBuffer(2, len, a.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch)
      let prev = 0
      for (let i = 0; i < len; i++) {
        prev = prev * 0.7 + (Math.random() * 2 - 1) * 0.3
        data[i] = prev * Math.pow(1 - i / len, 3)
      }
    }
    return buf
  }

  const ctx = () => {
    if (muted) return null
    if (!ac) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return null
      ac = new AC()
      const comp = ac.createDynamicsCompressor()
      comp.threshold.value = -16
      comp.ratio.value = 4
      const master = ac.createGain()
      master.gain.value = 0.9
      const conv = ac.createConvolver()
      conv.buffer = impulse(ac, 0.32)
      const wet = ac.createGain()
      wet.gain.value = 0.24
      bus = ac.createGain()
      bus.connect(master)
      bus.connect(conv)
      conv.connect(wet)
      wet.connect(master)
      master.connect(comp)
      comp.connect(ac.destination)
    }
    if (ac.state === 'suspended') void ac.resume()
    return ac
  }

  const tone = (a: AudioContext, type: OscillatorType, f0: number, f1: number, t0: number, dur: number, gain: number, lp?: number) => {
    const o = a.createOscillator()
    const g = a.createGain()
    const t = a.currentTime + t0
    o.type = type
    o.frequency.setValueAtTime(f0, t)
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.012, dur / 4))
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    let node: AudioNode = o
    if (lp) {
      const f = a.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = lp
      node = node.connect(f)
    }
    node.connect(g).connect(bus!)
    o.start(t)
    o.stop(t + dur + 0.02)
  }

  const noise = (a: AudioContext, filter: BiquadFilterType, freq: number, q: number, t0: number, dur: number, gain: number, attack = 0.003) => {
    const len = Math.ceil(a.sampleRate * dur)
    const buf = a.createBuffer(1, len, a.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    const src = a.createBufferSource()
    src.buffer = buf
    const f = a.createBiquadFilter()
    f.type = filter
    f.frequency.value = freq
    f.Q.value = q
    const g = a.createGain()
    const t = a.currentTime + t0
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(gain, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(f).connect(g).connect(bus!)
    src.start(t)
  }

  /** '철퍽/찰싹' */
  const splat = (i = 1) => {
    const a = ctx()
    if (!a) return
    tone(a, 'sine', 150, 62, 0, 0.11, 0.24 * i)
    noise(a, 'bandpass', 850, 1.2, 0, 0.05, 0.17 * i, 0.002)
    tone(a, 'sine', 330, 190, 0.016, 0.045, 0.06 * i)
    noise(a, 'lowpass', 520, 0.7, 0.01, 0.09, 0.08 * i, 0.008)
  }

  /** 놓을 때 — 젖은 빨판이 '뽁' 떨어지는 글리산도 */
  const stretchEnd = (glide = true) => {
    const v = voice
    voice = null
    if (!v || !ac) return
    const { o, lfo, f, g } = v
    const t = ac.currentTime
    o.frequency.cancelScheduledValues(t)
    o.frequency.setValueAtTime(o.frequency.value, t)
    if (glide) o.frequency.exponentialRampToValueAtTime(360, t + 0.13)
    f.frequency.cancelScheduledValues(t)
    f.frequency.setValueAtTime(f.frequency.value, t)
    f.frequency.exponentialRampToValueAtTime(1800, t + 0.12)
    g.gain.cancelScheduledValues(t)
    g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
    o.stop(t + 0.2)
    lfo.stop(t + 0.2)
    if (glide && !muted) noise(ac, 'bandpass', 1400, 4, 0.08, 0.04, 0.05)
  }

  return {
    setMuted(m: boolean) {
      muted = m
      if (m) stretchEnd(false)
    },
    unlock() {
      ctx()
    },
    /** 다시 만들기: 오디오 그래프를 완전히 닫고 다음 제스처에서 새로 만든다 */
    reset() {
      stretchEnd(false)
      const old = ac
      ac = null
      bus = null
      lastRub = lastCrackle = 0
      void old?.close().catch(() => undefined)
    },
    splat,
    stretchEnd,
    stretchStart() {
      const a = ctx()
      if (!a || voice) return
      const o = a.createOscillator()
      o.type = 'triangle'
      o.frequency.value = 92
      const lfo = a.createOscillator()
      lfo.frequency.value = 6.5
      const lfoG = a.createGain()
      lfoG.gain.value = 3
      lfo.connect(lfoG).connect(o.frequency)
      const f = a.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = 420
      f.Q.value = 5
      const g = a.createGain()
      g.gain.value = 0.0001
      g.gain.setTargetAtTime(0.05, a.currentTime, 0.04)
      o.connect(f).connect(g).connect(bus!)
      o.start()
      lfo.start()
      voice = { o, lfo, f, g }
      noise(a, 'bandpass', 1100, 3, 0, 0.04, 0.05)
    },
    stretchUpdate(amount: number, speed: number) {
      const a = ctx()
      if (!a || !voice) return
      const t = a.currentTime
      const m = clamp(amount, 0, 1.6)
      voice.o.frequency.setTargetAtTime(82 + 70 * m, t, 0.09)
      voice.f.frequency.setTargetAtTime(380 + 900 * m, t, 0.09)
      voice.g.gain.setTargetAtTime(0.035 + 0.045 * Math.min(1, m), t, 0.08)
      const now = performance.now()
      if (speed > 0.6 && now - lastCrackle > 55 + Math.random() * 90) {
        lastCrackle = now
        noise(a, 'bandpass', 700 + Math.random() * 900, 7, 0, 0.022, 0.025 + 0.02 * Math.min(1, speed / 3), 0.002)
      }
    },
    /** '쫩/우묵' */
    bite() {
      const a = ctx()
      if (!a) return
      noise(a, 'bandpass', 1250, 1.8, 0, 0.04, 0.13, 0.002)
      tone(a, 'sine', 210, 82, 0, 0.22, 0.26, 520)
      noise(a, 'lowpass', 780, 0.8, 0.02, 0.24, 0.12, 0.03)
      tone(a, 'triangle', 270, 140, 0.13, 0.09, 0.08, 900)
      noise(a, 'bandpass', 460, 4, 0.24, 0.13, 0.05, 0.02)
    },
    rub() {
      const now = performance.now()
      if (now - lastRub < 95) return
      lastRub = now
      const a = ctx()
      if (!a) return
      noise(a, 'bandpass', 560 + Math.random() * 200, 0.9, 0, 0.1, 0.045, 0.03)
      tone(a, 'sine', 120, 95, 0, 0.08, 0.025)
    },
    coat() {
      const a = ctx()
      if (!a) return
      noise(a, 'lowpass', 650, 1.4, 0, 0.42, 0.1, 0.12)
      tone(a, 'triangle', 85, 120, 0, 0.36, 0.06, 400)
      noise(a, 'bandpass', 900, 3, 0.3, 0.05, 0.05)
    },
    seal() {
      splat(1.15)
      const a = ctx()
      if (!a) return
      noise(a, 'lowpass', 520, 0.8, 0.04, 0.4, 0.09, 0.06)
      tone(a, 'sine', 110, 58, 0.03, 0.34, 0.12)
    },
    done() {
      const a = ctx()
      if (!a) return
      tone(a, 'sine', 660, 660, 0, 0.9, 0.05)
      tone(a, 'sine', 990, 990, 0.08, 0.8, 0.025)
    },
  }
})()

const buzz = (pattern: number | number[]) => {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* 미지원 브라우저 */
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * 8. 2D 파티클 오버레이 (전분 가루 / 떡 부스러기)
 * ════════════════════════════════════════════════════════════════════════ */

type Particle = { kind: 'powder' | 'crumb'; x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; rot: number; vr: number }

function makePowderSprite() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(232,230,226,0.8)')
  g.addColorStop(0.5, 'rgba(238,236,233,0.35)')
  g.addColorStop(1, 'rgba(240,238,235,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  return c
}

/** 완식 결과 카드 (3D 스냅샷 + 미니멀 타이포) */
async function composeResult(shot: string, anko: AnkoStyle, bites: number) {
  const font = '"Pretendard Variable", Pretendard, Inter, system-ui, sans-serif'
  try {
    await Promise.all([document.fonts.load(`200 120px ${font}`), document.fonts.load(`400 30px ${font}`)])
  } catch {
    /* 시스템 폰트로 진행 */
  }
  const W = 1080
  const H = 1350
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  const spacing = (v: string) => ((ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = v)
  ctx.fillStyle = '#fafafa'
  ctx.fillRect(0, 0, W, H)
  const d = new Date()
  const date = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
  ctx.fillStyle = '#111111'
  ctx.font = `400 26px ${font}`
  spacing('6px')
  ctx.textAlign = 'left'
  ctx.fillText('MOCHI', 80, 110)
  ctx.textAlign = 'right'
  ctx.fillStyle = '#8a8a8a'
  ctx.fillText(date, W - 80, 110)
  spacing('0px')
  ctx.fillStyle = '#e4e4e4'
  ctx.fillRect(80, 140, W - 160, 2)

  const img = new Image()
  img.src = shot
  await img.decode()
  const side = Math.min(img.width, img.height) * 0.94
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 115, 170, 850, 850)

  ctx.fillStyle = '#e4e4e4'
  ctx.fillRect(80, H - 300, W - 160, 2)
  ctx.textAlign = 'left'
  ctx.fillStyle = '#111111'
  ctx.font = `200 120px ${font}`
  ctx.fillText('完食', 72, H - 140)
  ctx.font = `300 32px ${font}`
  ctx.fillStyle = '#8a8a8a'
  ctx.fillText(`${anko.label} · ${bites} bites`, 80, H - 86)
  ctx.textAlign = 'right'
  ctx.fillText(`No. ${String(((Date.now() / 1000) | 0) % 1000).padStart(3, '0')}`, W - 80, H - 86)
  return c.toDataURL('image/png')
}

/* ════════════════════════════════════════════════════════════════════════
 * 9. App
 * ════════════════════════════════════════════════════════════════════════ */

type Gesture = 'none' | 'hold' | 'core' | 'pull' | 'rub' | 'squish' | 'bite'

export default function MochiApp() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [muted, setMuted] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [canShare, setCanShare] = useState(false)

  const engineRef = useRef<Engine>(createEngine())
  const wrapRef = useRef<HTMLDivElement>(null)
  const fxRef = useRef<HTMLCanvasElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const phaseRef = useRef<Phase>(state.phase)
  const modeRef = useRef<Mode>(state.mode)
  const particlesRef = useRef<Particle[]>([])
  const timersRef = useRef<number[]>([])
  const lastShotRef = useRef<string | null>(null)
  const finishingRef = useRef(false)
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const gestRef = useRef({
    id: -1,
    kind: 'none' as Gesture,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    lastT: 0,
    lastAng: 0,
    stretching: false,
    plane: new THREE.Plane(),
  })

  phaseRef.current = state.phase
  modeRef.current = state.mode
  engineRef.current.phase = state.phase

  useEffect(() => {
    setCanShare(typeof navigator.canShare === 'function')
    return () => {
      segWorker?.terminate()
      segWorker = null
    }
  }, [])

  /* ── 2D 파티클 루프 ─────────────────────────────────────────── */
  useEffect(() => {
    const sprite = makePowderSprite()
    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(0.033, (now - last) / 1000)
      last = now
      const c = fxRef.current
      if (c) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        if (c.width !== Math.round(window.innerWidth * dpr)) {
          c.width = Math.round(window.innerWidth * dpr)
          c.height = Math.round(window.innerHeight * dpr)
        }
        const ctx = c.getContext('2d')!
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, c.width, c.height)
        const list = particlesRef.current
        if (list.length) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          let w = 0
          for (const p of list) {
            p.life += dt
            if (p.life >= p.max) continue
            const u = p.life / p.max
            if (p.kind === 'powder') {
              p.vx *= Math.exp(-dt * 2.4)
              p.vy = p.vy * Math.exp(-dt * 2.4) + 18 * dt
              p.x += p.vx * dt
              p.y += p.vy * dt
              const s = p.size * (1 + u * 1.3)
              ctx.globalAlpha = 0.45 * (1 - u) * Math.min(1, p.life * 6)
              ctx.drawImage(sprite, p.x - s / 2, p.y - s / 2, s, s)
            } else {
              p.vy += 1100 * dt
              p.x += p.vx * dt
              p.y += p.vy * dt
              p.rot += p.vr * dt
              ctx.globalAlpha = 1 - u * u
              ctx.save()
              ctx.translate(p.x, p.y)
              ctx.rotate(p.rot)
              ctx.fillStyle = '#f3f1ee'
              ctx.strokeStyle = 'rgba(0,0,0,0.12)'
              ctx.lineWidth = 0.75
              ctx.beginPath()
              ctx.ellipse(0, 0, p.size, p.size * 0.7, 0, 0, TAU)
              ctx.fill()
              ctx.stroke()
              ctx.restore()
            }
            list[w++] = p
          }
          list.length = w
          ctx.globalAlpha = 1
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const spawnPowder = (cx: number, cy: number, count: number, speed = 70, spread = 20) => {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU
      const v = speed * (0.3 + Math.random())
      particlesRef.current.push({
        kind: 'powder',
        x: cx + (Math.random() - 0.5) * spread,
        y: cy + (Math.random() - 0.5) * spread,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 20,
        life: 0,
        max: 1.1 + Math.random() * 1.2,
        size: 10 + Math.random() * 20,
        rot: 0,
        vr: 0,
      })
    }
  }
  const spawnCrumbs = (cx: number, cy: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU
      const v = 140 + Math.random() * 220
      particlesRef.current.push({
        kind: 'crumb',
        x: cx,
        y: cy,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 200,
        life: 0,
        max: 0.8 + Math.random() * 0.6,
        size: 2.5 + Math.random() * 5,
        rot: Math.random() * TAU,
        vr: (Math.random() - 0.5) * 12,
      })
    }
  }

  /* ── 3D 헬퍼 ────────────────────────────────────────────────── */
  const isBitten = (p: THREE.Vector3) =>
    engineRef.current.bites.some((b) => Math.hypot(p.x - b.x, p.y - b.y, p.z - b.z) < b.r * 0.9)

  /** 화면 좌표 → 보이는(베어 먹히지 않은) 첫 표면 */
  const pick = (cx: number, cy: number, objs: (THREE.Object3D | null)[]) => {
    const e = engineRef.current
    if (!e.camera || !e.gl || !e.mochiG) return null
    const rect = e.gl.domElement.getBoundingClientRect()
    raycaster.setFromCamera(
      new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1),
      e.camera,
    )
    const list = objs.filter((o): o is THREE.Object3D => !!o && o.visible && (!o.parent || o.parent.visible))
    for (const hit of raycaster.intersectObjects(list, false)) {
      if (hit.object === e.photo && e.subject && hit.uv && e.subject.alphaAt(hit.uv.x, hit.uv.y) < 128) continue
      const local = e.mochiG.worldToLocal(hit.point.clone())
      if (!isBitten(local)) return { hit, local }
    }
    return null
  }

  const toScreen = (x: number, y: number, z: number) => {
    const e = engineRef.current
    if (!e.camera || !e.gl || !e.mochiG) return { x: 0, y: 0 }
    const v = e.mochiG.localToWorld(new THREE.Vector3(x, y, z)).project(e.camera)
    const rect = e.gl.domElement.getBoundingClientRect()
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height }
  }

  /** 현재 시선 방향을 모찌 좌표계로 */
  const viewLocal = () => {
    const e = engineRef.current
    if (!e.camera || !e.mochiG) return { vx: 0, vy: 0, vz: -1 }
    const inv = new THREE.Matrix4().copy(e.mochiG.matrixWorld).invert()
    const v = e.camera.getWorldDirection(new THREE.Vector3()).transformDirection(inv)
    return { vx: v.x, vy: v.y, vz: v.z }
  }

  const snapshot = () => {
    const e = engineRef.current
    if (!e.gl || !e.scene || !e.camera) return null
    e.gl.render(e.scene, e.camera)
    return e.gl.domElement.toDataURL('image/png')
  }

  const later = (fn: () => void, ms: number) => timersRef.current.push(window.setTimeout(fn, ms))

  /* ── 완식 ──────────────────────────────────────────────────── */
  const finish = async (shot?: string | null) => {
    if (finishingRef.current || phaseRef.current !== 'play') return
    finishingRef.current = true
    const img = shot ?? snapshot()
    if (!img) {
      finishingRef.current = false
      return
    }
    const url = await composeResult(img, ANKO_STYLE[state.anko], engineRef.current.bites.length)
    dispatch({ type: 'DONE', result: url })
  }

  /* ── 한 입 베어물기 (무제한 — 남은 양이 0이 될 때까지) ───────── */
  const doBite = (local: THREE.Vector3, clientX: number, clientY: number) => {
    const e = engineRef.current
    if (!e.mochiG || e.bites.length >= BITE_TEX) return
    // 마지막 한 입 직전 모습을 결과 카드에 남김 (ReadPixels 비용 때문에 끝 무렵에만)
    if (e.aliveCount / e.alive.length < 0.3) lastShotRef.current = snapshot()
    const inv = new THREE.Matrix4().copy(e.mochiG.matrixWorld).invert()
    const dir = raycaster.ray.direction.clone().transformDirection(inv)
    const c = local.clone().addScaledVector(dir, 0.14)
    const r = BITE_R * (0.92 + Math.random() * 0.16)
    const data = e.uniforms.uBites.value.image.data as unknown as Float32Array
    const i = e.bites.length
    data.set([c.x, c.y, c.z, r], i * 4)
    data.set([dir.x, dir.y, dir.z, Math.random() * 100], (BITE_TEX + i) * 4)
    e.uniforms.uBites.value.needsUpdate = true
    e.bites.push({ x: c.x, y: c.y, z: c.z, r })
    e.uniforms.uBiteCount.value = e.bites.length
    const S = e.samples
    for (let k = 0; k < e.alive.length; k++) {
      if (!e.alive[k]) continue
      if (Math.hypot(S[k * 3] - c.x, S[k * 3 + 1] - c.y, S[k * 3 + 2] - c.z) < r * 0.92) {
        e.alive[k] = 0
        e.aliveCount--
      }
    }
    const remaining = e.aliveCount / e.alive.length

    sfx.bite()
    buzz([16, 30, 10])
    spawnCrumbs(clientX, clientY, 10)
    spawnPowder(clientX, clientY, 8, 80)
    e.squash.vy -= 0.6
    const s = e.sim
    if (s) {
      for (let k = 0; k < s.n; k++) {
        const j = k * 3
        const w = Math.exp(-((s.F[j] - c.x) ** 2 + (s.F[j + 1] - c.y) ** 2 + (s.F[j + 2] - c.z) ** 2) / 0.4)
        s.vel[j] -= s.nrm[j] * 0.8 * w
        s.vel[j + 1] -= s.nrm[j + 1] * 0.8 * w
        s.vel[j + 2] -= s.nrm[j + 2] * 0.8 * w
      }
    }
    dispatch({ type: 'BITE', remaining })
    if (remaining < 0.015) later(() => void finish(lastShotRef.current), 750)
  }

  /* ── 반죽 감싸기 ────────────────────────────────────────────── */
  const tryStartPull = (local: THREE.Vector3, hitPoint: THREE.Vector3) => {
    const e = engineRef.current
    const s = e.sim
    if (!s || !e.camera) return false
    // 잡은 자리에서 가장 가까운, 아직 덮이지 않은 시트 꼭짓점
    const pos = s.geo.attributes.position.array as Float32Array
    let gi = -1
    let bd = 0.75 * 0.75 // 이미 덮인 곳을 잡아도 가까운 덮이지 않은 가장자리를 잡아줌
    for (let i = 0; i < s.n; i++) {
      if (s.rho[i] < GRAB_RHO || s.cBase[i] > 0.5) continue
      const d = (pos[i * 3] - local.x) ** 2 + (pos[i * 3 + 1] - local.y) ** 2 + (pos[i * 3 + 2] - local.z) ** 2
      if (d < bd) {
        bd = d
        gi = i
      }
    }
    if (gi < 0) return false
    // 함께 끌려오는 범위: 잡은 지점에서 시트 위 호 길이로 퍼지는 가중치 (앙금 발밑은 고정)
    const pg = s.phi[gi]
    for (let i = 0; i < s.n; i++) {
      const r = s.rho[i] * SHEET_R
      const arc = angDiff(s.phi[i], pg) * Math.max(r, 0.6)
      const radial = smoothstep(GRAB_RHO - 0.12, GRAB_RHO + 0.1, s.rho[i])
      s.w[i] = gauss(arc, 1.1) * radial * (1 - s.cBase[i])
    }
    gestRef.current.plane.setFromNormalAndCoplanarPoint(e.camera.getWorldDirection(new THREE.Vector3()).negate(), hitPoint)
    e.pull = { active: true, gi, dx: 0, dy: 0, dz: 0 }
    sfx.stretchStart()
    buzz(6)
    return true
  }

  const releasePull = () => {
    const e = engineRef.current
    const s = e.sim
    sfx.stretchEnd()
    if (!s || !e.pull.active) return
    e.pull.active = false
    // 잡은 끝이 앙금 위까지 넘어왔으면 성공 — 아니면 끈적하게 원래 자리로 되돌아감
    const pos = s.geo.attributes.position.array as Float32Array
    const g = e.pull.gi * 3
    const startR = Math.hypot(s.O[g], s.O[g + 2])
    const nowR = Math.hypot(pos[g], pos[g + 2])
    // 축 가까이 끌어왔거나, 앙금 옆면을 타고 충분히 높이 올라왔으면 성공
    const stuck = nowR < startR * 0.45 || pos[g + 1] > FLOOR_Y + 0.55
    if (!stuck) return
    // '착' — 늘어난 반죽이 앙금에 들러붙어 고정
    for (let i = 0; i < s.n; i++) s.cBase[i] = Math.max(s.cBase[i], smoothstep(0.2, 0.6, s.w[i]))
    e.pulls++
    window.setTimeout(() => sfx.splat(1), 40)
    buzz([10, 30, 14])
    const tip = toScreen(0, TOP_Y * 0.9, 0)
    spawnPowder(tip.x, tip.y, 8, 50, 30)
    let sum = 0
    let cnt = 0
    for (let i = 0; i < s.n; i++)
      if (s.rho[i] > GRAB_RHO) {
        sum += s.cBase[i]
        cnt++
      }
    const cover = sum / cnt
    dispatch({ type: 'SET_COVER', cover })
    if (cover >= 0.85 || e.pulls >= 5) {
      // 남은 틈은 봉합하며 이음매로 남김 → 성형 단계에서 둥글게 다듬음
      for (let i = 0; i < s.n; i++) {
        s.seam[i] = (s.rho[i] > GRAB_RHO ? 1 - s.cBase[i] : 0) + (s.rho[i] > 0.85 ? (s.rho[i] - 0.85) * 4 : 0)
        s.cBase[i] = 1
      }
      later(() => {
        // 감싸기 결과를 소프트바디 기준 형태로 확정
        for (let i = 0; i < s.n; i++) s.c[i] = 1
        dispatch({ type: 'WRAPPED' })
      }, 700)
    }
  }

  /* ── Pointer: 반죽/코어에 닿으면 반죽 제스처, 빈 곳이면 OrbitControls 회전 ── */
  // 캡처 단계에서 먼저 레이캐스트해서, 반죽을 잡은 경우 OrbitControls를 끈 채로 이벤트가 내려가게 함
  const onPointerDownCapture = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const e = engineRef.current
    const g = gestRef.current
    const ph = phaseRef.current
    if (g.id !== -1 || !e.camera) return
    if (!(ph === 'filling' || ph === 'coating' || ph === 'wrapping' || ph === 'shaping' || ph === 'play')) return
    sfx.unlock()
    const { clientX: x, clientY: y } = ev
    let kind: Gesture = 'none'
    if (ph === 'filling' || ph === 'coating') {
      if (pick(x, y, [e.slab, e.photo])) kind = 'core'
    } else if (ph === 'wrapping') {
      const p = pick(x, y, [e.dough])
      // 반죽 위를 누른 경우엔 잡을 곳이 없어도 시점이 돌아가지 않게 제스처를 소비
      if (p) kind = tryStartPull(p.local, p.hit.point) ? 'pull' : 'hold'
    } else if (ph === 'shaping') {
      const p = pick(x, y, [e.dough])
      if (p) {
        kind = 'rub'
        e.press = { active: true, gx: p.local.x, gy: p.local.y, gz: p.local.z, dx: 0, dy: 0, dz: 0, dragging: false, ...viewLocal() }
      }
    } else {
      // 구멍 안쪽 단면(캡)도 대상 → 이미 베어문 자리 안쪽을 계속 베어먹을 수 있음
      const p = pick(x, y, [e.dough, e.dough?.children[0] ?? null, e.slab, e.slab?.children[0] ?? null, e.photo])
      if (p) {
        if (modeRef.current === 'bite') {
          kind = 'bite'
          doBite(p.local, x, y)
        } else {
          kind = 'squish'
          e.press = { active: true, gx: p.local.x, gy: p.local.y, gz: p.local.z, dx: 0, dy: 0, dz: 0, dragging: false, ...viewLocal() }
          g.plane.setFromNormalAndCoplanarPoint(e.camera.getWorldDirection(new THREE.Vector3()).negate(), p.hit.point)
        }
      }
    }
    if (kind === 'none') return // → OrbitControls가 시점을 돌림
    if (e.controls) e.controls.enabled = false
    ev.currentTarget.setPointerCapture(ev.pointerId)
    const c = toScreen(0, 0, 0)
    Object.assign(g, {
      id: ev.pointerId,
      kind,
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      lastT: performance.now(),
      lastAng: Math.atan2(y - c.y, x - c.x),
      stretching: false,
    })
    if (kind === 'core' || kind === 'squish') {
      e.squash.ty = 0.94
      sfx.splat(0.55)
      buzz(6)
    }
  }

  const onPointerMove = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestRef.current
    if (ev.pointerId !== g.id) return
    const e = engineRef.current
    const { clientX: x, clientY: y } = ev
    const now = performance.now()
    const speed = Math.hypot(x - g.lastX, y - g.lastY) / Math.max(1, now - g.lastT)
    g.lastX = x
    g.lastY = y
    g.lastT = now

    if (g.kind === 'pull' && e.camera && e.gl && e.mochiG && e.sim) {
      const rect = e.gl.domElement.getBoundingClientRect()
      raycaster.setFromCamera(
        new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1),
        e.camera,
      )
      const wp = raycaster.ray.intersectPlane(g.plane, new THREE.Vector3())
      if (wp) {
        const lp = e.mochiG.worldToLocal(wp)
        const gi = e.pull.gi * 3
        const O = e.sim.O
        const dx = lp.x - O[gi]
        const dz = lp.z - O[gi + 2]
        // 손가락 위치까지 쭉 늘어나되, 위로 살짝 들려 아치를 그림
        e.pull.dx = dx
        e.pull.dy = lp.y - O[gi + 1] + 0.18 * Math.hypot(dx, dz)
        e.pull.dz = dz
        sfx.stretchUpdate(Math.hypot(dx, dz) / 1.6, speed)
      }
    } else if (g.kind === 'rub') {
      const c = toScreen(0, 0, 0)
      const a = Math.atan2(y - c.y, x - c.x)
      const da = wrapAngle(a - g.lastAng)
      g.lastAng = a
      if (Math.abs(da) < 1) {
        e.rollPhase += da
        const next = Math.min(1, e.roll + Math.abs(da) / (TAU * 2.5))
        if (Math.floor(next * 20) !== Math.floor(e.roll * 20)) {
          sfx.rub()
          buzz(3)
        }
        e.roll = next
        dispatch({ type: 'SET_ROLL', value: next })
        if (next >= 1) dispatch({ type: 'SHAPED' })
      }
    } else if (g.kind === 'squish' && e.camera && e.gl && e.mochiG) {
      const rect = e.gl.domElement.getBoundingClientRect()
      raycaster.setFromCamera(
        new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1),
        e.camera,
      )
      const wp = raycaster.ray.intersectPlane(g.plane, new THREE.Vector3())
      const dpx = Math.hypot(x - g.startX, y - g.startY)
      if (wp && dpx > 8) {
        const lp = e.mochiG.worldToLocal(wp)
        Object.assign(e.press, { dx: lp.x - e.press.gx, dy: lp.y - e.press.gy, dz: lp.z - e.press.gz, dragging: true })
        if (!g.stretching) {
          g.stretching = true
          sfx.stretchStart()
        }
        sfx.stretchUpdate(Math.hypot(e.press.dx, e.press.dy, e.press.dz), speed)
      }
    }
  }

  const onPointerUp = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestRef.current
    if (ev.pointerId !== g.id) return
    const e = engineRef.current
    if (g.kind === 'pull') releasePull()
    if (g.stretching) sfx.stretchEnd()
    e.press.active = false
    e.press.dragging = false
    e.squash.ty = 1
    if (e.controls) e.controls.enabled = true
    g.id = -1
    g.kind = 'none'
    g.stretching = false
  }

  /* ── 단계 진입 효과 ─────────────────────────────────────────── */
  useEffect(() => {
    const e = engineRef.current
    if (state.phase === 'coating') {
      e.coatT = 0
      sfx.coat()
    }
    if (state.phase === 'wrapping') e.camNudge = 1.4
    if (state.phase === 'shaping') {
      e.roll = 0
      e.rollPhase = 0
    }
    if (state.phase === 'play') {
      e.camFront = 1.6
      // 봉합 완료
      sfx.seal()
      buzz([16, 40, 16])
      e.squash.y = 1.07
      e.squash.vy = 0
      const c = toScreen(0, 0, 0)
      spawnPowder(c.x, c.y + 40, 30, 120, 160)
      finishingRef.current = false
    }
    if (state.phase === 'done') sfx.done()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(t)
  }, [toast])

  /* ── 업로드 & AI 누끼 ───────────────────────────────────────── */
  const processPhoto = async (getPhoto: () => Promise<HTMLCanvasElement>) => {
    if (phaseRef.current !== 'upload') return
    sfx.unlock()
    dispatch({ type: 'PROCESS_START' })
    const session = state.session
    try {
      const photo = await getPhoto()
      const plain = buildSubject(photo, null, 'plain')
      if (hasTransparency(photo)) {
        // 투명 PNG는 그대로 통과
        dispatch({ type: 'SUBJECT_READY', subject: buildSubject(photo, null, 'png'), alt: plain })
        return
      }
      try {
        const mask = await runSegmentation(photo, (msg) => dispatch({ type: 'PROCESS_MSG', msg }))
        if (session !== state.session) return
        dispatch({ type: 'SUBJECT_READY', subject: buildSubject(photo, mask, 'mask'), alt: plain })
      } catch {
        dispatch({ type: 'SUBJECT_READY', subject: plain, alt: null })
        setToast('AI 모델을 불러오지 못해 원본을 사용합니다')
      }
    } catch {
      dispatch({ type: 'PROCESS_FAILED' })
      setToast('이미지를 열 수 없습니다. JPG 또는 PNG를 사용해 주세요')
    }
  }

  const handleFile = (file: File | undefined | null) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setToast('이미지 파일만 업로드할 수 있습니다')
      return
    }
    void processPhoto(() => fileToCanvas(file))
  }

  /** 다시 만들기: 업로드 이미지, 3D 메시/머티리얼, 오디오, 타이머, 파티클을 전부 초기화 */
  const reset = () => {
    timersRef.current.forEach(clearTimeout)
    timersRef.current = []
    particlesRef.current = []
    lastShotRef.current = null
    finishingRef.current = false
    const g = gestRef.current
    g.id = -1
    g.kind = 'none'
    g.stretching = false
    const old = engineRef.current
    if (old.controls) old.controls.enabled = true
    old.uniforms.uBites.value.dispose()
    engineRef.current = createEngine() // 새 세션은 새 엔진 + 새 Scene(key=session)
    sfx.reset()
    if (fileRef.current) fileRef.current.value = ''
    if (cameraRef.current) cameraRef.current.value = ''
    dispatch({ type: 'RESET' })
  }

  /* ── 결과 저장/공유 ─────────────────────────────────────────── */
  const resultBlob = async () => (await fetch(state.result!)).blob()
  const saveResult = async () => {
    if (!state.result) return
    const url = URL.createObjectURL(await resultBlob())
    const a = document.createElement('a')
    a.href = url
    a.download = `mochi-${Date.now()}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 4000)
    setToast('이미지를 저장했습니다')
  }
  const shareResult = async () => {
    if (!state.result) return
    const file = new File([await resultBlob()], 'mochi.png', { type: 'image/png' })
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Mochi' })
      } catch {
        /* 사용자가 취소 */
      }
    } else void saveResult()
  }

  /* ── UI ─────────────────────────────────────────────────────── */
  const hint = (() => {
    switch (state.phase) {
      case 'filling':
        return state.subject?.cut ? '피사체를 오려냈습니다 · 빈 곳을 드래그하면 돌려볼 수 있어요' : '원본 이미지를 사용합니다'
      case 'coating':
        return '피사체를 감쌀 앙금을 골라주세요'
      case 'wrapping':
        return '빛나는 반죽 가장자리를 잡고 앙금 위로 쭉 늘려 덮어주세요'
      case 'shaping':
        return '반죽 위에서 원을 그리며 문질러 둥글게 빚어주세요'
      case 'play':
        return state.mode === 'squish' ? '반죽을 누르거나 끌어당겨 늘려보세요' : '원하는 곳을 눌러 베어뭅니다 · 마지막 한 조각까지'
      default:
        return ' '
    }
  })()
  const step = stepIndex(state.phase)
  const showStage = state.phase !== 'upload' && state.phase !== 'processing'

  return (
    <div
      className="fixed inset-0 overflow-hidden bg-paper text-ink"
      onDragOver={(e) => {
        if (state.phase !== 'upload') return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        handleFile(e.dataTransfer.files?.[0])
      }}
    >
      {/* 3D 스테이지 */}
      <div
        ref={wrapRef}
        className="absolute inset-x-0 top-[104px] bottom-[150px]"
        style={{ touchAction: 'none', visibility: showStage ? 'visible' : 'hidden' }}
        onPointerDownCapture={onPointerDownCapture}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Canvas
          dpr={[1, 2]}
          camera={{ position: [0, 0.75, 5.2], fov: 32, near: 0.5, far: 30 }}
          gl={{ preserveDrawingBuffer: true, antialias: true }}
        >
          <Scene key={state.session} engine={engineRef.current} subject={state.subject} anko={state.anko} />
        </Canvas>
      </div>

      {/* 헤더 */}
      <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-5 pt-[max(env(safe-area-inset-top),18px)]">
        <span className="text-[12px] font-medium tracking-[0.32em]">MOCHI</span>
        <div className="flex items-center gap-3 text-[11px] tracking-[0.12em] text-mute">
          <span className="tabular-nums text-ink">{String(step + 1).padStart(2, '0')}</span>
          <span className="h-px w-6 bg-line" />
          <span>{STEPS[step]}</span>
        </div>
        <div className="flex items-center gap-2">
          {state.phase === 'play' && (
            <button
              type="button"
              onClick={() => void finish()}
              className="flex h-9 items-center gap-1.5 rounded-full border border-line bg-white px-3 text-[12px] transition-colors hover:border-ink"
            >
              <Check size={14} strokeWidth={1.25} />
              완식
            </button>
          )}
          <button
            aria-label={muted ? '소리 켜기' : '소리 끄기'}
            className="grid h-9 w-9 place-items-center rounded-full border border-line bg-white text-ink transition-colors hover:border-ink"
            onClick={() => {
              sfx.setMuted(!muted)
              setMuted(!muted)
            }}
          >
            {muted ? <VolumeX size={15} strokeWidth={1.25} /> : <Volume2 size={15} strokeWidth={1.25} />}
          </button>
        </div>
      </header>

      {/* 안내 문구 */}
      <div className="pointer-events-none absolute inset-x-0 top-[64px] z-10 flex justify-center px-6">
        <AnimatePresence mode="wait">
          {state.phase === 'upload' ? null : (
            <motion.p
              key={hint}
              className="text-center text-[13px] text-mute"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
            >
              {hint}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* 업로드 / 처리 중 */}
      <AnimatePresence>
        {(state.phase === 'upload' || state.phase === 'processing') && (
          <motion.div
            key="intro"
            className="absolute inset-x-0 top-[96px] bottom-[150px] z-10 flex flex-col items-center justify-center px-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <h1 className="mb-8 max-w-[19rem] text-center text-[19px] font-light leading-[1.6] tracking-[-0.02em]">
              찹쌀떡으로 감싸버리고 싶은 것이 있다면
              <br />
              첨부해주세요
            </h1>
            <button
              type="button"
              disabled={state.phase === 'processing'}
              onClick={() => fileRef.current?.click()}
              className={`flex aspect-square w-[min(72vw,320px)] flex-col items-center justify-center gap-4 rounded-full border transition-colors ${
                dragOver ? 'border-ink bg-white' : 'border-line bg-white/60 hover:border-mute'
              }`}
            >
              {state.phase === 'processing' ? (
                <>
                  <motion.span
                    className="h-8 w-8 rounded-full border border-line border-t-ink"
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }}
                  />
                  <span className="px-8 text-center text-[12px] text-mute">{state.loadMsg}</span>
                </>
              ) : (
                <>
                  <Plus size={28} strokeWidth={1} />
                  <span className="text-[11px] tracking-[0.24em] text-mute">DROP IMAGE</span>
                </>
              )}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 진행 표시 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[118px] z-10 flex h-4 justify-center">
        {state.phase === 'wrapping' && (
          <div className="flex items-center gap-3 text-[11px] text-mute">
            <div className="relative h-px w-32 bg-line">
              <div className="absolute inset-y-0 left-0 bg-ink" style={{ width: `${state.cover * 100}%` }} />
            </div>
            <span className="tabular-nums">덮음 {Math.round(state.cover * 100)}%</span>
          </div>
        )}
        {state.phase === 'shaping' && (
          <div className="flex items-center gap-3 text-[11px] text-mute">
            <div className="relative h-px w-32 bg-line">
              <div className="absolute inset-y-0 left-0 bg-ink" style={{ width: `${state.roll * 100}%` }} />
            </div>
            <span className="w-8 tabular-nums">{Math.round(state.roll * 100)}%</span>
          </div>
        )}
        {state.phase === 'play' && (
          <span className="text-[11px] tabular-nums text-mute">
            {state.bites}입 · 남은 양 {Math.max(0, Math.round(state.remaining * 100))}%
          </span>
        )}
      </div>

      <canvas ref={fxRef} className="pointer-events-none fixed inset-0 z-40 h-full w-full" />

      {/* 하단 플로팅 컨트롤 */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-5 pb-[max(env(safe-area-inset-bottom),20px)]">
        <AnimatePresence mode="wait">
          {state.phase === 'upload' && (
            <BottomBar key="upload">
              <button
                type="button"
                onClick={() => void processPhoto(async () => makeSamplePhoto())}
                className="mb-3 self-center text-[12px] text-mute underline decoration-line underline-offset-4 hover:text-ink"
              >
                샘플 이미지로 시작
              </button>
              <div className="flex gap-2">
                <LineButton onClick={() => cameraRef.current?.click()} icon={<Camera size={16} strokeWidth={1.25} />}>
                  촬영
                </LineButton>
                <LineButton primary grow onClick={() => fileRef.current?.click()} icon={<Plus size={16} strokeWidth={1.25} />}>
                  사진 첨부
                </LineButton>
              </div>
            </BottomBar>
          )}

          {state.phase === 'filling' && (
            <BottomBar key="filling">
              <div className="flex gap-2">
                <LineButton onClick={reset} icon={<RotateCcw size={15} strokeWidth={1.25} />} label="다른 사진" />
                {state.alt && (
                  <LineButton
                    onClick={() => dispatch({ type: 'TOGGLE_CUTOUT' })}
                    icon={<Scissors size={15} strokeWidth={1.25} />}
                    active={state.subject?.cut}
                  >
                    배경 제거
                  </LineButton>
                )}
                <LineButton
                  primary
                  grow
                  onClick={() => dispatch({ type: 'START_COAT' })}
                  icon={<ArrowRight size={16} strokeWidth={1.25} />}
                  iconRight
                >
                  앙금 입히기
                </LineButton>
              </div>
            </BottomBar>
          )}

          {state.phase === 'coating' && (
            <BottomBar key="coating">
              <div className="mb-2 flex rounded-full border border-line bg-white p-1">
                {(['red', 'white'] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => {
                      if (a === state.anko) return
                      engineRef.current.coatT = 0.4
                      sfx.coat()
                      buzz(5)
                      dispatch({ type: 'SET_ANKO', anko: a })
                    }}
                    className={`flex h-10 flex-1 items-center justify-center gap-2 rounded-full text-[14px] transition-colors duration-300 ${
                      state.anko === a ? 'bg-ink text-white' : 'text-mute hover:text-ink'
                    }`}
                  >
                    <span className="h-3 w-3 rounded-full border border-white/40" style={{ background: ANKO_STYLE[a].swatch }} />
                    {ANKO_STYLE[a].label}
                  </button>
                ))}
              </div>
              <LineButton
                primary
                onClick={() => dispatch({ type: 'START_WRAP' })}
                icon={<ArrowRight size={16} strokeWidth={1.25} />}
                iconRight
              >
                떡 피로 감싸기
              </LineButton>
            </BottomBar>
          )}

          {state.phase === 'play' && (
            <BottomBar key="play">
              <div className="flex rounded-full border border-line bg-white p-1">
                {(
                  [
                    { m: 'squish', label: '늘리기', icon: <Hand size={16} strokeWidth={1.25} /> },
                    { m: 'bite', label: '베어물기', icon: <Utensils size={16} strokeWidth={1.25} /> },
                  ] as const
                ).map(({ m, label, icon }) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      dispatch({ type: 'SET_MODE', mode: m })
                      buzz(4)
                    }}
                    className={`flex h-11 flex-1 items-center justify-center gap-2 rounded-full text-[14px] transition-colors duration-300 ${
                      state.mode === m ? 'bg-ink text-white' : 'text-mute hover:text-ink'
                    }`}
                  >
                    {icon}
                    {label}
                  </button>
                ))}
              </div>
            </BottomBar>
          )}
        </AnimatePresence>
      </div>

      {/* 완식 화면 */}
      <AnimatePresence>
        {state.phase === 'done' && state.result && (
          <motion.div
            key="done"
            className="fixed inset-0 z-[55] flex flex-col items-center justify-center bg-paper/95 px-6 pb-32 pt-16 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="flex items-baseline gap-4">
              <h1 className="text-5xl font-extralight tracking-tight">完食</h1>
              <span className="text-[12px] tracking-[0.2em] text-mute">{state.bites} BITES</span>
            </div>
            <img
              src={state.result}
              alt="완식 결과"
              className="mt-8 max-h-[52vh] w-[72vw] max-w-[320px] border border-line object-contain"
            />
            <div className="fixed inset-x-0 bottom-0 flex justify-center px-5 pb-[max(env(safe-area-inset-bottom),20px)]">
              <div className="flex w-full max-w-md gap-2">
                <LineButton onClick={reset} icon={<RotateCcw size={15} strokeWidth={1.25} />}>
                  다시 만들기
                </LineButton>
                <LineButton primary grow onClick={saveResult} icon={<Download size={16} strokeWidth={1.25} />}>
                  이미지 저장
                </LineButton>
                {canShare && <LineButton onClick={shareResult} icon={<Share2 size={15} strokeWidth={1.25} />} label="공유" />}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 토스트 */}
      <AnimatePresence>
        {toast && (
          <motion.div
            className="fixed left-1/2 top-[max(env(safe-area-inset-top),18px)] z-[60] mt-12 -translate-x-1/2 whitespace-nowrap border border-line bg-white px-4 py-2 text-[12px] text-ink"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          handleFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          handleFile(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}

/* ════════════════════════════════════════════════════════════════════════
 * 10. Small UI pieces
 * ════════════════════════════════════════════════════════════════════════ */

function BottomBar({ children }: { children: ReactNode }) {
  return (
    <motion.div
      className="pointer-events-auto flex w-full max-w-md flex-col"
      initial={{ y: 16, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 16, opacity: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}

/** 1px 라인 버튼. label만 있고 children이 없으면 아이콘 전용 */
function LineButton({
  children,
  onClick,
  icon,
  primary,
  grow,
  iconRight,
  active,
  label,
}: {
  children?: ReactNode
  onClick: () => void
  icon?: ReactNode
  primary?: boolean
  grow?: boolean
  iconRight?: boolean
  active?: boolean
  label?: string
}) {
  const iconOnly = !children
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      className={`pointer-events-auto flex h-12 items-center justify-center gap-2 rounded-full border text-[14px] transition-colors ${
        iconOnly ? 'w-12 shrink-0' : 'px-5'
      } ${grow ? 'flex-1' : 'shrink-0'} ${
        primary
          ? 'border-ink bg-ink text-white hover:bg-black'
          : active
            ? 'border-ink bg-white text-ink'
            : 'border-line bg-white text-ink hover:border-ink'
      }`}
    >
      {!iconRight && icon}
      {children}
      {iconRight && icon}
    </motion.button>
  )
}
