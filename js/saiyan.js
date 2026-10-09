// 초사이어인 효과: 얼굴 랜드마크를 기준으로 금색 뾰족 머리·번개를 2D 캔버스에 그린다.
// 캔버스는 영상과 같은 좌표계(좌우반전 전)이고, 렌더러가 텍스처로 받아 합성한다.

// MediaPipe Face Mesh 랜드마크 번호
const FOREHEAD = 10;
const CHIN = 152;
const FACE_R = 234;   // 화면 왼쪽 볼 끝
const FACE_L = 454;   // 화면 오른쪽 볼 끝
const IRIS_R = 468;   // 눈동자 중심 (469~472 는 눈동자 테두리)
const IRIS_L = 473;

// 위로 솟는 머리카락: [기준 각도(도, 0=위), 길이(얼굴 높이 배수)]
const SPIKES = [
  [-128, 0.26], [128, 0.25],
  [-100, 0.38], [-72, 0.58], [-44, 0.78], [-15, 0.9],
  [14, 0.86], [43, 0.74], [71, 0.55], [100, 0.36],
];
// 이마로 내려오는 앞머리: [가로 위치(얼굴 폭 배수), 길이(얼굴 높이 배수), 기울기]
const BANGS = [
  [-0.42, 0.14, -0.5], [-0.26, 0.22, -0.3], [-0.09, 0.28, -0.1],
  [0.08, 0.25, 0.15], [0.25, 0.2, 0.35], [0.41, 0.13, 0.5],
];

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a) => Math.hypot(a.x, a.y);
const norm = (a) => mul(a, 1 / (len(a) || 1));

export class SaiyanFx {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.bolts = [];
    this.uniforms = null;
  }

  // landmarks: 얼굴 랜드마크(없으면 null), w/h: 영상 크기(px), t: 초
  draw(landmarks, w, h, t) {
    const { canvas, ctx } = this;
    // 절반 해상도로 그려서 그리기·업로드 비용을 1/4 로 (좌표는 원본 기준 그대로 사용)
    const S = 0.5;
    if (canvas.width !== Math.round(w * S) || canvas.height !== Math.round(h * S)) {
      canvas.width = Math.round(w * S);
      canvas.height = Math.round(h * S);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(S, 0, 0, S, 0, 0);
    if (!landmarks) {
      this.uniforms = null;
      return;
    }

    const P = (i) => ({ x: landmarks[i].x * w, y: landmarks[i].y * h });
    const top = P(FOREHEAD);
    const chin = P(CHIN);
    const H = len(sub(top, chin));
    const W = len(sub(P(FACE_L), P(FACE_R)));
    const up = norm(sub(top, chin));
    const right = { x: -up.y, y: up.x };
    const crown = add(top, mul(up, 0.3 * H));
    const local = (x, y) => add(add(crown, mul(right, x)), mul(up, y));

    // 머리카락 전체 도형 (몸통 타원 + 뾰족 가시 + 앞머리)
    const shapes = [];
    const a = 0.62 * W, b = 0.4 * H;
    for (const [deg, l] of SPIKES) {
      const th = (deg * Math.PI) / 180;
      const spread = 0.34;
      const base1 = local(a * Math.sin(th - spread), b * Math.cos(th - spread));
      const base2 = local(a * Math.sin(th + spread), b * Math.cos(th + spread));
      const mid = mul(add(base1, base2), 0.5);
      const radial = norm(sub(mid, crown));
      const dir = norm(add(radial, mul(up, 0.6)));   // 위로 쓸어 올린 머리
      // 오라에 흩날리듯 살짝 흔들림
      const wobble = Math.sin(t * 9 + deg) * 0.03 * H;
      const tip = add(add(mid, mul(dir, l * H)), mul(right, wobble));
      shapes.push({ kind: 'spike', base1, base2, tip, mid });
    }
    for (const [x, l, tilt] of BANGS) {
      const base = add(add(top, mul(right, x * W)), mul(up, 0.02 * H));
      const half = mul(right, 0.11 * W);
      const tip = add(add(base, mul(up, -l * H)), mul(right, tilt * 0.15 * W));
      shapes.push({ kind: 'spike', base1: sub(base, half), base2: add(base, half), tip, mid: base });
    }
    const center = local(0, -0.02 * H);
    const angle = Math.atan2(right.y, right.x);

    // 도형마다 따로 그린다 (한 경로로 합치면 겹친 부분이 감기 방향 때문에 구멍이 날 수 있음)
    const eachShape = (paint) => {
      ctx.beginPath();
      ctx.ellipse(center.x, center.y, a * 1.02, b * 1.05, angle, 0, Math.PI * 2);
      paint();
      for (const s of shapes) {
        ctx.beginPath();
        ctx.moveTo(s.base1.x, s.base1.y);
        // 가장자리를 살짝 휘게 해서 붓으로 그린 느낌
        const c1 = add(mul(add(s.base1, s.tip), 0.5), mul(sub(s.mid, s.base1), -0.25));
        const c2 = add(mul(add(s.base2, s.tip), 0.5), mul(sub(s.mid, s.base2), -0.25));
        ctx.quadraticCurveTo(c1.x, c1.y, s.tip.x, s.tip.y);
        ctx.quadraticCurveTo(c2.x, c2.y, s.base2.x, s.base2.y);
        ctx.closePath();
        paint();
      }
    };

    // 1) 굵은 외곽선을 먼저 모두 그리고 2) 그 위를 금색으로 채우면 바깥 테두리만 남는다
    const outline = Math.max(3, W * 0.025);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#6b3a00';
    ctx.lineWidth = outline * 2;
    eachShape(() => ctx.stroke());

    const g0 = add(top, mul(up, -0.1 * H));
    const g1 = add(top, mul(up, 1.3 * H));
    const grad = ctx.createLinearGradient(g0.x, g0.y, g1.x, g1.y);
    grad.addColorStop(0, '#f2a900');
    grad.addColorStop(0.45, '#ffd84a');
    grad.addColorStop(1, '#fff8c4');
    ctx.fillStyle = grad;
    eachShape(() => ctx.fill());

    // 셀 셰이딩: 가시마다 한쪽 면을 어둡게 해서 입체감
    ctx.fillStyle = 'rgba(214, 128, 0, 0.55)';
    for (const sp of shapes) {
      const c2 = add(mul(add(sp.base2, sp.tip), 0.5), mul(sub(sp.mid, sp.base2), -0.25));
      ctx.beginPath();
      ctx.moveTo(sp.mid.x, sp.mid.y);
      ctx.lineTo(sp.tip.x, sp.tip.y);
      ctx.quadraticCurveTo(c2.x, c2.y, sp.base2.x, sp.base2.y);
      ctx.closePath();
      ctx.fill();
    }
    // 하이라이트 결
    ctx.strokeStyle = 'rgba(255, 255, 235, 0.75)';
    ctx.lineWidth = Math.max(2, W * 0.012);
    ctx.lineCap = 'round';
    for (const s of shapes.slice(0, SPIKES.length)) {
      const p0 = add(mul(s.mid, 0.7), mul(s.tip, 0.3));
      const p1 = add(mul(s.mid, 0.25), mul(s.tip, 0.75));
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }

    this.drawBolts(add(top, mul(up, -0.35 * H)), H, t);

    const iris = (c, edge) => {
      const p = P(c);
      return [landmarks[c].x, landmarks[c].y, len(sub(P(edge), p))];
    };
    const headCenter = add(top, mul(up, 0.1 * H));
    this.uniforms = {
      iris: [...iris(IRIS_R, IRIS_R + 1), ...iris(IRIS_L, IRIS_L + 1)],
      head: [headCenter.x / w, headCenter.y / h, 0.9 * H, 1],
      up: [up.x, up.y],
    };
  }

  // 머리 주변에 번쩍이는 번개 (초사이어인2 느낌)
  drawBolts(center, H, t) {
    const { ctx } = this;
    if (Math.random() < 0.12) {
      const ang = Math.random() * Math.PI * 2;
      const r0 = H * (0.9 + Math.random() * 0.3);
      let p = { x: center.x + Math.cos(ang) * r0, y: center.y + Math.sin(ang) * r0 };
      const pts = [p];
      const dir = ang + Math.PI / 2 + (Math.random() - 0.5);
      for (let i = 0; i < 7; i++) {
        const d = dir + (Math.random() - 0.5) * 1.6;
        p = { x: p.x + Math.cos(d) * H * 0.09, y: p.y + Math.sin(d) * H * 0.09 };
        pts.push(p);
      }
      this.bolts.push({ pts, until: t + 0.12 });
    }
    this.bolts = this.bolts.filter((b) => b.until > t);
    ctx.save();
    ctx.lineJoin = 'round';
    for (const b of this.bolts) {
      // 빛번짐은 shadowBlur 대신 굵은 반투명 선을 겹쳐서 (훨씬 가볍다)
      for (const [color, width] of [['rgba(125, 249, 255, 0.25)', 16], ['rgba(125, 249, 255, 0.9)', 6], ['#ffffff', 2]]) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        b.pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
