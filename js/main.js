import { HandFrameTracker } from './hands.js';
import { Renderer, STYLES } from './renderer.js';
import { GreetingCaption, countFingers, thumbOut } from './greeting.js';

const $ = (sel) => document.querySelector(sel);
const video = $('#video');
const canvas = $('#canvas');
const overlay = $('#overlay');
const status = $('#status');
const hint = $('#hint');
const toolbar = $('#toolbar');
const cameraSelect = $('#camera');

const state = {
  style: 'webtoon',
  mirror: true,
  border: false,
  debug: false,
  poly: null,          // 손가락 프레임 꼭짓점 (사각형 또는 삼각형 두 개)
  fps: 0,
  lastPolyAt: 0,
  greeting: true,      // 한 손 손가락 개수로 인사 자막
  timing: { hand: 0, render: 0 },  // 단계별 처리 시간(ms), D 키로 표시
};
window.__app = state; // 디버그용 (콘솔에서 상태 확인)

const tracker = new HandFrameTracker();
window.__tracker = tracker;
const caption = new GreetingCaption($('#caption'));
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
let captureRequested = false;

// 처리 시간을 부드럽게 평균 내서 기록
function track(key, t0) {
  const ms = performance.now() - t0;
  state.timing[key] = state.timing[key] * 0.9 + ms * 0.1;
}

function loop() {
  requestAnimationFrame(loop);
  if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const now = performance.now();

  renderer.resize(video.videoWidth, video.videoHeight);
  state.poly = tracker.update(video, now);
  track('hand', now);
  if (state.poly) state.lastPolyAt = now;
  renderer.uploadVideo(video);

  const tr = performance.now();
  renderer.render({
    poly: state.poly,
    style: STYLES[state.style],
    mirror: state.mirror,
    border: state.border ? 3 : 0,
    time: now / 1000,
  });
  track('render', tr);
  // 캡처는 그린 직후에 (매 프레임 화면 버퍼를 보존하지 않아도 되도록)
  if (captureRequested) {
    captureRequested = false;
    saveCanvas();
  }

  // 인사 자막: 양손 프레임이 없을 때만 (프레임 효과가 우선)
  caption.update(tracker.lastHands, now, state.greeting && !state.poly);
  hint.classList.toggle('show', now - state.lastPolyAt > 4000 && caption.shown === null);
  drawDebug();

  frames++;
  if (now - fpsT0 > 1000) {
    state.fps = Math.round((frames * 1000) / (now - fpsT0));
    frames = 0;
    fpsT0 = now;
  }
}

// D 키: 손 랜드마크와 FPS 표시
let debugDrawn = false;
function drawDebug() {
  // 디버그를 끈 상태에선 한 번만 지우고 매 프레임 그리지 않는다
  if (!state.debug && !debugDrawn) return;
  const ctx = overlay.getContext('2d');
  if (overlay.width !== canvas.width || overlay.height !== canvas.height) {
    overlay.width = canvas.width;
    overlay.height = canvas.height;
  }
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  debugDrawn = state.debug;
  if (!state.debug) return;
  const W = overlay.width, H = overlay.height;
  const X = (x) => (state.mirror ? 1 - x : x) * W;
  ctx.font = 'bold 28px system-ui, sans-serif';
  for (const hand of tracker.lastHands) {
    ctx.fillStyle = '#00e5ff';
    for (const p of hand) {
      ctx.beginPath();
      ctx.arc(X(p.x), p.y * H, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // 손목 아래에 인식된 손가락 개수와 엄지 값 표시 (인사 자막 확인용)
    const label = `손가락 ${countFingers(hand, caption.shown) ?? '-'} · 엄지 ${thumbOut(hand).toFixed(2)}`;
    const tw = ctx.measureText(label).width;
    const lx = Math.min(Math.max(X(hand[0].x) - tw / 2, 8), W - tw - 8);
    const ly = Math.min(hand[0].y * H + 48, H - 12);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(lx - 8, ly - 30, tw + 16, 40);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, lx, ly);
  }
  if (state.poly) {
    ctx.strokeStyle = '#ff3d71';
    ctx.lineWidth = 2;
    ctx.beginPath();
    state.poly.forEach((p, i) => (i ? ctx.lineTo(X(p.x), p.y * H) : ctx.moveTo(X(p.x), p.y * H)));
    ctx.closePath();
    ctx.stroke();
  }
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillStyle = '#fff';
  const shape = { rect: ' · 사각형', bowtie: ' · 삼각형 두 개' }[tracker.shape] || '';
  ctx.fillText(`${state.fps} fps · 손 인식 ${tracker.delegate}${shape}`, 16, 32);
  const t = state.timing;
  ctx.fillText(`손 ${t.hand.toFixed(1)}ms · 그리기 ${t.render.toFixed(1)}ms`, 16, 60);
}

// ---------- 컨트롤 ----------
function syncButtons() {
  document.querySelectorAll('[data-style]').forEach((b) => b.classList.toggle('on', b.dataset.style === state.style));
  $('#btn-mirror').classList.toggle('on', state.mirror);
  $('#btn-border').classList.toggle('on', state.border);
  $('#btn-greet').classList.toggle('on', state.greeting);
}

function setStyle(style) {
  state.style = style;
  syncButtons();
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

function capture() {
  captureRequested = true;
  document.body.classList.add('flash');
  setTimeout(() => document.body.classList.remove('flash'), 150);
}

function saveCanvas() {
  canvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `icebreaking-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
}

document.querySelectorAll('[data-style]').forEach((b) => b.addEventListener('click', () => setStyle(b.dataset.style)));
$('#btn-mirror').addEventListener('click', () => { state.mirror = !state.mirror; syncButtons(); });
$('#btn-border').addEventListener('click', () => { state.border = !state.border; syncButtons(); });
$('#btn-greet').addEventListener('click', () => { state.greeting = !state.greeting; syncButtons(); });
$('#btn-full').addEventListener('click', toggleFullscreen);
$('#btn-shot').addEventListener('click', capture);
cameraSelect.addEventListener('change', () => startCamera(cameraSelect.value).catch(showCameraError));

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement) return;
  const key = e.key.toLowerCase();
  const map = { 1: 'webtoon', 2: 'sketch', 3: 'pixel', 4: 'pop', 5: 'neon', 6: 'thermal' };
  if (map[key]) setStyle(map[key]);
  else if (key === 'm') { state.mirror = !state.mirror; syncButtons(); }
  else if (key === 'b') { state.border = !state.border; syncButtons(); }
  else if (key === 'g') { state.greeting = !state.greeting; syncButtons(); }
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
