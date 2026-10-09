// 초사이어인 모드용: 얼굴 랜드마크(머리 위치·눈동자) + 머리카락 영역 마스크
import { FilesetResolver, FaceLandmarker, ImageSegmenter } from '../vendor/mediapipe/vision_bundle.js';

const model = (name) => new URL(`../models/${name}`, import.meta.url).href;

async function create(Task, fileset, modelAssetPath, extra) {
  for (const delegate of ['GPU', 'CPU']) {
    try {
      return await Task.createFromOptions(fileset, {
        baseOptions: { modelAssetPath, delegate },
        runningMode: 'VIDEO',
        ...extra,
      });
    } catch (err) {
      if (delegate === 'CPU') throw err;
      console.warn(`${Task.name} GPU 실패, CPU로 전환합니다.`, err);
    }
  }
}

export class FaceTracker {
  constructor() {
    this.face = null;
    this.hair = null;
    this.landmarks = null;   // 478개 (눈동자 포함), 0~1 좌표
    this.hairMask = null;    // { data: Uint8Array, width, height } (1/4 해상도)
    this.hairVersion = 0;    // 마스크가 갱신될 때마다 증가 (텍스처 재업로드 판단용)
    this.loading = null;
  }

  get ready() { return !!(this.face && this.hair); }

  // 처음 초사이어인 모드를 켤 때 한 번만 불러온다
  init() {
    if (!this.loading) {
      this.loading = (async () => {
        const fileset = await FilesetResolver.forVisionTasks(new URL('../vendor/mediapipe/wasm', import.meta.url).href);
        [this.face, this.hair] = await Promise.all([
          create(FaceLandmarker, fileset, model('face_landmarker.task'), { numFaces: 1 }),
          create(ImageSegmenter, fileset, model('hair_segmenter.tflite'), {
            outputConfidenceMasks: true,
            outputCategoryMask: false,
          }),
        ]);
      })();
    }
    return this.loading;
  }

  // withHair: 머리카락 분할까지 할지. GPU→CPU 로 마스크를 꺼내오는 비용이 커서 몇 프레임에 한 번만 한다.
  update(video, now, withHair) {
    const res = this.face.detectForVideo(video, now);
    this.landmarks = res.faceLandmarks && res.faceLandmarks[0] ? res.faceLandmarks[0] : null;
    if (!withHair) return;

    this.hair.segmentForVideo(video, now, (result) => {
      const mask = result.confidenceMasks && result.confidenceMasks[result.confidenceMasks.length - 1];
      if (!mask) return;
      const f = mask.getAsFloat32Array();
      const S = 4;
      const w = Math.floor(mask.width / S), h = Math.floor(mask.height / S);
      if (!this.hairMask || this.hairMask.width !== w || this.hairMask.height !== h) {
        this.hairMask = { data: new Uint8Array(w * h), width: w, height: h };
      }
      const out = this.hairMask.data;
      for (let y = 0; y < h; y++) {
        const row = y * S * mask.width;
        for (let x = 0; x < w; x++) out[y * w + x] = f[row + x * S] * 255;
      }
      this.hairVersion++;
    });
  }
}
