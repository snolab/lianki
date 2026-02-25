```markdown
---
title: "데스크톱 브라우저에 Lianki 설치하기: 완벽한 설정 가이드"
date: 2025-02-22
tags: [설치, 사용자 스크립트, 스크립트캣, 바이올런트몽키, 탬퍼몽키, 크롬, 엣지, 브라우저]
summary: "ScriptCat, Violentmonkey 또는 Tampermonkey을 사용하여 Chrome/Edge 데스크톱 브라우저에 Lianki를 설치하는 단계별 가이드입니다."
---

# 데스크톱 브라우저에 Lianki 설치하기: 완벽한 설정 가이드

Lianki는 사용자가 방문하는 모든 페이지에 떠다니는 버튼을 추가하는 브라우저에서 실행되는 사용자 스크립트를 통해 작동합니다. 이를 사용하기 위해서는 두 가지가 필요합니다:

1. **사용자 스크립트 관리자 확장 프로그램** (ScriptCat, Violentmonkey, 또는 Tampermonkey)
2. **Lianki 사용자 스크립트** 자체

이 가이드는 **Chrome 및 Edge 데스크톱 브라우저**에 대한 설치를 다룹니다. 이 과정은 약 2-3분이 소요됩니다.

---

## 1단계: 사용자 스크립트 관리자 선택

사용자 스크립트 관리자는 웹사이트를 개선하는 작은 JavaScript 프로그램인 사용자 스크립트를 실행하는 브라우저 확장 프로그램입니다. Lianki를 사용하려면 하나를 설치해야 합니다.

### 어떤 것을 선택해야 하나요?

다음 순서로 추천합니다:

1. **ScriptCat** (추천) — 최신, 빠름, 좋은 개인정보 보호 기본 설정
2. **Violentmonkey** — 오픈 소스, 경량, 사용자 개인정보 보호 존중
3. **Tampermonkey** — 가장 인기 있음, 기능이 풍부하지만 일부 원격 측정 기능 포함

**대부분의 사용자에게**: **ScriptCat**을 설치하세요. 성능, 개인정보 보호, 호환성의 최적 균형을 제공합니다.

**이미 설치되어 있나요?** [2단계](#step-2-install-the-lianki-userscript)로 건너뛸 수 있습니다.

---

## 2단계: 사용자 스크립트 관리자 설치

### 옵션 A: ScriptCat (추천)

**Chrome 사용자:**
1. [Chrome 웹 스토어의 ScriptCat 페이지](https://chrome.google.com/webstore/detail/scriptcat/ndcooeababalnlpkfedmmbbbgkljhpjf)를 엽니다.
2. **Chrome에 추가**를 클릭합니다.
3. 팝업에서 **확장 프로그램 추가**를 클릭합니다.

**Edge 사용자:**
1. [Edge Add-ons의 ScriptCat 페이지](https://microsoftedge.microsoft.com/addons/detail/scriptcat/liilgpjgabokdklappibcjfablkpcekh)를 엽니다.
2. **받기**를 클릭합니다.
3. 팝업에서 **확장 프로그램 추가**를 클릭합니다.

설치 후 브라우저 툴바에 고양이 아이콘(🐱)이 나타납니다.

### 옵션 B: Violentmonkey

**Chrome 사용자:**
1. [Chrome 웹 스토어의 Violentmonkey 페이지](https://chrome.google.com/webstore/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag)를 엽니다.
2. **Chrome에 추가**를 클릭합니다.
3. 팝업에서 **확장 프로그램 추가**를 클릭합니다.

**Edge 사용자:**
1. [Edge Add-ons의 Violentmonkey 페이지](https://microsoftedge.microsoft.com/addons/detail/violentmonkey/eeagobfjdenkkddmbclomhiblgggliao)를 엽니다.
2. **받기**를 클릭합니다.
3. 팝업에서 **확장 프로그램 추가**를 클릭합니다.

설치 후 브라우저 툴바에 원숭이 아이콘이 나타납니다.

### 옵션 C: Tampermonkey

**Chrome 사용자:**
1. [Chrome 웹 스토어의 Tampermonkey 페이지](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)를 엽니다.
2. **Chrome에 추가**를 클릭합니다.
3. 팝업에서 **확장 프로그램 추가**를 클릭합니다.

**Edge 사용자:**
1. [Edge Add-ons의 Tampermonkey 페이지](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)를 엽니다.
2. **받기**를 클릭합니다.
3. 팝업에서 **확장 프로그램 추가**를 클릭합니다.

설치 후 브라우저 툴바에 Tampermonkey 아이콘이 나타납니다.

---

## 2단계: Lianki 사용자 스크립트 설치

사용자 스크립트 관리자를 설치했으니, 이제 Lianki 사용자 스크립트를 추가할 수 있습니다.

### Greasy Fork에서 설치 (추천)

Greasy Fork는 사용자 스크립트의 자동 업데이트 알림을 제공하는 신뢰할 수 있는 저장소입니다.

1. **Lianki 스크립트 페이지를 Greasy Fork에서 엽니다:**
   [https://greasyfork.org/ja/scripts/567089-lianki](https://greasyfork.org/ja/scripts/567089-lianki)

2. **녹색 "이 스크립트 설치" 버튼을 클릭합니다**
   (사용자 스크립트 관리자에 따라 버튼 텍스트가 다를 수 있습니다)

3. **설치 페이지 검토**
   사용자 스크립트 관리자가 스크립트 세부 정보 및 권한을 보여주는 새 탭을 엽니다.

4. **"설치" 또는 "설치 확인" 클릭**
   ScriptCat/Violentmonkey/Tampermonkey은 설치 버튼을 표시하며, 클릭하여 설치를 완료합니다.

5. **완료!** Lianki 스크립트가 이제 활성화되었습니다.

### 대안: 직접 설치

lianki.com에서 직접 설치하려면:

1. 다음으로 이동합니다: [https://www.lianki.com/lianki.user.js](https://www.lianki.com/lianki.user.js)
2. 사용자 스크립트 관리자가 `.user.js` 파일을 감지하고 설치 프롬프트를 표시할 것입니다.
3. **설치**를 클릭하여 스크립트를 추가합니다.

---

## 3단계: 설치 확인

Lianki 사용자 스크립트를 설치한 후에는 방문하는 모든 HTTPS 웹 페이지에서 동작 버튼(FAB)을 볼 수 있어야 합니다.

### 기대할 사항

1. **어떤 HTTPS 웹사이트든 열기** (예: https://www.wikipedia.org)
2. 페이지 오른쪽 하단에 있는 **원형 떠다니는 버튼**을 찾습니다.
3. 버튼은 **드래그 가능** — 이동해보세요.
4. **Alt+F** 키를 누르거나 버튼을 클릭하여 Lianki 대화 상자를 엽니다.

떠다니는 버튼이 보인다면, 축하합니다! Lianki가 설치되고 작동합니다.

### 초기 설정

1. 떠다니는 버튼을 클릭하거나 **Alt+F**를 누릅니다.
2. 로그인하지 않은 경우, 로그인 프롬프트가 나타납니다.
3. Lianki 계정에 [www.lianki.com](https://www.lianki.com)에서 로그인합니다.
4. 웹페이지로 돌아가서 **Alt+F**를 눌러 카드를 추가해봅니다.

---

## 문제 해결

### 떠다니는 버튼이 보이지 않음

**사용자 스크립트 관리자가 활성화되어 있는지 확인:**
- 브라우저 툴바에서 ScriptCat/Violentmonkey/Tampermonkey 아이콘을 찾으세요.
- 클릭하고 확장 프로그램이 활성화된 상태(일시 정지 아님)인지 확인하세요.

**스크립트가 설치되어 있는지 확인:**
- 사용자 스크립트 관리자 아이콘을 클릭하세요.
- 대시보드나 설정을 엽니다.
- 설치된 스크립트 목록에서 "Lianki"를 찾으세요.
- 활성화되어 있는지 확인하세요 (토글이 켜져 있어야 함).

**HTTPS 페이지에 있는지 확인하세요:**
- Lianki 스크립트는 `https://*` URL에서만 실행됩니다.
- `http://` 페이지나 로컬 파일(`file://`)에서는 작동하지 않습니다.
- https://www.wikipedia.org를 방문하여 테스트해보세요.

**브라우저 권한 확인:**
- 일부 브라우저는 특정 페이지(브라우저 설정, 확장 프로그램 스토어 페이지)에서 확장 프로그램을 차단할 수 있습니다.
- 위키피디아나 깃허브 같은 일반 웹사이트를 시도해보세요.

### 스크립트가 설치되었지만 작동하지 않음

**브라우저 캐시 지우기:**
1. `Ctrl+Shift+Delete` (윈도우/리눅스) 또는 `Cmd+Shift+Delete` (맥)를 누릅니다.
2. "캐시된 이미지 및 파일"을 선택합니다.
3. "데이터 지우기" 클릭
4. 페이지 새로 고침

**스크립트 재설치:**
1. 사용자 스크립트 관리자 대시보드를 엽니다.
2. 목록에서 "Lianki"를 찾습니다.
3. 삭제/제거합니다.
4. [Greasy Fork](https://greasyfork.org/ja/scripts/567089-lianki)에서 다시 설치하세요.

**스크립트 충돌 확인:**
- 많은 사용자 스크립트를 설치했다면, 다른 스크립트를 일시적으로 비활성화해보세요.
- 일부 스크립트는 Lianki의 떠다니는 버튼과 충돌할 수 있습니다.

### "인증되지 않음" 오류 발생

이는 Lianki에 로그인하지 않았음을 의미합니다.

**해결 방법:**
1. 새 탭에서 [https://www.lianki.com](https://www.lianki.com)를 엽니다.
2. 계정으로 로그인하세요(이메일, GitHub 또는 Google).
3. 카드를 추가하려는 페이지로 돌아갑니다.
4. **Alt+F**를 다시 누릅니다 — 이제 작동할 것입니다.

사용자 스크립트는 쿠키를 사용하여 인증하므로, 브라우저가 `lianki.com`의 쿠키를 허용하는지 확인하세요.

### 업데이트가 작동하지 않음

**수동 업데이트 확인:**
1. 사용자 스크립트 관리자 대시보드를 엽니다.
2. "Lianki" 스크립트를 찾습니다.
3. "업데이트 확인" 버튼이나 옵션을 찾습니다.
4. 클릭하여 새 버전을 수동으로 확인합니다.

사용자 스크립트 관리자는 일반적으로 24시간마다 자동으로 업데이트를 확인합니다. Greasy Fork에서 설치한 경우, 업데이트가 더 빨리 감지됩니다.

---

## Lianki 사용하기

이제 Lianki가 설치되었으므로, 사용하는 방법은 다음과 같습니다:

### 카드 추가하기

1. 기억하고 싶은 웹페이지를 방문합니다.
2. **Alt+F**를 누르거나 떠다니는 버튼을 클릭합니다.
3. 제목과 URL이 자동으로 채워집니다.
4. **추가**를 클릭하여 리뷰 대기열에 카드를 저장합니다.

### 카드 리뷰하기

카드가 리뷰할 때가 되면:
1. 카드의 URL을 방문하거나 Lianki가 자동으로 리디렉션합니다.
2. 떠다니는 버튼이 리뷰가 필요함을 나타내기 위해 **빛납니다**.
3. 클릭하여 리뷰 대화 상자를 엽니다.
4. 기억 정도를 평가합니다: **다시**(1), **어려움**(2), **좋음**(3), **쉬움**(4)
5. 키보드 단축키 사용: `1/D/L`, `2/W/K`, `3/S/J`, `4/A/H`

대화 상자는 각 평가에 대한 다음 리뷰 간격을 보여주므로 콘텐츠를 얼마나 잘 기억하는지에 따라 선택할 수 있습니다.

### 키보드 단축키

- **Alt+F** — Lianki 대화 상자 열기 (추가 또는 리뷰)
- **1, D, L** — "다시"로 평가(잊음)
- **2, W, K** — "어려움"으로 평가(간신히 기억)
- **3, S, J** — "좋음"으로 평가(잘 기억함)
- **4, A, H** — "쉬움"으로 평가(기억하기 쉬움)

단축키는 WASD와 HJKL 레이아웃 모두를 지원하며, 숫자 키패드 1-4도 지원합니다.

---

## 다음 단계

- **알고리즘 작동 방식 배우기**: [FSRS 알고리즘 이해하기](/blog/2025-01-15-fsrs-algorithm)
- **사용자 스크립트 자세히 알아보기**: [Lianki 사용자 스크립트 작동 방식](/blog/2025-02-10-userscript)
- **리뷰 대기열 확인하기**: [lianki.com/list](https://www.lianki.com/list)

---

## 왜 이런 추천을 했나요?

### 왜 ScriptCat을 추천하나요?

- **개인정보 보호 중심**: 기본적으로 원격 측정이나 추적 없음
- **최신 코드베이스**: 적극적으로 개발되고 있으며 Chrome/Edge 지원이 훌륭함
- **빠름**: 많은 스크립트를 실행하기 위한 성능 최적화
- **좋은 기본 설정**: 별도의 설정 없이도 잘 작동함

### 왜 Violentmonkey를 Tampermonkey보다 추천하나요?

- **오픈 소스**: 완전히 투명하며 커뮤니티 점검된 코드
- **원격 측정 없음**: 외부 서버에 데이터를 보내지 않음
- **경량**: Tampermonkey보다 메모리 사용량이 적음
- **개인정보 중심**: 사용자 개인정보 보호를 핵심 원칙으로 설계됨

### Tampermonkey가 여전히 유용한 이유

- **가장 많은 사용자 기반**: 가장 인기 있는 사용자 스크립트 관리자
- **성숙하고 안정적**: 가장 오래 운영됨
- **풍부한 기능**: 고급 설정 및 디버깅 도구를 제공
- **광범위한 호환성**: 모든 주요 브라우저에서 작동

개인정보와 관련된 타협점은 Tampermonkey가 일부 원격 측정(업데이트 확인, 사용 통계)을 포함한다는 것입니다. 대부분의 사용자에게는 큰 문제가 아니지만, 개인정보가 중요하다면 ScriptCat 또는 Violentmonkey를 선택하세요.

---

## 요약

1. **사용자 스크립트 관리자 설치**: ScriptCat(추천) 또는 Violentmonkey 또는 Tampermonkey
2. **Lianki 사용자 스크립트 설치**: [greasyfork.org/ja/scripts/567089-lianki](https://greasyfork.org/ja/scripts/567089-lianki)
3. **작동 확인**: 모든 HTTPS 페이지에서 떠다니는 버튼을 찾습니다.
4. **학습 시작**: Alt+F를 눌러 첫 번째 카드를 추가하세요!

이제 각 페이지에서 기억하고 싶은 내용을 키보드 단축키 한 번으로 Lianki를 사용한 간격 반복 학습에 활용할 수 있습니다.
```