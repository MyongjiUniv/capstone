# 팔당호 수온 예측 대시보드 (공개용)

팔당호 조사 수역의 수온을 상류 세 하천의 전일 수온과 위치·계절·시각으로 추정하는 CatBoost 모형(E2-A)의 결과를 보여주는 정적 웹페이지입니다. 서버 없이 GitHub Pages로 배포합니다.

공개용이라 **현장 수표면·연직 계측 원자료는 들어 있지 않습니다.** 모형과 점수는 현장 계측(1~18차)으로 만든 결과이고, 그래프의 관측값은 팔당호 수질측정망, 모형 입력은 한강 수질자동측정망(가평·양평·경안천) 값입니다.

## 화면 구성

화면은 위쪽 탭 네 개로 나뉩니다. 선택한 탭·날짜·지점·목표는 주소 끝(`#tab=map&date=2025-07-11&site=팔당댐4&target=Temp`)에 남아 그대로 링크로 공유할 수 있습니다. 탭이 없는 예전 링크(`#date=…`)는 예측 지도 탭으로 열립니다.

- **소개**: 한눈에(질문·수치 4개), 01 배경(세 하천과 수온·EC의 의미, 상류 세 하천의 계절별 수온 그림), 02 필요성과 연구 목표, 03 작동 방식(입력 → 모형 → 결과), 04 자료(정답·입력·후보 입력 카드, 입력 세트 F0~F4, 조사 차수와 기간 나누기 그림), 05 검증 설계
- **예측 지도**: 날짜별 예측 수온 지도(브라우저가 모형을 직접 계산), 측정망 지점 시계열, 조사일별 오차
- **모델 성능**: 최종 후보 점수 4개, 01 모델별 성능 한눈에(모형마다 한 줄: 개발검증·LOSO 막대, 최종시험, GAM과 비교 판정, 판단), 02 상세 비교표(학습집합 두 가지)와 GAM 대비 차이 그림, 모형 설명, 지표 설명, 입력별 중요도와 주의
- **유역·자료**: 유역도(유역 경계 자료가 있을 때), 유입 하천과 자료 지점 지도, 조사 수역과 호 안 측정망 지도, 자료 지점 표(위치 정밀도 포함), 용어 설명

## 폴더 구조

```
대시보드/
├── index.html              화면
├── assets/
│   ├── app.js              자료 읽기, 모형 계산, 지도·그래프
│   └── style.css           밝은/어두운 화면 색과 배치
├── data/                   대시보드 자료(JSON 10개는 scripts/build_data.py, basin.json은 scripts/build_basin.py가 만듦)
│   ├── model_trees.json    E2-A 모형의 대칭 나무 1,000개
│   ├── model_info.json     기준값, 입력 순서, 학습 정보
│   ├── lake_geometry.json  조사 수역 격자·경계·측정망 위치(UTM 52N)
│   ├── daily.json          날짜별 상류 입력과 예측 요약
│   ├── station_daily.json  측정망 지점별 예측과 관측
│   ├── model_comparison.json  모형별 성능 비교표(개발검증·LOSO·최종시험, 수온·EC)
│   ├── scores.json · test_diff.json · survey_scores.json · importance.json
│   └── basin.json          유역·자료 화면의 지도(하천·호소 수면, 자료 지점, 유역 경계)
├── scripts/
│   ├── build_data.py       모델 결과에서 data/를 다시 만드는 스크립트
│   ├── build_basin.py      지도 자료 basin.json을 만드는 스크립트
│   ├── geo/                OpenStreetMap 하천·수면(부호화한 텍스트)
│   └── requirements.txt
├── .gitignore              data/survey_cells.json(현장 계측 셀 자료)이 올라가지 않게 막음
└── .nojekyll
```

## 내 컴퓨터에서 보기

`index.html`을 더블클릭해서 열면 브라우저 보안 때문에 `data/*.json`을 읽지 못합니다. 이 폴더에서 간단한 서버를 띄워 여세요.

```bash
cd 대시보드
python -m http.server 8000
```

브라우저에서 <http://localhost:8000> 을 엽니다.

## 자료 다시 만들기

모델 결과가 바뀌었을 때만 필요합니다. 이 폴더가 `캡스톤디자인/대시보드`에 있으면 경로를 따로 줄 필요가 없습니다.

```bash
pip install -r scripts/requirements.txt
python scripts/build_data.py --public
```

- `--public`: 공개용. 현장 계측 셀 자료(`survey_cells.json`)를 만들지 않고, 있으면 지웁니다. **공개 저장소에 올릴 때는 항상 이 옵션을 씁니다.**
- `--public` 없이 실행하면 `data/survey_cells.json`이 생기고, 지도 오른쪽에 조사일 수표면 관측이 나란히 나옵니다. 팀 안에서 내 컴퓨터로 볼 때만 씁니다.
- 읽는 곳: `캡스톤디자인/모델구성/`의 `0. 준비자료`, `2. E1_E3_기계학습`, `3. 최종시험_수온`(번호 없는 폴더 이름도 찾음)
- 다른 위치에서 실행할 때: `python scripts/build_data.py --public --root "D:/김동현/석사/수업/26-2/캡스톤디자인"`
- 마지막 줄에 "나무 직접 계산과 CatBoost 예측의 최대 차이"가 0이면 브라우저 계산이 CatBoost와 같다는 뜻입니다.

## 지도 자료 다시 만들기(basin.json)

```bash
python scripts/build_basin.py
```

- 하천·호소 수면과 댐·보 위치는 OpenStreetMap(© OpenStreetMap contributors, ODbL)에서 받아 단순화한 `scripts/geo/*.txt`를 씁니다.
- 팔당호 수질측정망 5곳은 `data/lake_geometry.json`의 자료 좌표입니다. 기상관측소(양평 ASOS·경기광주 AWS·청평 AWS)는 기상청 관측지점정보의 좌표입니다. 자동측정망 3곳(가평: 가평군 청평면 북한강로 1537, 양평: 양평군 옥천면 경강로 1520, 경안천: 광주시 퇴촌면 산수로 969)은 원자료에 좌표가 없어, 도로명주소의 건물번호를 OpenStreetMap 도로 위 주변 주소 지점 사이에 보간해 위치를 잡았습니다(정밀도 「주소」, 오차 100 m 안팎). 경안천 유량 지점 「광주시(경안교)」는 쌍령동 쪽 경안교(국도, 37.4060N 127.2635E) 위치입니다. 정확한 좌표가 생기면 스크립트 위쪽 `SITES` 표의 `lat`, `lon`, `precision`을 고칩니다. `precision='근사'`로 두면 지도에서 속이 빈 기호로 보입니다.
- **유역 경계**: 중권역(또는 표준유역) shp를 주면 북한강·남한강·경안천·팔당호 직접 유역으로 묶어 「유역도」 카드가 나타납니다. 유역 이름 열은 `--name-field`로 고릅니다.

```bash
python scripts/build_basin.py --basin-shp "C:/Users/<사용자>/한강중권역/<파일>.shp" --name-field <이름 열>
```

## GitHub에 올리고 배포하기

`capstone` 저장소는 비공개로 두고, 이 대시보드만 별도의 **공개 저장소**에 올립니다. 공개 저장소에서는 GitHub Pages를 무료로 쓸 수 있습니다.

### 1. 공개 저장소 만들기

GitHub 오른쪽 위 **+ → New repository**에서 만듭니다.

- **Owner**: `MyongjiUniv`(조직에 저장소를 만들 권한이 있을 때) 또는 개인 계정
- **Repository name**: 예) `paldang-temp-dashboard`
- **Public** 선택, README·.gitignore·license 추가는 끕니다.

### 2. 파일 올리기

웹에서 올릴 때: 새 저장소 첫 화면의 **uploading an existing file** 링크(또는 `https://github.com/<계정>/<저장소>/upload/main`)를 엽니다. `대시보드` 폴더 *안의* `index.html`, `README.md`, `assets`, `data`, `scripts`를 끌어다 놓고 **Commit changes**를 누릅니다. `data` 폴더에 `survey_cells.json`이 있으면 빼고 올립니다.

명령줄로 올릴 때:

```bash
cd 대시보드
git init
git add .
git commit -m "팔당호 수온 예측 대시보드"
git branch -M main
git remote add origin https://github.com/<계정>/<저장소>.git
git push -u origin main
```

`.gitignore`가 `data/survey_cells.json`을 막아 줍니다.

### 3. GitHub Pages 켜기

저장소 **Settings → Pages → Build and deployment**에서

- **Source**: Deploy from a branch
- **Branch**: `main`, 폴더 `/(root)` → **Save**

1~2분 뒤 `https://<계정>.github.io/<저장소>/`에서 열립니다. 조직 저장소라면 `https://myongjiuniv.github.io/<저장소>/` 입니다. 진행 상황은 **Actions** 탭의 "pages build and deployment"에서 볼 수 있습니다.

### 자료를 고친 뒤

`python scripts/build_data.py --public`으로 `data/`를 다시 만들고, 바뀐 `data/*.json`을 같은 방법으로 다시 올리면 몇 분 뒤 사이트에 반영됩니다.

## 모형과 계산 메모

- **모형**: CatBoost 회귀(깊이 4, l2 5, 나무 1,000그루). 입력은 x, y(UTM 52N), 연중일 sin·cos, 시각 sin·cos, 가평·양평·경안천 자동측정망 전일 수온. 개발학습+개발검증(2025-04-18까지)으로 학습했고, 최종시험 구간(2025-04-19~2026-03-31)은 한 번만 예측해 채점했습니다.
- **브라우저 계산**: 나무마다 분기 4개를 `입력값(float32) > 경계값`으로 비교해 잎 번호를 구하고, 잎 값의 합에 기준값을 더합니다. 결측 입력은 가장 낮은 값처럼 처리합니다(CatBoost `nan_mode=Min`).
- **09~17시 평균**: 시각 입력이 조사선이 시간대별로 다른 구역을 지난 영향과 섞여 학습돼, 시간대별 예측이 비물리적으로 오르내립니다(여름에 몇 °C). 그래서 지도와 시계열은 09~17시 매시 예측의 평균을 보여줍니다.
- **학습 기간 날짜**의 지도와 측정망 선은 학습 자료에 맞춘 값이라 실제보다 좋아 보입니다. 성능은 LOSO와 최종시험 점수로 봅니다.
- 모형은 수심을 입력으로 쓰지 않습니다. 여름 수표면은 낮게 예측하는 경향이 있습니다.
- **EC**는 최종 모형이 아직 없어(E4 진행 전) 넣지 않았습니다.

## 외부 자원

- d3 7.9.0 (cdn.jsdelivr.net), Noto Sans KR·Noto Serif KR (Google Fonts). 인터넷 연결이 없으면 d3를 받지 못해 그래프가 그려지지 않습니다.
- 지도 하천·호소 수면: © OpenStreetMap contributors (ODbL).
- 소개 화면의 팔당호 현황 수치: 경기도 「2023 수자원백서」(상수원 이용 인구 약 2,600만 명, 저수용량 2.44억 m³, 유역면적 23,800 km²), 유입 유량 비율: 한국물환경학회지 팔당호 상류 오염부하 연구(koreascience.kr, JAKO201417638007373).
