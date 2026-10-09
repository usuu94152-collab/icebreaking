// MediaPipe Hands → "손가락 프레임" 다각형 계산
// - 두 손 모두 검지가 위(엄지가 아래): 사각형
// - 한 손이라도 뒤집으면(검지가 아래, 엄지가 위): 가운데에서 만나는 삼각형 두 개 (⋈)
import { FilesetResolver, HandLandmarker } from '../vendor/mediapipe/vision_bundle.js';

const THUMB_TIP = 4;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const WRIST = 0;

// 손떨림을 줄이는 One Euro Filter (빠르게 움직일 땐 덜 부드럽게, 멈춰 있을 땐 더 부드럽게)
class OneEuro {
  constructor(minCutoff = 3.0, beta = 25, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
    this.t = 0;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  reset() { this.x = null; }
  filter(value, t) {
    if (this.x === null) {
      this.x = value;
      this.dx = 0;
      this.t = t;
      return value;
    }
    const dt = Math.max((t - this.t) / 1000, 1e-3);
    this.t = t;
    const dx = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// 검지가 펴져 있는지 (손목→검지끝 거리가 손목→검지 두번째 마디보다 충분히 김)
function indexExtended(lm) {
  return dist(lm[WRIST], lm[INDEX_TIP]) > dist(lm[WRIST], lm[INDEX_PIP]) * 1.05;
}

// 손이 뒤집혔는지: 검지 끝이 엄지 끝보다 손 크기의 25% 이상 아래면 뒤집힘.
// 그 사이 애매한 구간에서는 이전 상태를 유지해서 모양이 깜빡이지 않게 한다.
function isFlipped(hand, prev) {
  const size = dist(hand[WRIST], hand[9]) || 1e-6;
  const d = (hand[INDEX_TIP].y - hand[THUMB_TIP].y) / size;
  if (d > 0.25) return true;
  if (d < -0.25) return false;
  return prev;
}

// 꼭짓점을 중심 기준 각도로 정렬해서 꼬이지 않는 사각형으로 만든다
function orderAroundCentroid(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

export class HandFrameTracker {
  constructor() {
    this.landmarker = null;
    this.filters = Array.from({ length: 8 }, () => new OneEuro());
    this.poly = null;          // 프레임 꼭짓점 [{x,y}…], 영상 기준 0~1 좌표 (좌우반전 전)
    this.shape = null;         // 'rect' | 'bowtie'
    this.flipped = [false, false];  // [왼쪽 손, 오른쪽 손] 뒤집힘 여부
    this.lastSeen = -Infinity;
    this.holdMs = 180;         // 손 인식이 잠깐 끊겨도 프레임을 유지하는 시간
    this.lastHands = [];       // 이번 프레임의 모든 손 랜드마크 (인사 자막·디버그 표시용)
    this.delegate = null;
  }

  async init() {
    const base = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
    const modelAssetPath = new URL('../models/hand_landmarker.task', import.meta.url).href;
    const fileset = await FilesetResolver.forVisionTasks(base);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options('GPU'));
      this.delegate = 'GPU';
    } catch (err) {
      console.warn('GPU 손 인식 실패, CPU로 전환합니다.', err);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
      this.delegate = 'CPU';
    }
  }

  // 영상 프레임 하나를 처리하고, 현재 프레임 다각형(없으면 null)을 돌려준다
  update(video, now) {
    const result = this.landmarker.detectForVideo(video, now);
    const hands = (result.landmarks || []).filter(indexExtended);
    this.lastHands = result.landmarks || [];

    if (hands.length >= 2) {
      // 화면상 x 위치로 두 손을 고른다 (가장 바깥쪽 두 손)
      const sorted = [...hands].sort((a, b) => a[WRIST].x - b[WRIST].x);
      const left = sorted[0];
      const right = sorted[sorted.length - 1];
      const raw = [left[INDEX_TIP], right[INDEX_TIP], right[THUMB_TIP], left[THUMB_TIP]];
      const [l8, r8, r4, l4] = raw.map((p, i) => ({
        x: this.filters[i * 2].filter(p.x, now),
        y: this.filters[i * 2 + 1].filter(p.y, now),
      }));
      this.flipped = [isFlipped(left, this.flipped[0]), isFlipped(right, this.flipped[1])];

      if (this.flipped[0] || this.flipped[1]) {
        // 삼각형 두 개: 각 손의 검지·엄지 끝 두 점 + 가운데 한 점
        const c = { x: (l8.x + r8.x + r4.x + l4.x) / 4, y: (l8.y + r8.y + r4.y + l4.y) / 4 };
        const [lu, ll] = l8.y < l4.y ? [l8, l4] : [l4, l8];
        const [ru, rl] = r8.y < r4.y ? [r8, r4] : [r4, r8];
        // 한 붓 그리기 순서: 왼쪽 위 → 가운데 → 오른쪽 위 → 오른쪽 아래 → 가운데 → 왼쪽 아래
        this.poly = [lu, c, ru, rl, c, ll];
        this.shape = 'bowtie';
      } else {
        this.poly = orderAroundCentroid([l8, r8, r4, l4]);
        this.shape = 'rect';
      }
      this.lastSeen = now;
    } else if (now - this.lastSeen > this.holdMs) {
      this.poly = null;
      this.shape = null;
      this.filters.forEach((f) => f.reset());
    }
    return this.poly;
  }
}
