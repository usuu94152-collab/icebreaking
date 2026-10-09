// (선택) AnimeGANv3 ONNX 모델로 손가락 프레임 영역을 AI 애니 스타일로 변환
// onnxruntime-web 은 AI 모드를 켤 때만 CDN 에서 불러온다 (인터넷 필요).

const ORT_VERSION = '1.20.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

export class AiStylizer {
  constructor() {
    this.session = null;
    this.busy = false;
    this.maxSide = 384;      // 추론 해상도 (클수록 선명하지만 느림)
    this.multiple = 8;       // AnimeGANv3 입력은 8의 배수 (tiny 모델은 16)
    this.provider = null;
    this.lastMs = 0;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  get ready() { return !!this.session; }

  // source: File 객체 또는 URL 문자열
  async load(source, name = '') {
    const ort = await import(`${ORT_BASE}ort.all.min.mjs`);
    ort.env.wasm.wasmPaths = ORT_BASE;
    const bytes = source instanceof Blob
      ? new Uint8Array(await source.arrayBuffer())
      : new Uint8Array(await (await fetch(source)).arrayBuffer());

    this.ort = ort;
    this.multiple = /tiny/i.test(name) ? 16 : 8;
    const providers = 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];
    let lastErr;
    for (const ep of providers) {
      try {
        this.session = await ort.InferenceSession.create(bytes, { executionProviders: [ep] });
        this.provider = ep;
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`AI 모델 ${ep} 로드 실패`, err);
      }
    }
    if (!this.session) throw lastErr;
    this.inputName = this.session.inputNames[0];
    // 처음 한 번은 느리므로 미리 데워둔다
    const s = 256;
    await this.session.run({ [this.inputName]: new ort.Tensor('float32', new Float32Array(s * s * 3), [1, s, s, 3]) });
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
    const scale = Math.min(1, this.maxSide / Math.max(pw, ph));
    const m = this.multiple;
    const w = Math.max(256, Math.round((pw * scale) / m) * m);
    const h = Math.max(256, Math.round((ph * scale) / m) * m);

    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.drawImage(video, rect.x * vw, rect.y * vh, pw, ph, 0, 0, w, h);
    const px = this.ctx.getImageData(0, 0, w, h).data;

    // RGB, NHWC, [-1, 1]
    const input = new Float32Array(w * h * 3);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
      input[j] = px[i] / 127.5 - 1;
      input[j + 1] = px[i + 1] / 127.5 - 1;
      input[j + 2] = px[i + 2] / 127.5 - 1;
    }

    const t0 = performance.now();
    const out = await this.session.run({
      [this.inputName]: new this.ort.Tensor('float32', input, [1, h, w, 3]),
    });
    this.lastMs = performance.now() - t0;
    const tensor = out[this.session.outputNames[0]];
    const data = tensor.data;
    const nchw = tensor.dims.length === 4 && tensor.dims[1] === 3;
    const oh = nchw ? tensor.dims[2] : tensor.dims[1];
    const ow = nchw ? tensor.dims[3] : tensor.dims[2];
    const plane = ow * oh;

    const rgba = new Uint8ClampedArray(plane * 4);
    for (let i = 0; i < plane; i++) {
      for (let c = 0; c < 3; c++) {
        const v = nchw ? data[c * plane + i] : data[i * 3 + c];
        rgba[i * 4 + c] = (v + 1) * 127.5;
      }
      rgba[i * 4 + 3] = 255;
    }
    if (tensor.dispose) tensor.dispose();
    return { rgba: new Uint8Array(rgba.buffer), w: ow, h: oh, rect };
  }
}
