/**
 * 얼굴 찾기 (MediaPipe BlazeFace). 얼굴이 있으면 어안렌즈의 중심을 이목구비에 맞추기 위해 쓴다.
 * 첫 호출 때만 wasm(약 10MB)과 모델(약 230KB)을 받아 오고, 실패하면 null을 돌려 원래 방식으로 진행한다.
 */
import type { FaceDetector } from '@mediapipe/tasks-vision'

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'

/** 사진 px 좌표의 얼굴 중심과 반지름 */
export type Face = { x: number; y: number; r: number }

let loading: Promise<FaceDetector> | null = null

function load() {
  loading ??= import('@mediapipe/tasks-vision').then(async ({ FilesetResolver, FaceDetector }) =>
    FaceDetector.createFromOptions(await FilesetResolver.forVisionTasks(WASM), {
      baseOptions: { modelAssetPath: MODEL },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.5,
    }),
  )
  return loading
}

export async function detectFace(photo: HTMLCanvasElement): Promise<Face | null> {
  try {
    const det = await load()
    const faces = det.detect(photo).detections
    // 가장 큰 얼굴 하나
    let best: Face | null = null
    for (const f of faces) {
      const b = f.boundingBox
      if (!b) continue
      const r = Math.max(b.width, b.height) / 2
      if (best && r <= best.r) continue
      // 상자 중심보다 코 쪽(살짝 아래)이 이목구비의 시각적 중심
      const nose = f.keypoints[2]
      const x = nose ? lerp(b.originX + b.width / 2, nose.x * photo.width, 0.5) : b.originX + b.width / 2
      const y = nose ? lerp(b.originY + b.height / 2, nose.y * photo.height, 0.5) : b.originY + b.height / 2
      best = { x, y, r }
    }
    return best
  } catch {
    loading = null
    return null
  }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
