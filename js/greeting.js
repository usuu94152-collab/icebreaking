// 인사 자막: 한 손으로 펴는 손가락 개수에 따라 자막을 바꾼다.
// 문구는 아래 배열만 고치면 된다. (1개 → 첫 번째 문구, … 5개 → 다섯 번째 문구)
export const GREETINGS = [
  '안녕하세요',                 // 검지
  '저는 오늘 여러분들과',        // 검지 + 중지
  'AI에 대해 이야기 할',         // 검지 + 중지 + 약지
  '체육교사 유성욱입니다',        // 검지 + 중지 + 약지 + 새끼
  '만나뵙게 되어 반갑습니다',     // 다섯 손가락
];

const STABLE_MS = 200;   // 같은 손가락 모양이 이만큼 유지돼야 자막을 바꾼다 (깜빡임 방지)
const HIDE_MS = 900;     // 손이 안 보이거나 주먹을 쥔 뒤 이만큼 지나면 자막을 숨긴다

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// 손가락(검지·중지·약지·새끼): [MCP, PIP, TIP] 랜드마크 번호
const FINGERS = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]];

// 손가락 끝이 두 번째 마디보다 손목에서 충분히 멀면 펴진 것
function fingerExtended(lm, [mcp, pip, tip]) {
  const w = lm[0];
  return dist(w, lm[tip]) > dist(w, lm[pip]) * 1.1 && dist(w, lm[tip]) > dist(w, lm[mcp]) * 1.25;
}

// 엄지가 손바닥 바깥으로 얼마나 나와 있는지.
// 새끼 뿌리 → 검지 뿌리 방향을 축으로 잡고, 엄지 끝이 검지 뿌리보다 바깥으로 나온 정도를
// 손바닥 폭 대비 비율로 계산한다. (손 크기·기울기·손바닥/손등 방향과 무관)
// 접으면 손바닥 안쪽이라 0 이하, 펴면 보통 0.3 이상 (실제 손에서 0.15 정도로 작게 나오기도 함).
export function thumbOut(lm) {
  const ix = lm[5], pk = lm[17], tip = lm[4];
  const width = dist(ix, pk) || 1e-6;
  const ux = (ix.x - pk.x) / width, uy = (ix.y - pk.y) / width;
  return ((tip.x - ix.x) * ux + (tip.y - ix.y) * uy) / width;
}
const THUMB_OUT = 0.15;
const THUMB_OUT_HOLD = 0.05;  // 이미 5 를 보여주는 중이면 기준을 낮춰서 4↔5 깜빡임 방지

// 1~5 (자막 번호) 또는 null (해당 없는 손 모양 / 주먹)
// 검지부터 차례로 펴야 인정한다: 검지 / 검지+중지 / … (새끼만 편 손 등은 무시)
// shown: 지금 보이는 자막 번호 (엄지 기준을 정할 때 사용)
export function countFingers(lm, shown = null) {
  const ext = FINGERS.map((f) => fingerExtended(lm, f));
  const n = ext.indexOf(false) === -1 ? 4 : ext.indexOf(false);
  if (n === 0 || ext.slice(n).some(Boolean)) return null;
  if (n === 4 && thumbOut(lm) > (shown === 5 ? THUMB_OUT_HOLD : THUMB_OUT)) return 5;
  return n;
}

export class GreetingCaption {
  constructor(el) {
    this.el = el;
    this.textEl = el.querySelector('.text');
    this.dotsEl = el.querySelector('.dots');
    this.dotsEl.innerHTML = GREETINGS.map(() => '<i></i>').join('');
    this.shown = null;      // 지금 보이는 자막 번호
    this.candidate = null;  // 바뀌려고 대기 중인 번호
    this.candidateAt = 0;
    this.lastValidAt = -Infinity;
  }

  // hands: 이번 프레임의 손 랜드마크 배열들, active: 자막을 띄워도 되는 상황인지
  update(hands, now, active) {
    let value = null;
    if (active && hands.length) {
      // 손이 둘이면 더 높이 든 손 기준
      const hand = hands.reduce((a, b) => (a[0].y < b[0].y ? a : b));
      value = countFingers(hand, this.shown);
    }

    if (value !== null) {
      this.lastValidAt = now;
      if (value !== this.candidate) {
        this.candidate = value;
        this.candidateAt = now;
      }
      if (value !== this.shown && now - this.candidateAt >= STABLE_MS) this.show(value);
    } else if (!active || now - this.lastValidAt > HIDE_MS) {
      this.candidate = null;
      if (this.shown !== null) this.hide();
    }
  }

  show(n) {
    this.shown = n;
    this.textEl.textContent = GREETINGS[n - 1];
    [...this.dotsEl.children].forEach((d, i) => d.classList.toggle('on', i < n));
    this.el.classList.add('show');
    // 바뀔 때마다 톡 튀어나오는 애니메이션
    this.textEl.classList.remove('pop');
    void this.textEl.offsetWidth;
    this.textEl.classList.add('pop');
  }

  hide() {
    this.shown = null;
    this.el.classList.remove('show');
  }
}
