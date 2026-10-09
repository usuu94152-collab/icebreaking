// WebGL2 렌더러: 영상 스타일 변환(셰이더) + 손가락 프레임 안쪽만 합성
//
// 좌표계: 모든 텍스처는 뒤집지 않고 올리므로 t=0 이 영상 맨 위.
// MediaPipe 랜드마크(0~1, y 아래 방향)와 그대로 일치한다. 화면 출력 패스에서만 위아래/좌우를 맞춘다.

export const STYLES = {
  webtoon: 0,
  sketch: 1,
  pixel: 2,
  pop: 3,
  neon: 4,
  thermal: 5,
};

// 매끈하게 펴 둔 영상(bilateral)이 필요한 스타일
const NEEDS_SMOOTH = new Set([STYLES.webtoon, STYLES.pop, STYLES.neon, STYLES.thermal]);

// 다각형 꼭짓점 최대 개수 (사각형 4개, 삼각형 두 개는 6개)
export const MAX_POINTS = 8;

const VS_PASS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// 화면 출력용: 화면 위쪽 = 영상 위쪽(t=0)
const VS_SCREEN = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// 양방향(bilateral) 필터: 경계는 살리고 피부·면은 매끈하게 (웹툰 채색의 기반)
const FS_SMOOTH = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;

void main() {
  vec3 center = texture(uSrc, vUv).rgb;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int j = -4; j <= 4; j++) {
    for (int i = -4; i <= 4; i++) {
      vec2 o = vec2(float(i), float(j));
      vec3 c = texture(uSrc, vUv + o * uTexel * 1.5).rgb;
      vec3 dc = c - center;
      float w = exp(-dot(o, o) / 18.0 - dot(dc, dc) / 0.02);
      sum += c * w;
      wsum += w;
    }
  }
  outColor = vec4(sum / wsum, 1.0);
}`;

// 스타일 패스: 웹툰 / 연필 스케치 / 8비트 픽셀 / 만화책 팝아트 / 네온 사이버 / 열화상
const FS_STYLE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;    // 원본 영상
uniform sampler2D uFlat;   // bilateral 결과
uniform vec2 uTexel;
uniform int uStyle;
uniform float uTime;       // 초 (애니메이션용)

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

vec3 saturate3(vec3 c, float s) {
  float l = luma(c);
  return clamp(mix(vec3(l), c, s), 0.0, 1.0);
}

// 두 크기의 블러 차이(DoG)로 연필선 추출
float blurLuma(sampler2D tex, vec2 uv, vec2 t, float radius) {
  float sum = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      sum += luma(texture(tex, uv + vec2(float(i), float(j)) * t * radius).rgb);
    }
  }
  return sum / 25.0;
}

vec3 webtoon() {
  vec3 c = texture(uFlat, vUv).rgb;
  // 밝고 화사하게: 노출을 살짝 올리고 채도 보강
  c = pow(c, vec3(0.92));
  c = saturate3(c, 1.25);
  // 부드러운 셀 셰이딩: 밝기 단계 경계를 smoothstep 으로 완만하게
  float l = luma(c);
  float lv = l * 4.0;
  float q = (floor(lv) + smoothstep(0.35, 0.65, fract(lv))) / 4.0;
  c *= mix(1.0, (q + 0.06) / max(l, 1e-3), 0.5);
  // 외곽선: 매끈해진 영상에서 DoG 로 뽑아 잡티 없이 굵은 선만
  float b1 = blurLuma(uFlat, vUv, uTexel, 0.6);
  float b2 = blurLuma(uFlat, vUv, uTexel, 1.6);
  float ink = 1.0 - smoothstep(-0.028, -0.008, b1 - 0.99 * b2);
  c = mix(c, vec3(0.20, 0.12, 0.12), ink * 0.8);
  return clamp(c, 0.0, 1.0);
}

vec3 sketch() {
  float b1 = blurLuma(uSrc, vUv, uTexel, 0.6);
  float b2 = blurLuma(uSrc, vUv, uTexel, 1.6);
  float d = b1 - 0.985 * b2;
  float ink = 1.0 - smoothstep(-0.035, 0.0, d);
  float tone = luma(texture(uSrc, vUv).rgb);
  // 종이 바탕 + 연한 명암 + 연필선
  vec3 paper = vec3(0.97, 0.95, 0.90);
  vec3 shade = paper * mix(0.78, 1.0, smoothstep(0.15, 0.75, tone));
  return mix(shade, vec3(0.20, 0.20, 0.24), ink * 0.9);
}

vec3 pixel() {
  vec2 size = 1.0 / uTexel;
  float block = max(6.0, floor(size.x / 110.0));
  vec2 cell = floor(vUv * size / block);
  vec2 uv = (cell + 0.5) * block / size;
  vec3 c = texture(uSrc, uv).rgb;
  c = saturate3(pow(c, vec3(0.85)), 1.4);
  c = floor(c * 5.0 + 0.5) / 5.0;
  // 픽셀 사이 얇은 격자
  vec2 f = fract(vUv * size / block);
  float grid = step(f.x, 0.08) + step(f.y, 0.08);
  return c * (1.0 - 0.12 * min(grid, 1.0));
}

// 매끈한 영상의 밝기 기울기 (윤곽선 세기)
vec2 gradient(vec2 uv, float r) {
  vec2 t = uTexel * r;
  float l = luma(texture(uFlat, uv - vec2(t.x, 0.0)).rgb);
  float rr = luma(texture(uFlat, uv + vec2(t.x, 0.0)).rgb);
  float u = luma(texture(uFlat, uv - vec2(0.0, t.y)).rgb);
  float d = luma(texture(uFlat, uv + vec2(0.0, t.y)).rgb);
  return vec2(rr - l, d - u);
}

// 만화책 팝아트: 진한 색 + 망점(하프톤) + 굵은 먹선
vec3 popart() {
  vec3 c = texture(uFlat, vUv).rgb;
  float l = luma(c);
  // 색은 유지하고 밝기만 3단계로 뭉쳐서 만화 채색처럼
  vec3 col = saturate3(c, 1.7);
  float lq = (floor(l * 3.0) + 0.5) / 3.0 + 0.08;
  col = clamp(col * lq / max(l, 0.05), 0.0, 1.0);
  vec3 paper = vec3(1.0, 0.97, 0.9);
  vec3 light = mix(paper, col, 0.55);
  // 망점: 45도 기울인 격자. 밝은 곳은 점 없음, 어두울수록 점이 커진다
  vec2 px = vUv / uTexel;
  const float A = 0.7854;
  vec2 g = mat2(cos(A), -sin(A), sin(A), cos(A)) * px / 6.0;
  float r = 0.75 * smoothstep(0.8, 0.2, l);
  float dotm = 1.0 - smoothstep(r - 0.07, r + 0.07, length(fract(g) - 0.5));
  c = mix(light, col * 0.8, dotm);
  c = mix(c, col * 0.35, smoothstep(0.2, 0.08, l));         // 아주 어두운 곳은 꽉 채움
  // 굵은 먹선
  float b1 = blurLuma(uFlat, vUv, uTexel, 0.8);
  float b2 = blurLuma(uFlat, vUv, uTexel, 2.0);
  float ink = 1.0 - smoothstep(-0.035, -0.012, b1 - 0.99 * b2);
  return mix(c, vec3(0.04, 0.03, 0.05), ink);
}

vec3 hue(float h) {
  return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}

// 네온 사이버: 어두운 화면에 윤곽선이 네온색으로 빛나고 스캔라인이 지나간다
vec3 neon() {
  float e = length(gradient(vUv, 1.5));
  float glow = length(gradient(vUv, 5.0));
  float line = smoothstep(0.04, 0.16, e);
  float halo = smoothstep(0.02, 0.2, glow);
  // 위치와 시간에 따라 청록 → 보라 → 분홍으로 흐르는 색
  vec3 col = hue(0.5 + 0.35 * fract(vUv.y * 0.8 + vUv.x * 0.3 - uTime * 0.15));
  float l = luma(texture(uFlat, vUv).rgb);
  vec3 c = vec3(0.02, 0.01, 0.06) + vec3(0.05, 0.08, 0.2) * l;
  c += col * halo * 0.55 + mix(col, vec3(1.0), 0.35) * line * 1.2;
  // 가로 스캔라인 + 위에서 아래로 훑는 빛줄기 + 옅은 격자
  vec2 px = vUv / uTexel;
  c *= 0.82 + 0.18 * sin(px.y * 1.6);
  float bar = exp(-pow((fract(vUv.y * 0.7 - uTime * 0.35) - 0.5) * 24.0, 2.0));
  c += vec3(0.2, 0.9, 1.0) * bar * 0.25;
  vec2 grid = abs(fract(px / 40.0) - 0.5);
  c += vec3(0.1, 0.25, 0.5) * 0.15 * (1.0 - smoothstep(0.0, 0.03, min(grid.x, grid.y)));
  return clamp(c, 0.0, 1.0);
}

// 열화상: 사람 피부·얼굴은 뜨겁게(노랑·흰색), 배경은 차갑게(파랑·보라)
vec3 ironbow(float t) {
  vec3 c0 = vec3(0.0, 0.0, 0.05), c1 = vec3(0.15, 0.0, 0.45), c2 = vec3(0.6, 0.0, 0.55);
  vec3 c3 = vec3(0.95, 0.25, 0.05), c4 = vec3(1.0, 0.75, 0.0), c5 = vec3(1.0, 1.0, 0.85);
  t = clamp(t, 0.0, 1.0) * 5.0;
  if (t < 1.0) return mix(c0, c1, t);
  if (t < 2.0) return mix(c1, c2, t - 1.0);
  if (t < 3.0) return mix(c2, c3, t - 2.0);
  if (t < 4.0) return mix(c3, c4, t - 3.0);
  return mix(c4, c5, t - 4.0);
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec3 thermal() {
  vec3 c = texture(uFlat, vUv).rgb;
  float l = luma(c);
  // 피부색(빨강이 파랑보다 확실히 큰 색)일수록 온도를 높게
  float skin = smoothstep(0.03, 0.2, c.r - c.b) * smoothstep(0.15, 0.4, c.r);
  float heat = l * 0.35 + skin * 0.65;
  // 살짝 번진 느낌 + 센서 노이즈
  heat += (hash(floor(vUv / uTexel / 2.0) + floor(uTime * 12.0)) - 0.5) * 0.03;
  vec3 o = ironbow(heat);
  vec2 px = vUv / uTexel;
  o *= 0.92 + 0.08 * sin(px.y * 2.0);
  return o;
}

void main() {
  vec3 c;
  if (uStyle == 0) c = webtoon();
  else if (uStyle == 1) c = sketch();
  else if (uStyle == 2) c = pixel();
  else if (uStyle == 3) c = popart();
  else if (uStyle == 4) c = neon();
  else c = thermal();
  outColor = vec4(c, 1.0);
}`;

// 최종 합성: 손가락 프레임(사각형 또는 삼각형 두 개) 안쪽은 스타일 영상, 바깥은 원본
const FS_COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uVideo;
uniform sampler2D uStyled;
uniform vec2 uPoly[8];    // 프레임 꼭짓점 (0~1)
uniform int uCount;       // 꼭짓점 개수
uniform float uActive;
uniform float uMirror;
uniform vec2 uVideoSize;
uniform float uBorder;    // 테두리 두께(px), 0이면 없음

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

// 다각형까지의 부호 있는 거리(px). 안쪽이 양수. (꼭짓점이 겹치는 나비 모양도 처리)
float polyDist(vec2 p) {
  float d = 1e9;
  bool inside = false;
  for (int i = 0; i < 8; i++) {
    if (i >= uCount) break;
    vec2 a = uPoly[i] * uVideoSize;
    vec2 b = uPoly[(i + 1) % uCount] * uVideoSize;
    d = min(d, segDist(p, a, b));
    if (((a.y > p.y) != (b.y > p.y)) && (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) {
      inside = !inside;
    }
  }
  return inside ? d : -d;
}

void main() {
  vec2 uv = vUv;
  if (uMirror > 0.5) uv.x = 1.0 - uv.x;
  vec3 base = texture(uVideo, uv).rgb;
  if (uActive < 0.5) { outColor = vec4(base, 1.0); return; }

  float d = polyDist(uv * uVideoSize);
  float mask = smoothstep(-1.0, 1.0, d);

  vec3 styled = texture(uStyled, uv).rgb;

  vec3 c = mix(base, styled, mask);
  if (uBorder > 0.0) {
    float edge = 1.0 - smoothstep(uBorder - 0.75, uBorder + 0.75, abs(d));
    c = mix(c, vec3(1.0), edge * 0.9);
  }
  outColor = vec4(c, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('셰이더 컴파일 실패: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('셰이더 링크 실패: ' + gl.getProgramInfoLog(p));
  }
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name; // 배열은 "uPoly[0]" 형태
    uniforms[name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, name);
  }
  return { p, u: uniforms };
}

function makeTexture(gl) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  return t;
}

function makeTarget(gl, w, h) {
  const tex = makeTexture(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fb, w, h };
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, desynchronized: true });
    if (!gl) throw new Error('이 브라우저는 WebGL2를 지원하지 않습니다. 최신 Chrome/Edge를 사용해 주세요.');
    this.gl = gl;
    this.canvas = canvas;

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.smooth = program(gl, VS_PASS, FS_SMOOTH);
    this.style = program(gl, VS_PASS, FS_STYLE);
    this.composite = program(gl, VS_SCREEN, FS_COMPOSITE);

    this.videoTex = makeTexture(gl);
    this.flat = null;
    this.styled = null;
    this.width = 0;
    this.height = 0;
  }

  resize(w, h) {
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    // 스타일 변환은 가로 최대 800px 해상도에서 처리 (속도 확보)
    const scale = Math.min(1, 800 / w);
    const sw = Math.round(w * scale);
    const sh = Math.round(h * scale);
    for (const t of [this.flat, this.styled]) {
      if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    }
    this.flat = makeTarget(gl, sw, sh);
    this.styled = makeTarget(gl, sw, sh);
  }

  uploadVideo(video) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  }

  // opts: { poly: [{x,y}…] | null, style, mirror, border, time }
  render(opts) {
    const gl = this.gl;
    const active = !!opts.poly;

    if (active) {
      const { w, h } = this.styled;
      const texel = [1 / w, 1 / h];

      if (NEEDS_SMOOTH.has(opts.style)) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.flat.fb);
        gl.viewport(0, 0, w, h);
        gl.useProgram(this.smooth.p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
        gl.uniform1i(this.smooth.u.uSrc, 0);
        gl.uniform2fv(this.smooth.u.uTexel, texel);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.styled.fb);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this.style.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.flat.tex);
      gl.uniform1i(this.style.u.uSrc, 0);
      gl.uniform1i(this.style.u.uFlat, 1);
      gl.uniform2fv(this.style.u.uTexel, texel);
      gl.uniform1i(this.style.u.uStyle, opts.style);
      gl.uniform1f(this.style.u.uTime, opts.time || 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    const c = this.composite;
    gl.useProgram(c.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.styled.tex);
    gl.uniform1i(c.u.uVideo, 0);
    gl.uniform1i(c.u.uStyled, 1);
    gl.uniform1f(c.u.uActive, active ? 1 : 0);
    gl.uniform1f(c.u.uMirror, opts.mirror ? 1 : 0);
    gl.uniform2f(c.u.uVideoSize, this.width, this.height);
    gl.uniform1f(c.u.uBorder, opts.border || 0);
    if (active) {
      const pts = new Float32Array(MAX_POINTS * 2);
      opts.poly.slice(0, MAX_POINTS).forEach((p, i) => { pts[i * 2] = p.x; pts[i * 2 + 1] = p.y; });
      gl.uniform2fv(c.u.uPoly, pts);
      gl.uniform1i(c.u.uCount, Math.min(opts.poly.length, MAX_POINTS));
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
