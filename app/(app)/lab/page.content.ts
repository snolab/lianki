import { t, type DeclarationContent } from "intlayer";

const labPageContent = {
  key: "lab-page",
  content: {
    metadata: {
      title: t({
        en: "Lab - Lianki",
        zh: "实验室 - Lianki",
        ja: "ラボ - Lianki",
        ko: "랩 - Lianki",
        fr: "Labo - Lianki",
        es: "Laboratorio - Lianki",
        de: "Labor - Lianki",
      }),
      description: t({
        en: "Experiments from the Lianki workshop — tools for language immersion that haven't graduated into the main app yet.",
        zh: "Lianki 工作坊里的实验——尚未进入主应用的语言沉浸工具。",
        ja: "Lianki の実験場 — まだ本体に入っていない言語イマージョンのためのツール。",
        ko: "Lianki 실험실 — 아직 본 앱에 들어가지 않은 언어 몰입 도구들.",
        fr: "Les expériences de l'atelier Lianki — des outils d'immersion linguistique pas encore intégrés à l'application.",
        es: "Experimentos del taller de Lianki: herramientas de inmersión lingüística que aún no han pasado a la app principal.",
        de: "Experimente aus der Lianki-Werkstatt — Werkzeuge für Sprachimmersion, die es noch nicht in die Haupt-App geschafft haben.",
      }),
    },
    heading: t({
      en: "Lab",
      zh: "实验室",
      ja: "ラボ",
      ko: "랩",
      fr: "Labo",
      es: "Laboratorio",
      de: "Labor",
    }),
    intro: t({
      en: "Things we are trying. They work, but they may change shape or disappear.",
      zh: "我们正在尝试的东西。可以用，但形态可能会变，也可能会消失。",
      ja: "試しているもの。動きますが、形が変わったり消えたりするかもしれません。",
      ko: "시도해 보고 있는 것들. 동작하지만 모양이 바뀌거나 사라질 수 있습니다.",
      fr: "Ce que nous essayons. Ça marche, mais ça peut changer de forme ou disparaître.",
      es: "Cosas que estamos probando. Funcionan, pero pueden cambiar de forma o desaparecer.",
      de: "Dinge, die wir ausprobieren. Sie funktionieren, können aber ihre Form ändern oder verschwinden.",
    }),
    experiments: {
      immersion: {
        title: t({
          en: "Immersion Web Matrix",
          zh: "沉浸式网站矩阵",
          ja: "イマージョン Web マトリックス",
          ko: "몰입 웹 매트릭스",
          fr: "Matrice web d'immersion",
          es: "Matriz web de inmersión",
          de: "Immersions-Web-Matrix",
        }),
        blurb: t({
          en: "Desktop websites for reading native Chinese, Japanese, English, French, Korean, Spanish, German and Finnish — one per topic, so you can pick the register you want to learn and start clipping cards.",
          zh: "阅读母语级中文、日语、英语、法语、韩语、西班牙语、德语和芬兰语的桌面网站——每个主题一个，选好想学的语域，就能开始剪卡片。",
          ja: "中国語・日本語・英語・フランス語・韓国語・スペイン語・ドイツ語・フィンランド語をネイティブの文章で読めるデスクトップサイト。トピックごとに一つずつ、学びたい文体を選んでカードを切り出せます。",
          ko: "중국어·일본어·영어·프랑스어·한국어·스페인어·독일어·핀란드어를 원어민 글로 읽을 수 있는 데스크톱 사이트. 주제별로 하나씩, 배우고 싶은 문체를 골라 카드를 만드세요.",
          fr: "Des sites web de bureau pour lire du chinois, japonais, anglais, français, coréen, espagnol, allemand et finnois natifs — un par sujet, pour choisir le registre à apprendre et commencer à découper des cartes.",
          es: "Sitios web de escritorio para leer chino, japonés, inglés, francés, coreano, español, alemán y finés nativos: uno por tema, para elegir el registro que quieres aprender y empezar a recortar tarjetas.",
          de: "Desktop-Websites zum Lesen von nativem Chinesisch, Japanisch, Englisch, Französisch, Koreanisch, Spanisch, Deutsch und Finnisch — eine pro Thema, damit du das Register wählst, das du lernen willst, und Karten ausschneidest.",
        }),
      },
      swipe: {
        title: t({
          en: "New swipe",
          zh: "新的滑动",
          ja: "新しいスワイプ",
          ko: "새 스와이프",
          fr: "Nouveau glissement",
          es: "Nuevo deslizamiento",
          de: "Neues Wischen",
        }),
        blurb: t({
          en: "Grade words on your phone by swiping, with the browser's own scrolling doing the work: it snaps to each grade and glides like any native list. Same slips, same grades as today's swipe.",
          zh: "在手机上滑动给单词打分，由浏览器自己的滚动来完成：每一档都会吸附，滑起来和原生列表一样顺。竹简和评分都和现在的滑动相同。",
          ja: "スマホでスワイプして単語を評価。動きはブラウザ自身のスクロールに任せるので、各段階にぴたりと止まり、ネイティブのリストのように滑ります。竹簡も評価も今のスワイプと同じです。",
          ko: "휴대폰에서 스와이프로 단어를 평가합니다. 움직임은 브라우저 자체 스크롤이 맡아 각 등급에 딱 맞춰 멈추고 네이티브 목록처럼 미끄러집니다. 죽간과 평가는 지금의 스와이프와 같습니다.",
          fr: "Notez les mots sur téléphone en glissant, avec le défilement natif du navigateur : il s'aimante à chaque note et glisse comme une liste native. Mêmes lamelles, mêmes notes que le glissement actuel.",
          es: "Califica palabras en el móvil deslizando, con el propio desplazamiento del navegador: se ajusta a cada nota y se desliza como una lista nativa. Las mismas tiras y notas que el deslizamiento actual.",
          de: "Bewerte Wörter auf dem Handy per Wischen, mit dem browsereigenen Scrollen: Es rastet bei jeder Note ein und gleitet wie eine native Liste. Gleiche Streifen, gleiche Noten wie beim heutigen Wischen.",
        }),
        howTo: t({
          en: "Turn it on in /words → Settings → Experimental",
          zh: "在 /words → Settings → Experimental 里打开",
          ja: "/words → Settings → Experimental でオンに",
          ko: "/words → Settings → Experimental 에서 켜기",
          fr: "À activer dans /words → Settings → Experimental",
          es: "Actívalo en /words → Settings → Experimental",
          de: "Einschalten unter /words → Settings → Experimental",
        }),
      },
    },
  },
} satisfies DeclarationContent;

export default labPageContent;
