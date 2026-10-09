import { HandFrameTracker } from './hands.js';
import { Renderer, STYLES } from './renderer.js';
import { AiStylizer } from './ai.js';

const $ = (sel) => document.querySelector(sel);
const video = $('#video');
const canvas = $('#canvas');
const overlay = $('#overlay');
const status = $('#status');
const hint = $('#hint');
const toolbar = $('#toolbar');
const cameraSelect = $('#camera');
const aiFile = $('#ai-file');

const DEFAULT_AI_MODEL = 'models/anime.onnx';

const state = {
  style: 'webtoon',
  mirror: true,
  border: false,
  debug: false,
  quad: null,
  fps: 0,
  aiResult: null,
  lastQuadAt: 0,
};
window.__app = state; // 디버그용 (콘솔에서 상태 확인)

const tracker = new HandFrameTracker();
window.__tracker = tracker;
const ai = new AiStylizer();
let renderer;
let stream;

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle('error', isError);
  status.hidden = !text;
}

async function startCamera(deviceId) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      facingMode: deviceId ? undefined : 'user',
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });
  video.srcObject = stream;
  await video.play();
  await listCameras();
}

async function listCameras() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const current = stream?.getVideoTracks()[0]?.getSettings().deviceId;
  cameraSelect.innerHTML = '';
  devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `카메라 ${i + 1}`;
    opt.selected = d.deviceId === current;
    cameraSelect.append(opt);
  });
  cameraSelect.hidden = devices.length < 2;
}

// ---------- 렌더 루프 ----------
let lastVideoTime = -1;
let frames = 0;
let fpsT0 = performance.now();

function loop() {
  requestAnimationFrame(loop);
  if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const now = performance.now();

  renderer.resize(video.videoWidth, video.videoHeight);
  state.quad = tracker.update(video, now);
  if (state.quad) state.lastQuadAt = now;
  renderer.uploadVideo(video);

  const useAi = state.style === 'ai' && ai.ready;
  if (useAi && state.quad && !ai.busy) {
    ai.busy = true;
    ai.run(video, state.quad)
      .then((res) => {
        renderer.uploadAi(res.rgba, res.w, res.h);
        state.aiResult = res;
      })
      .catch((err) => {
        console.error(err);
        setStatus('AI 변환 중 오류가 났어요. 웹툰 필터로 계속합니다.', true);
        state.style = 'webtoon';
        syncButtons();
      })
      .finally(() => { ai.busy = false; });
  }
  if (!state.quad) state.aiResult = null;

  renderer.render({
    quad: state.quad,
    style: state.style === 'ai' ? STYLES.webtoon : STYLES[state.style],
    mirror: state.mirror,
    border: state.border ? 3 : 0,
    ai: useAi && state.aiResult ? { rect: state.aiResult.rect } : null,
  });

  hint.classList.toggle('show', now - state.lastQuadAt > 4000);
  drawDebug();

  frames++;
  if (now - fpsT0 > 1000) {
    state.fps = Math.round((frames * 1000) / (now - fpsT0));
    frames = 0;
    fpsT0 = now;
  }
}

// D 키: 손 랜드마크와 FPS 표시
function drawDebug() {
  const ctx = overlay.getContext('2d');
  if (overlay.width !== canvas.width || overlay.height !== canvas.height) {
    overlay.width = canvas.width;
    overlay.height = canvas.height;
  }
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!state.debug) return;
  const W = overlay.width, H = overlay.height;
  const X = (x) => (state.mirror ? 1 - x : x) * W;
  ctx.fillStyle = '#00e5ff';
  for (const hand of tracker.lastHands) {
    for (const p of hand) {
      ctx.beginPath();
      ctx.arc(X(p.x), p.y * H, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (state.quad) {
    ctx.strokeStyle = '#ff3d71';
    ctx.lineWidth = 2;
    ctx.beginPath();
    state.quad.forEach((p, i) => (i ? ctx.lineTo(X(p.x), p.y * H) : ctx.moveTo(X(p.x), p.y * H)));
    ctx.closePath();
    ctx.stroke();
  }
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillStyle = '#fff';
  const aiInfo = ai.ready ? ` · AI ${ai.provider} ${Math.round(ai.lastMs)}ms` : '';
  ctx.fillText(`${state.fps} fps · 손 인식 ${tracker.delegate}${aiInfo}`, 16, 32);
}

// ---------- AI 모델 ----------
async function loadAi(source, name) {
  setStatus('AI 모델을 불러오는 중… (처음엔 5~20초 걸릴 수 있어요)');
  try {
    await ai.load(source, name);
    setStatus('');
    state.style = 'ai';
  } catch (err) {
    console.error(err);
    setStatus('AI 모델을 불러오지 못했어요. .onnx 파일을 확인해 주세요. 웹툰 필터로 계속합니다.', true);
    setTimeout(() => setStatus(''), 4000);
    state.style = 'webtoon';
  }
  syncButtons();
}

async function selectAi() {
  if (ai.ready) { state.style = 'ai'; syncButtons(); return; }
  // models/anime.onnx 를 기본으로 사용, 없으면 파일 선택
  const exists = await fetch(DEFAULT_AI_MODEL, { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
  if (exists) loadAi(DEFAULT_AI_MODEL, DEFAULT_AI_MODEL);
  else aiFile.click();
}

aiFile.addEventListener('change', () => {
  const file = aiFile.files[0];
  if (file) loadAi(file, file.name);
  aiFile.value = '';
});

// ---------- 컨트롤 ----------
function syncButtons() {
  document.querySelectorAll('[data-style]').forEach((b) => b.classList.toggle('on', b.dataset.style === state.style));
  $('#btn-mirror').classList.toggle('on', state.mirror);
  $('#btn-border').classList.toggle('on', state.border);
}

function setStyle(style) {
  if (style === 'ai') selectAi();
  else { state.style = style; syncButtons(); }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

function capture() {
  canvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `icebreaking-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
  document.body.classList.add('flash');
  setTimeout(() => document.body.classList.remove('flash'), 150);
}

document.querySelectorAll('[data-style]').forEach((b) => b.addEventListener('click', () => setStyle(b.dataset.style)));
$('#btn-mirror').addEventListener('click', () => { state.mirror = !state.mirror; syncButtons(); });
$('#btn-border').addEventListener('click', () => { state.border = !state.border; syncButtons(); });
$('#btn-full').addEventListener('click', toggleFullscreen);
$('#btn-shot').addEventListener('click', capture);
cameraSelect.addEventListener('change', () => startCamera(cameraSelect.value).catch(showCameraError));

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement) return;
  const key = e.key.toLowerCase();
  const map = { 1: 'webtoon', 2: 'sketch', 3: 'pixel', 4: 'ai' };
  if (map[key]) setStyle(map[key]);
  else if (key === 'm') { state.mirror = !state.mirror; syncButtons(); }
  else if (key === 'b') { state.border = !state.border; syncButtons(); }
  else if (key === 'f') toggleFullscreen();
  else if (key === 's') capture();
  else if (key === 'd') state.debug = !state.debug;
  else if (key === 'h') toolbar.classList.toggle('hidden');
});

// 마우스를 3초간 안 움직이면 툴바 숨김 (발표 화면 깔끔하게)
let idleTimer;
window.addEventListener('mousemove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
});

function showCameraError(err) {
  console.error(err);
  const msg = err && err.name === 'NotAllowedError'
    ? '카메라 권한이 거부됐어요. 주소창 왼쪽 자물쇠 아이콘에서 카메라를 허용해 주세요.'
    : err && err.name === 'NotFoundError'
      ? '카메라를 찾지 못했어요. 웹캠 연결을 확인해 주세요.'
      : `카메라를 켤 수 없어요: ${err?.message || err}`;
  setStatus(msg, true);
}

async function main() {
  syncButtons();
  if (!window.isSecureContext) {
    setStatus('카메라는 https:// 또는 http://localhost 주소에서만 켤 수 있어요. README의 실행 방법을 확인해 주세요.', true);
    return;
  }
  try {
    renderer = new Renderer(canvas);
  } catch (err) {
    setStatus(err.message, true);
    return;
  }
  setStatus('손 인식 모델을 불러오는 중…');
  try {
    await Promise.all([tracker.init(), startCamera()]);
  } catch (err) {
    if (!tracker.landmarker) setStatus(`손 인식 모델을 불러오지 못했어요: ${err.message}`, true);
    else showCameraError(err);
    return;
  }
  setStatus('');
  requestAnimationFrame(loop);
}

main();
