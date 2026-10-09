# 손가락 프레임 웹툰 필터 (아이스브레이킹용)

웹캠 앞에서 양손 **엄지·검지로 ㄱ ㄴ 모양 프레임**을 만들면, 그 프레임 안쪽만 실시간으로 웹툰/스케치/픽셀 그림으로 바뀌는 브라우저 앱입니다.
강의 시작할 때 화면에 띄워 두고 강사나 학생이 직접 해 보는 용도로 만들었습니다.

- 손 인식: MediaPipe Hand Landmarker (브라우저에서 실행, 모델 파일 포함 → **인터넷 없어도 동작**)
- 스타일 변환: WebGL 셰이더 (일반 노트북 내장 그래픽으로도 실시간)
- 선택 기능: AnimeGANv3 AI 모델(.onnx)을 넣으면 진짜 애니 그림체로 변환

## 실행 방법

카메라는 보안상 `https://` 주소나 `http://localhost` 에서만 켜집니다. `index.html` 을 더블클릭해서 여는 방식(`file://`)은 동작하지 않아요.

### 방법 1. 로컬에서 실행 (강의실 인터넷이 불안할 때 추천)

1. 이 레포를 내려받습니다 (GitHub → Code → Download ZIP 후 압축 해제).
2. 실행 스크립트를 더블클릭합니다.
   - Windows: `start.bat`
   - macOS: `start.command`
3. 브라우저가 `http://localhost:8000` 으로 열리면 카메라 권한을 **허용**합니다.

> 두 스크립트 모두 Python 이 필요합니다. 없다면 터미널에서 이 폴더로 이동한 뒤 `npx serve` 로 실행해도 됩니다.

### 방법 2. GitHub Pages

레포 Settings → Pages 에서 이 브랜치를 배포하면 `https://<아이디>.github.io/icebreaking/` 주소로 바로 열 수 있습니다.

**브라우저는 최신 Chrome 이나 Edge 를 권장합니다.**

## 사용법

| 동작 | 방법 |
|---|---|
| 프레임 만들기 | 양손 검지는 위로, 엄지는 안쪽으로 펴서 ㄱ ㄴ 모양 |
| 스타일 바꾸기 | 하단 버튼 또는 `1` 웹툰 · `2` 스케치 · `3` 픽셀 · `4` AI 애니 |
| 좌우 반전 | `M` (기본값: 거울 모드) |
| 프레임 테두리 | `B` |
| 전체화면 | `F` |
| 캡처 저장 | `S` (PNG로 다운로드) |
| 툴바 숨기기 | `H` (마우스를 3초간 안 움직이면 자동으로 숨겨짐) |
| 디버그 표시 | `D` (손 랜드마크, FPS) |

카메라가 여러 대면 툴바에 카메라 선택 메뉴가 나타납니다.

### 진행 팁

- 손끝을 입 앞에 모았다가 천천히 벌리면, 작은 그림 조각이 점점 커지는 연출이 됩니다.
- 프로젝터 화면에 띄울 때는 거울 모드(기본값)가 자연스럽습니다.
- 손이 화면에 잘 보이도록 밝은 곳에서, 웹캠에서 1m 정도 떨어지면 인식이 잘 됩니다.

## (선택) AI 애니 모드

기본 웹툰 필터는 셰이더로 만든 "만화풍 보정"이라, 얼굴 자체를 애니 캐릭터 그림체로 다시 그려 주지는 않습니다.
원본 영상처럼 진짜 애니 얼굴을 원하면 **AnimeGANv3** 모델을 추가해서 쓸 수 있습니다.

1. AnimeGANv3 `.onnx` 모델을 내려받습니다.
   - 예: [AnimeGANv3_large_Ghibli_c1_e299.onnx](https://github.com/TachibanaYoshino/AnimeGANv3_Portrait_Inference/releases/download/1.0/AnimeGANv3_large_Ghibli_c1_e299.onnx)
   - 다른 스타일: [AnimeGANv3 레포](https://github.com/TachibanaYoshino/AnimeGANv3) 참고
2. 다음 둘 중 하나로 불러옵니다.
   - `AI 애니` 버튼(`4`)을 누르면 파일 선택 창이 뜨니 `.onnx` 파일을 고릅니다.
   - 또는 파일을 `models/anime.onnx` 로 저장해 두면 버튼을 누를 때 자동으로 불러옵니다.

주의할 점:
- AI 실행 엔진(onnxruntime-web)은 CDN에서 받아오므로 이 모드는 **인터넷이 필요**합니다.
- WebGPU를 지원하는 Chrome/Edge에서 빠르게 돌고, 지원하지 않으면 CPU(WASM)로 느리게 돕니다. AI 결과는 영상보다 늦게 갱신될 수 있으니 강의 전에 실제 노트북에서 꼭 미리 테스트해 보세요.
- AnimeGANv3 모델은 원저작자 라이선스(비상업적 사용)를 따릅니다.

## 구조

```
index.html          화면 구성
css/style.css       스타일
js/main.js          카메라, 렌더 루프, 단축키
js/hands.js         MediaPipe 손 인식 → 손가락 프레임 사각형 계산 (One Euro 필터로 떨림 보정)
js/renderer.js      WebGL2 셰이더: 웹툰/스케치/픽셀 변환 + 프레임 안쪽만 합성
js/ai.js            (선택) AnimeGANv3 ONNX 추론
vendor/mediapipe/   MediaPipe Tasks Vision 0.10.14 (Apache-2.0)
models/             hand_landmarker.task (MediaPipe 손 인식 모델)
```

프레임 사각형은 왼손 검지 끝 → 오른손 검지 끝 → 오른손 엄지 끝 → 왼손 엄지 끝(랜드마크 8, 4번) 네 점으로 만듭니다.
