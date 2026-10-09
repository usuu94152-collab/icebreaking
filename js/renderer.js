// WebGL2 렌더러: 영상 스타일 변환(셰이더) + 손가락 프레임 안쪽만 합성
//
// 좌표계: 모든 텍스처는 뒤집지 않고 올리므로 t=0 이 영상 맨 위.
// MediaPipe 랜드마크(0~1, y 아래 방향)와 그대로 일치한다. 화면 출력 패스에서만 위아래/좌우를 맞춘다.

export const STYLES = {
  webtoon: 0,
  sketch: 1,
  pixel: 2,
  saiyan: 3,
};

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

// 스타일 패스: 웹툰(색 보정 + 외곽선) / 연필 스케치 / 8비트 픽셀
const FS_STYLE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;    // 원본 영상
uniform sampler2D uFlat;   // bilateral 결과
uniform vec2 uTexel;
uniform int uStyle;
// 초사이어인 전용
uniform sampler2D uOverlay;  // 뾰족 머리·번개 (2D 캔버스)
uniform sampler2D uHair;     // 머리카락 마스크
uniform vec3 uIris[2];       // 눈동자 중심(x, y) + 반지름(px)
uniform vec4 uHead;          // 머리 중심(x, y), 반지름(px), 얼굴 인식 여부
uniform vec2 uUp;            // 머리 위쪽 방향
uniform vec2 uVideoSize;
uniform float uTime;
uniform float uBurst;        // 변신 순간 번쩍임 (1 → 0)

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

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
  return v;
}

vec3 saiyan() {
  vec3 c = texture(uSrc, vUv).rgb;
  float l = luma(c);

  // 1) 진짜 머리카락을 금색으로 (어두운 곳은 진한 금색, 밝은 곳은 연한 금색)
  // 마스크 가장자리를 부드럽게 (주변 9칸 평균)
  float hm = 0.0;
  vec2 hs = 3.0 / uVideoSize;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++)
      hm += texture(uHair, vUv + vec2(float(i), float(j)) * hs).r;
  float hair = smoothstep(0.4, 0.8, hm / 9.0);
  vec3 gold = mix(vec3(0.78, 0.47, 0.02), vec3(1.0, 0.95, 0.55), smoothstep(0.02, 0.4, l));
  c = mix(c, gold, hair * 0.95);

  // 2) 청록색 눈동자 (가운데 동공은 어둡게 유지)
  for (int i = 0; i < 2; i++) {
    float r = uIris[i].z;
    if (r <= 0.0) continue;
    float d = length((vUv - uIris[i].xy) * uVideoSize);
    float iris = 1.0 - smoothstep(r * 0.8, r * 1.05, d);
    vec3 teal = vec3(0.05, 0.80, 0.72) * (0.45 + l * 1.4);
    teal = mix(c * 0.6, teal, smoothstep(r * 0.25, r * 0.45, d));
    c = mix(c, teal, iris * 0.9);
  }

  // 3) 뾰족 머리·번개
  vec4 o = texture(uOverlay, vUv);
  c = mix(c, o.rgb, o.a);

  // 4) 머리 주변에서 타오르는 황금 오라
  if (uHead.w > 0.5) {
    vec2 p = (vUv - uHead.xy) * uVideoSize / uHead.z;
    vec2 right = vec2(-uUp.y, uUp.x);
    vec2 q = vec2(dot(p, right), dot(p, uUp));     // q.y > 0 이 머리 위쪽
    float r = length(q * vec2(1.0, 0.8));
    float flame = fbm(vec2(q.x * 3.0, q.y * 1.4 - uTime * 3.5));
    float ring = smoothstep(0.75, 1.05, r) * (1.0 - smoothstep(1.25, 1.7 + flame * 0.9, r));
    ring *= smoothstep(-1.6, -0.4, q.y);            // 몸 아래쪽으로 갈수록 약하게
    float tongues = smoothstep(0.42, 0.72, flame);  // 불꽃 혀 모양
    float a = ring * (0.12 + 0.8 * tongues) * (1.0 + 1.5 * uBurst);
    a *= 1.0 - o.a * 0.6;                           // 머리카락 위에서는 살짝만
    c += vec3(1.0, 0.80, 0.22) * a;
  }

  // 전체적으로 황금빛 + 변신 순간 번쩍
  c *= vec3(1.04, 1.01, 0.94);
  c = mix(c, vec3(1.0, 0.97, 0.8), uBurst * 0.75);
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec3 c;
  if (uStyle == 0) c = webtoon();
  else if (uStyle == 1) c = sketch();
  else if (uStyle == 2) c = pixel();
  else c = saiyan();
  outColor = vec4(c, 1.0);
}`;

// 최종 합성: 손가락 사각형 안쪽은 스타일 영상, 바깥은 원본
const FS_COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uVideo;
uniform sampler2D uStyled;
uniform sampler2D uAi;
uniform vec2 uQuad[4];
uniform float uActive;
uniform float uMirror;
uniform float uUseAi;
uniform vec4 uAiRect;     // AI 결과가 덮는 영역 (x, y, w, h)
uniform vec2 uVideoSize;
uniform float uBorder;    // 테두리 두께(px), 0이면 없음

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

// 다각형까지의 부호 있는 거리(px). 안쪽이 양수.
float polyDist(vec2 p) {
  float d = 1e9;
  bool inside = false;
  for (int i = 0; i < 4; i++) {
    vec2 a = uQuad[i] * uVideoSize;
    vec2 b = uQuad[(i + 1) % 4] * uVideoSize;
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
  if (uUseAi > 0.5) {
    vec2 local = (uv - uAiRect.xy) / uAiRect.zw;
    if (all(greaterThanEqual(local, vec2(0.0))) && all(lessThanEqual(local, vec2(1.0)))) {
      styled = texture(uAi, local).rgb;
    }
  }

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
    const name = gl.getActiveUniform(p, i).name; // 배열은 "uQuad[0]" 형태
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
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
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
    this.aiTex = makeTexture(gl);
    this.overlayTex = makeTexture(gl);
    this.hairTex = makeTexture(gl);
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

  uploadAi(rgba, w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.aiTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  uploadOverlay(canvas) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.overlayTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  }

  uploadHair(mask) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.hairTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mask.width, mask.height, 0, gl.RED, gl.UNSIGNED_BYTE, mask.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  // opts: { quad, style, mirror, ai: {rect} | null, border, saiyan: {iris, head, up, time, burst} | null }
  render(opts) {
    const gl = this.gl;
    const active = !!opts.quad;

    if (active) {
      const { w, h } = this.styled;
      const texel = [1 / w, 1 / h];

      if (opts.style === STYLES.webtoon) {
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
      if (opts.style === STYLES.saiyan) {
        const u = this.style.u;
        const sy = opts.saiyan || {};
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.overlayTex);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, this.hairTex);
        gl.uniform1i(u.uOverlay, 2);
        gl.uniform1i(u.uHair, 3);
        gl.uniform3fv(u.uIris, sy.iris || [0, 0, 0, 0, 0, 0]);
        gl.uniform4fv(u.uHead, sy.head || [0, 0, 1, 0]);
        gl.uniform2fv(u.uUp, sy.up || [0, -1]);
        gl.uniform2f(u.uVideoSize, this.width, this.height);
        gl.uniform1f(u.uTime, sy.time || 0);
        gl.uniform1f(u.uBurst, sy.burst || 0);
      }
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
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.aiTex);
    gl.uniform1i(c.u.uVideo, 0);
    gl.uniform1i(c.u.uStyled, 1);
    gl.uniform1i(c.u.uAi, 2);
    gl.uniform1f(c.u.uActive, active ? 1 : 0);
    gl.uniform1f(c.u.uMirror, opts.mirror ? 1 : 0);
    gl.uniform2f(c.u.uVideoSize, this.width, this.height);
    gl.uniform1f(c.u.uBorder, opts.border || 0);
    if (active) {
      gl.uniform2fv(c.u.uQuad, opts.quad.flatMap((p) => [p.x, p.y]));
    }
    const ai = opts.ai;
    gl.uniform1f(c.u.uUseAi, ai ? 1 : 0);
    if (ai) gl.uniform4f(c.u.uAiRect, ai.rect.x, ai.rect.y, ai.rect.w, ai.rect.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
