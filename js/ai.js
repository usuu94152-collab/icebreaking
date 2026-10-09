// AI 애니 모드: 손가락 프레임 영역을 AnimeGAN 계열 ONNX 모델로 변환
// - 기본 모델: models/anime.onnx (AnimeGANv2 face_paint_512_v2, 입력 크기 자유)
// - AnimeGANv3 .onnx 도 파일 선택으로 불러올 수 있다 (입력 형식 NCHW/NHWC 자동 판별)
// onnxruntime-web 은 vendor/ 에 포함되어 있어 인터넷 없이 동작한다.

const ORT_DIR = new URL('../vendor/onnxruntime/', import.meta.url).href;

export class AiStylizer {
  constructor() {
    this.session = null;
    this.busy = false;
    this.maxSide = 384;      // 추론 해상도 (클수록 선명하지만 느림)
    this.multiple = 8;       // 입력 크기 배수 (AnimeGANv3 tiny 모델은 16)
    this.layout = 'nchw';
    this.provider = null;
    this.lastMs = 0;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  get ready() { return !!this.session; }

  // source: File 객체 또는 URL 문자열
  async load(source, name = '') {
    const ort = await import(`${ORT_DIR}ort.all.min.mjs`);
    ort.env.wasm.wasmPaths = ORT_DIR;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const bytes = source instanceof Blob
      ? new Uint8Array(await source.arrayBuffer())
      : new Uint8Array(await (await fetch(source)).arrayBuffer());

    this.ort = ort;
    this.multiple = /tiny/i.test(name) ? 16 : 8;
    const providers = 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];
    let lastErr;
    for (const ep of providers) {
      try {
        const session = await ort.InferenceSession.create(bytes, { executionProviders: [ep] });
        this.inputName = session.inputNames[0];
        this.session = session;
        // 입력 형식 판별 + 첫 실행 워밍업 (첫 추론은 느리다)
        this.layout = await this.detectLayout();
        this.provider = ep;
        break;
      } catch (err) {
        this.session = null;
        lastErr = err;
        console.warn(`AI 모델 ${ep} 로드 실패`, err);
      }
    }
    if (!this.session) throw lastErr;
    // GPU 면 더 선명하게, CPU 면 가볍게
    this.maxSide = this.provider === 'webgpu' ? 448 : 320;
  }

  async detectLayout() {
    const s = 256;
    const zeros = new Float32Array(s * s * 3);
    for (const layout of ['nchw', 'nhwc']) {
      const dims = layout === 'nchw' ? [1, 3, s, s] : [1, s, s, 3];
      try {
        await this.session.run({ [this.inputName]: new this.ort.Tensor('float32', zeros, dims) });
        return layout;
      } catch {
        // 다른 형식으로 재시도
      }
    }
    throw new Error('지원하지 않는 모델 입력 형식입니다.');
  }

  // 손가락 사각형을 감싸는 영역(여백 포함)을 0~1 좌표로 계산
  static cropRect(quad, aspect) {
    const xs = quad.map((p) => p.x);
    const ys = quad.map((p) => p.y);
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    const padX = (x1 - x0) * 0.15 + 0.02;
    const padY = (y1 - y0) * 0.15 + 0.02 * aspect;
    x0 = Math.max(0, x0 - padX); x1 = Math.min(1, x1 + padX);
    y0 = Math.max(0, y0 - padY); y1 = Math.min(1, y1 + padY);
    return { x: x0, y: y0, w: Math.max(x1 - x0, 1e-3), h: Math.max(y1 - y0, 1e-3) };
  }

  // 비동기 추론. 결과: { rgba, w, h, rect }
  async run(video, quad) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const rect = AiStylizer.cropRect(quad, vw / vh);
    const pw = rect.w * vw, ph = rect.h * vh;
    const scale = this.maxSide / Math.max(pw, ph);
    const m = this.multiple;
    const w = Math.max(128, Math.round((pw * scale) / m) * m);
    const h = Math.max(128, Math.round((ph * scale) / m) * m);

    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.drawImage(video, rect.x * vw, rect.y * vh, pw, ph, 0, 0, w, h);
    const px = this.ctx.getImageData(0, 0, w, h).data;

    // RGB, [-1, 1]
    const plane = w * h;
    const input = new Float32Array(plane * 3);
    const nchw = this.layout === 'nchw';
    for (let i = 0; i < plane; i++) {
      for (let c = 0; c < 3; c++) {
        input[nchw ? c * plane + i : i * 3 + c] = px[i * 4 + c] / 127.5 - 1;
      }
    }
    const dims = nchw ? [1, 3, h, w] : [1, h, w, 3];

    const t0 = performance.now();
    const out = await this.session.run({ [this.inputName]: new this.ort.Tensor('float32', input, dims) });
    this.lastMs = performance.now() - t0;
    const tensor = out[this.session.outputNames[0]];
    const data = tensor.data;
    const outNchw = tensor.dims.length === 4 && tensor.dims[1] === 3;
    const oh = outNchw ? tensor.dims[2] : tensor.dims[1];
    const ow = outNchw ? tensor.dims[3] : tensor.dims[2];
    const oplane = ow * oh;

    const rgba = new Uint8ClampedArray(oplane * 4);
    for (let i = 0; i < oplane; i++) {
      for (let c = 0; c < 3; c++) {
        const v = outNchw ? data[c * oplane + i] : data[i * 3 + c];
        rgba[i * 4 + c] = (v + 1) * 127.5;
      }
      rgba[i * 4 + 3] = 255;
    }
    if (tensor.dispose) tensor.dispose();
    return { rgba: new Uint8Array(rgba.buffer), w: ow, h: oh, rect };
  }
}
