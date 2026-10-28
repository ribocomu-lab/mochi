/// <reference lib="webworker" />
/**
 * RMBG-1.4 (Transformers.js) 배경 제거 워커.
 * 메인 스레드를 막지 않도록 모델 로딩과 추론을 모두 여기서 처리한다.
 *
 * in : { id, width, height, data: Uint8ClampedArray(RGBA) }
 * out: { type: 'progress', percent } | { type: 'running', id } | { type: 'result', id, mask } | { type: 'error', id, message }
 */
import { AutoModel, AutoProcessor, RawImage, env, type PreTrainedModel, type Processor } from '@huggingface/transformers'

const MODEL = 'briaai/RMBG-1.4'
env.allowLocalModels = false

let loading: Promise<[PreTrainedModel, Processor]> | null = null

const post = (msg: unknown, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer)

function load() {
  loading ??= Promise.all([
    AutoModel.from_pretrained(MODEL, {
      // RMBG-1.4는 커스텀 아키텍처라 model_type을 지정해야 함
      config: { model_type: 'custom' } as never,
      progress_callback: (p: { status: string; file?: string; progress?: number }) => {
        if (p.status === 'progress' && p.file?.endsWith('.onnx')) post({ type: 'progress', percent: p.progress ?? 0 })
      },
    }),
    AutoProcessor.from_pretrained(MODEL, {
      config: {
        do_normalize: true,
        do_pad: false,
        do_rescale: true,
        do_resize: true,
        image_mean: [0.5, 0.5, 0.5],
        feature_extractor_type: 'ImageFeatureExtractor',
        image_std: [1, 1, 1],
        resample: 2,
        rescale_factor: 0.00392156862745098,
        size: { width: 1024, height: 1024 },
      } as never,
    }),
  ])
  return loading
}

self.onmessage = async (e: MessageEvent<{ id: number; width: number; height: number; data: Uint8ClampedArray }>) => {
  const { id, width, height, data } = e.data
  try {
    const [model, processor] = await load()
    post({ type: 'running', id })
    const image = new RawImage(data, width, height, 4)
    const { pixel_values } = await processor(image)
    const { output } = await model({ input: pixel_values })
    const mask = await RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(width, height)
    const out = new Uint8Array(mask.data)
    post({ type: 'result', id, mask: out }, [out.buffer])
  } catch (err) {
    loading = null // 다음 시도에서 다시 받도록
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) })
  }
}
