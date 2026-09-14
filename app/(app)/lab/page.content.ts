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
    },
  },
} satisfies DeclarationContent;

export default labPageContent;
