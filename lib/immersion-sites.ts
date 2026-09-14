/**
 * Immersion web matrix — desktop websites a learner can read in the browser,
 * one per (domain × language), so the userscript can turn what they read into
 * cards. Rendered by /lab/immersion.
 *
 * Selection rules, so the table stays useful rather than merely long:
 *   - desktop web first: the site must be readable at a plain URL without an
 *     app, and ideally without an account;
 *   - native, not translated: the audience writes in that language, so the
 *     register (slang, formal, imperative) is real;
 *   - one primary per cell, at most one alternative. A cell with three names
 *     is a search result, not a recommendation.
 *
 * Labels stay English on purpose — the matrix is a lab page and the site names
 * are already in their own script; translating 24 domain rows × 16 locales
 * would cost more than it says.
 */

export const IMMERSION_LANGUAGES = [
  { code: "zh", name: "Chinese", native: "中文" },
  { code: "ja", name: "Japanese", native: "日本語" },
  { code: "en", name: "English", native: "English" },
  { code: "fr", name: "French", native: "Français" },
  { code: "ko", name: "Korean", native: "한국어" },
  { code: "es", name: "Spanish", native: "Español" },
  { code: "de", name: "German", native: "Deutsch" },
  { code: "fi", name: "Finnish", native: "Suomi" },
] as const;

export type ImmersionLanguage = (typeof IMMERSION_LANGUAGES)[number]["code"];

/** What kind of language a learner meets there — the point of picking a domain. */
export type Register = "formal" | "casual" | "slang" | "technical" | "imperative" | "spoken";

export type ImmersionSite = {
  name: string;
  url: string;
  /** One clause on why this one and not the obvious alternative. */
  note?: string;
};

export type ImmersionDomain = {
  key: string;
  title: string;
  /** What you practise by reading here. */
  blurb: string;
  registers: Register[];
  sites: Record<ImmersionLanguage, { primary: ImmersionSite; alt?: ImmersionSite }>;
};

const s = (name: string, url: string, note?: string): ImmersionSite =>
  note ? { name, url, note } : { name, url };

export const IMMERSION_DOMAINS: ImmersionDomain[] = [
  {
    key: "qa",
    title: "Q&A & Knowledge",
    blurb: "Structured answers and reasoning",
    registers: ["formal", "casual"],
    sites: {
      zh: { primary: s("知乎", "https://www.zhihu.com") },
      ja: { primary: s("Yahoo!知恵袋", "https://chiebukuro.yahoo.co.jp") },
      en: {
        primary: s("Quora", "https://www.quora.com"),
        alt: s("Stack Exchange", "https://stackexchange.com", "tighter, more technical answers"),
      },
      fr: { primary: s("Quora (fr)", "https://fr.quora.com") },
      ko: { primary: s("네이버 지식iN", "https://kin.naver.com") },
      es: { primary: s("Quora (es)", "https://es.quora.com") },
      de: { primary: s("gutefrage", "https://www.gutefrage.net") },
      fi: {
        primary: s(
          "Kysy kirjastonhoitajalta",
          "https://www.kirjastot.fi/kysy",
          "librarians answer anything, in careful prose",
        ),
        alt: s("Reddit r/Suomi", "https://www.reddit.com/r/Suomi/"),
      },
    },
  },
  {
    key: "community",
    title: "Community & Forums",
    blurb: "Discussions, slang and net culture",
    registers: ["casual", "slang"],
    sites: {
      zh: {
        primary: s("豆瓣", "https://www.douban.com"),
        alt: s("百度贴吧", "https://tieba.baidu.com", "rougher, more slang"),
      },
      ja: {
        primary: s("5ちゃんねる", "https://5ch.net", "the source of most Japanese net slang"),
        alt: s("ガールズちゃんねる", "https://girlschannel.net"),
      },
      en: { primary: s("Reddit", "https://www.reddit.com") },
      fr: {
        primary: s("Reddit r/france", "https://www.reddit.com/r/france/"),
        alt: s(
          "jeuxvideo.com forums",
          "https://www.jeuxvideo.com/forums/",
          "the 18-25 forum is French net culture",
        ),
      },
      ko: {
        primary: s("디시인사이드", "https://www.dcinside.com"),
        alt: s("클리앙", "https://www.clien.net", "calmer, tech-leaning"),
      },
      es: {
        primary: s("Reddit r/espanol", "https://www.reddit.com/r/espanol/"),
        alt: s("Forocoches", "https://www.forocoches.com"),
      },
      de: { primary: s("Reddit r/de", "https://www.reddit.com/r/de/") },
      fi: {
        primary: s("Suomi24", "https://www.suomi24.fi"),
        alt: s(
          "Ylilauta",
          "https://ylilauta.org",
          "imageboard; Finnish net slang at full strength",
        ),
      },
    },
  },
  {
    key: "tech",
    title: "Tech & Development",
    blurb: "Engineering tips and tutorials",
    registers: ["technical"],
    sites: {
      zh: {
        primary: s("掘金", "https://juejin.cn"),
        alt: s("SegmentFault", "https://segmentfault.com"),
      },
      ja: {
        primary: s("Qiita", "https://qiita.com"),
        alt: s("Zenn", "https://zenn.dev"),
      },
      en: {
        primary: s("DEV Community", "https://dev.to"),
        alt: s("Hacker News", "https://news.ycombinator.com"),
      },
      fr: {
        primary: s("LinuxFr.org", "https://linuxfr.org"),
        alt: s("Journal du hacker", "https://www.journalduhacker.net"),
      },
      ko: {
        primary: s("velog", "https://velog.io"),
        alt: s("요즘IT", "https://yozm.wishket.com"),
      },
      es: {
        primary: s("Xataka", "https://www.xataka.com"),
        alt: s("DEV (#spanish)", "https://dev.to/t/spanish"),
      },
      de: {
        primary: s("heise online", "https://www.heise.de"),
        alt: s("Golem.de", "https://www.golem.de"),
      },
      fi: {
        primary: s("io-tech", "https://www.io-tech.fi"),
        alt: s("Muropaketti", "https://muropaketti.com"),
      },
    },
  },
  {
    key: "writing",
    title: "Independent Writing",
    blurb: "Essays, newsletters and long reads",
    registers: ["formal", "casual"],
    sites: {
      zh: {
        primary: s("知乎专栏", "https://zhuanlan.zhihu.com"),
        alt: s("少数派", "https://sspai.com", "well-edited, tech and life"),
      },
      ja: { primary: s("note", "https://note.com") },
      en: {
        primary: s("Substack", "https://substack.com"),
        alt: s("Medium", "https://medium.com"),
      },
      fr: {
        primary: s("Kessel", "https://www.kessel.media", "French newsletter platform"),
        alt: s("Le Grand Continent", "https://legrandcontinent.eu"),
      },
      ko: { primary: s("브런치스토리", "https://brunch.co.kr") },
      es: {
        primary: s("Jot Down", "https://www.jotdown.es"),
        alt: s("Substack (es)", "https://substack.com"),
      },
      de: {
        primary: s("Krautreporter", "https://krautreporter.de"),
        alt: s("Perlentaucher", "https://www.perlentaucher.de"),
      },
      fi: {
        primary: s("Long Play", "https://longplay.fi", "long-form journalism"),
        alt: s("Rapport", "https://www.rapport.fi"),
      },
    },
  },
  {
    key: "video",
    title: "Video Platforms",
    blurb: "Cultural video and streaming — comments and subtitles",
    registers: ["spoken", "slang"],
    sites: {
      zh: { primary: s("哔哩哔哩", "https://www.bilibili.com") },
      ja: {
        primary: s("ニコニコ動画", "https://www.nicovideo.jp"),
        alt: s("ABEMA", "https://abema.tv"),
      },
      en: {
        primary: s("YouTube", "https://www.youtube.com"),
        alt: s("TED", "https://www.ted.com", "every talk has a transcript"),
      },
      fr: {
        primary: s("ARTE", "https://www.arte.tv/fr/"),
        alt: s("france.tv", "https://www.france.tv"),
      },
      ko: {
        primary: s("네이버 TV", "https://tv.naver.com"),
        alt: s("카카오TV", "https://tv.kakao.com"),
      },
      es: { primary: s("RTVE Play", "https://www.rtve.es/play/") },
      de: {
        primary: s("ZDFmediathek", "https://www.zdf.de"),
        alt: s("ARD Mediathek", "https://www.ardmediathek.de"),
      },
      fi: {
        primary: s("Yle Areena", "https://areena.yle.fi"),
        alt: s("Ruutu", "https://www.ruutu.fi"),
      },
    },
  },
  {
    key: "audio",
    title: "Audio & Podcasts",
    blurb: "Native speech and talk radio",
    registers: ["spoken"],
    sites: {
      zh: { primary: s("小宇宙", "https://www.xiaoyuzhoufm.com") },
      ja: {
        primary: s("Voicy", "https://voicy.jp"),
        alt: s("NHK らじる★らじる", "https://www.nhk.or.jp/radio/"),
      },
      en: {
        primary: s("NPR Podcasts", "https://www.npr.org/podcasts/"),
        alt: s("BBC Sounds", "https://www.bbc.co.uk/sounds", "some shows are UK-only"),
      },
      fr: { primary: s("Radio France", "https://www.radiofrance.fr/podcasts") },
      ko: {
        primary: s("팟빵", "https://www.podbbang.com"),
        alt: s("네이버 오디오클립", "https://audioclip.naver.com"),
      },
      es: {
        primary: s("iVoox", "https://www.ivoox.com"),
        alt: s("RTVE Audio", "https://www.rtve.es/play/audios/"),
      },
      de: {
        primary: s("ARD Audiothek", "https://www.ardaudiothek.de"),
        alt: s("Deutschlandfunk", "https://www.deutschlandfunk.de"),
      },
      fi: {
        primary: s("Yle Areena podcastit", "https://areena.yle.fi/podcastit"),
        alt: s("Supla", "https://www.supla.fi"),
      },
    },
  },
  {
    key: "lifestyle",
    title: "Lifestyle & Reviews",
    blurb: "Living, dining and consumer notes",
    registers: ["casual"],
    sites: {
      zh: {
        primary: s("小红书", "https://www.xiaohongshu.com/explore"),
        alt: s("大众点评", "https://www.dianping.com"),
      },
      ja: {
        primary: s("食べログ", "https://tabelog.com"),
        alt: s("@cosme", "https://www.cosme.net"),
      },
      en: {
        primary: s("Yelp", "https://www.yelp.com"),
        alt: s("Reddit r/food", "https://www.reddit.com/r/food/"),
      },
      fr: {
        primary: s("TripAdvisor (fr)", "https://www.tripadvisor.fr"),
        alt: s("Le Fooding", "https://lefooding.com"),
      },
      ko: {
        primary: s("네이버 블로그", "https://section.blog.naver.com"),
        alt: s("망고플레이트", "https://www.mangoplate.com"),
      },
      es: {
        primary: s("TripAdvisor (es)", "https://www.tripadvisor.es"),
        alt: s("TheFork", "https://www.thefork.es"),
      },
      de: {
        primary: s("TripAdvisor (de)", "https://www.tripadvisor.de"),
        alt: s("Yelp (de)", "https://www.yelp.de"),
      },
      fi: {
        primary: s(
          "Vauva.fi keskustelu",
          "https://www.vauva.fi/keskustelu",
          "the forum outgrew its parenting roots long ago",
        ),
        alt: s("Eat.fi", "https://eat.fi"),
      },
    },
  },
  {
    key: "books",
    title: "Books & Literature",
    blurb: "Reader critiques and book logs",
    registers: ["formal", "casual"],
    sites: {
      zh: { primary: s("豆瓣读书", "https://book.douban.com") },
      ja: {
        primary: s("読書メーター", "https://bookmeter.com"),
        alt: s("ブクログ", "https://booklog.jp"),
      },
      en: {
        primary: s("Goodreads", "https://www.goodreads.com"),
        alt: s("The StoryGraph", "https://app.thestorygraph.com"),
      },
      fr: {
        primary: s("Babelio", "https://www.babelio.com"),
        alt: s("SensCritique Livres", "https://www.senscritique.com/livres"),
      },
      ko: {
        primary: s(
          "알라딘",
          "https://www.aladin.co.kr",
          "shop, but the reader reviews are the draw",
        ),
        alt: s("예스24", "https://www.yes24.com"),
      },
      es: {
        primary: s("Lecturalia", "https://www.lecturalia.com"),
        alt: s("Goodreads (es)", "https://www.goodreads.com"),
      },
      de: {
        primary: s("LovelyBooks", "https://www.lovelybooks.de"),
        alt: s("Perlentaucher Bücher", "https://www.perlentaucher.de/buch.html"),
      },
      fi: {
        primary: s("Kirjasampo", "https://www.kirjasampo.fi"),
        alt: s("Kirjavinkit", "https://www.kirjavinkit.fi"),
      },
    },
  },
  {
    key: "film",
    title: "Film & Media Critiques",
    blurb: "Movie reviews and synopses",
    registers: ["formal", "casual"],
    sites: {
      zh: { primary: s("豆瓣电影", "https://movie.douban.com") },
      ja: {
        primary: s("Filmarks", "https://filmarks.com"),
        alt: s("映画.com", "https://eiga.com"),
      },
      en: {
        primary: s("Letterboxd", "https://letterboxd.com"),
        alt: s("Rotten Tomatoes", "https://www.rottentomatoes.com"),
      },
      fr: {
        primary: s("SensCritique", "https://www.senscritique.com"),
        alt: s("AlloCiné", "https://www.allocine.fr"),
      },
      ko: {
        primary: s("왓챠피디아", "https://pedia.watcha.com"),
        alt: s("씨네21", "https://www.cine21.com"),
      },
      es: {
        primary: s(
          "FilmAffinity",
          "https://www.filmaffinity.com/es/",
          "Spanish-born; the reviews are native",
        ),
        alt: s("Fotogramas", "https://www.fotogramas.es"),
      },
      de: {
        primary: s("Moviepilot", "https://www.moviepilot.de"),
        alt: s("FILMSTARTS", "https://www.filmstarts.de"),
      },
      fi: {
        primary: s("Leffatykki", "https://www.leffatykki.com"),
        alt: s("Episodi", "https://www.episodi.fi"),
      },
    },
  },
  {
    key: "c2c",
    title: "C2C & Classifieds",
    blurb: "Negotiation and everyday transactions",
    registers: ["casual", "spoken"],
    sites: {
      zh: {
        primary: s("闲鱼", "https://www.goofish.com"),
        alt: s("58同城", "https://www.58.com"),
      },
      ja: {
        primary: s("メルカリ", "https://jp.mercari.com"),
        alt: s("ジモティー", "https://jmty.jp"),
      },
      en: {
        primary: s("Craigslist", "https://www.craigslist.org"),
        alt: s("eBay", "https://www.ebay.com"),
      },
      fr: {
        primary: s("Leboncoin", "https://www.leboncoin.fr"),
        alt: s("Vinted (fr)", "https://www.vinted.fr"),
      },
      ko: {
        primary: s("당근", "https://www.daangn.com"),
        alt: s("중고나라", "https://web.joongna.com"),
      },
      es: {
        primary: s("Wallapop", "https://es.wallapop.com"),
        alt: s("Milanuncios", "https://www.milanuncios.com"),
      },
      de: {
        primary: s("Kleinanzeigen", "https://www.kleinanzeigen.de"),
        alt: s("Vinted (de)", "https://www.vinted.de"),
      },
      fi: {
        primary: s("Tori.fi", "https://www.tori.fi"),
        alt: s("Huuto.net", "https://www.huuto.net"),
      },
    },
  },
  {
    key: "cooking",
    title: "Cooking & Recipes",
    blurb: "Step-by-step recipes and imperatives",
    registers: ["imperative"],
    sites: {
      zh: { primary: s("下厨房", "https://www.xiachufang.com") },
      ja: {
        primary: s("クックパッド", "https://cookpad.com"),
        alt: s("クラシル", "https://www.kurashiru.com"),
      },
      en: {
        primary: s("Allrecipes", "https://www.allrecipes.com"),
        alt: s("Reddit r/recipes", "https://www.reddit.com/r/recipes/"),
      },
      fr: {
        primary: s("Marmiton", "https://www.marmiton.org"),
        alt: s("750g", "https://www.750g.com"),
      },
      ko: {
        primary: s("만개의레시피", "https://www.10000recipe.com"),
        alt: s("해먹남녀", "https://haemukja.com"),
      },
      es: {
        primary: s("Directo al Paladar", "https://www.directoalpaladar.com"),
        alt: s("RecetasGratis", "https://www.recetasgratis.net"),
      },
      de: {
        primary: s("Chefkoch", "https://www.chefkoch.de"),
        alt: s("kochbar", "https://www.kochbar.de"),
      },
      fi: {
        primary: s("Kotikokki", "https://www.kotikokki.net"),
        alt: s("K-Ruoka reseptit", "https://www.k-ruoka.fi/reseptit"),
      },
    },
  },
  {
    key: "news",
    title: "News & Current Affairs",
    blurb: "The formal written register, updated daily",
    registers: ["formal"],
    sites: {
      zh: {
        primary: s("澎湃新闻", "https://www.thepaper.cn"),
        alt: s("新华网", "https://www.news.cn"),
      },
      ja: {
        primary: s("NHK NEWS WEB", "https://www3.nhk.or.jp/news/"),
        alt: s(
          "NEWS WEB EASY",
          "https://www3.nhk.or.jp/news/easy/",
          "same stories, simplified with furigana",
        ),
      },
      en: {
        primary: s("BBC News", "https://www.bbc.com/news"),
        alt: s("The Guardian", "https://www.theguardian.com"),
      },
      fr: {
        primary: s("Le Monde", "https://www.lemonde.fr"),
        alt: s("franceinfo", "https://www.francetvinfo.fr"),
      },
      ko: {
        primary: s("연합뉴스", "https://www.yna.co.kr"),
        alt: s("네이버 뉴스", "https://news.naver.com"),
      },
      es: {
        primary: s("El País", "https://elpais.com"),
        alt: s("RTVE Noticias", "https://www.rtve.es/noticias/"),
      },
      de: {
        primary: s("tagesschau.de", "https://www.tagesschau.de"),
        alt: s("DER SPIEGEL", "https://www.spiegel.de"),
      },
      fi: {
        primary: s("Yle Uutiset", "https://yle.fi/uutiset"),
        alt: s("Yle Selkouutiset", "https://yle.fi/selkouutiset", "the same news in plain Finnish"),
      },
    },
  },
  {
    key: "reference",
    title: "Encyclopedias & Dictionaries",
    blurb: "Definitions and neutral exposition",
    registers: ["formal"],
    sites: {
      zh: {
        primary: s("百度百科", "https://baike.baidu.com"),
        alt: s("中文维基百科", "https://zh.wikipedia.org"),
      },
      ja: {
        primary: s("Wikipedia (ja)", "https://ja.wikipedia.org"),
        alt: s(
          "ニコニコ大百科",
          "https://dic.nicovideo.jp",
          "net-culture terms Wikipedia won't have",
        ),
      },
      en: {
        primary: s("Wikipedia", "https://en.wikipedia.org"),
        alt: s("Wiktionary", "https://en.wiktionary.org"),
      },
      fr: {
        primary: s("Wikipédia", "https://fr.wikipedia.org"),
        alt: s("Larousse", "https://www.larousse.fr/dictionnaires/francais"),
      },
      ko: {
        primary: s("나무위키", "https://namu.wiki"),
        alt: s("위키백과", "https://ko.wikipedia.org"),
      },
      es: {
        primary: s("Wikipedia (es)", "https://es.wikipedia.org"),
        alt: s("Diccionario RAE", "https://dle.rae.es"),
      },
      de: {
        primary: s("Wikipedia (de)", "https://de.wikipedia.org"),
        alt: s("Duden", "https://www.duden.de"),
      },
      fi: {
        primary: s("Wikipedia (fi)", "https://fi.wikipedia.org"),
        alt: s(
          "Kielitoimiston sanakirja",
          "https://www.kielitoimistonsanakirja.fi",
          "the official dictionary",
        ),
      },
    },
  },
  {
    key: "social",
    title: "Microblogs & Feeds",
    blurb: "Short posts, replies, memes — the fastest slang",
    registers: ["slang", "casual"],
    sites: {
      zh: { primary: s("微博", "https://weibo.com") },
      ja: {
        primary: s("X", "https://x.com"),
        alt: s("Misskey.io", "https://misskey.io", "Japanese-born fediverse"),
      },
      en: {
        primary: s("X", "https://x.com"),
        alt: s("Bluesky", "https://bsky.app"),
      },
      fr: {
        primary: s("X", "https://x.com"),
        alt: s("Piaille", "https://piaille.fr", "French Mastodon instance"),
      },
      ko: {
        primary: s("더쿠", "https://theqoo.net"),
        alt: s("X", "https://x.com"),
      },
      es: {
        primary: s("Menéame", "https://www.meneame.net"),
        alt: s("X", "https://x.com"),
      },
      de: { primary: s("X", "https://x.com") },
      fi: { primary: s("X", "https://x.com") },
    },
  },
  {
    key: "music",
    title: "Music & Lyrics",
    blurb: "Lyrics with a comment section under them",
    registers: ["spoken", "casual"],
    sites: {
      zh: {
        primary: s(
          "网易云音乐",
          "https://music.163.com",
          "the comment threads are a genre of their own",
        ),
        alt: s("QQ音乐", "https://y.qq.com"),
      },
      ja: {
        primary: s("歌ネット", "https://www.uta-net.com"),
        alt: s("J-Lyric", "https://j-lyric.net"),
      },
      en: {
        primary: s("Genius", "https://genius.com"),
        alt: s("Bandcamp", "https://bandcamp.com"),
      },
      fr: {
        primary: s("Paroles.net", "https://www.paroles.net"),
        alt: s("La Coccinelle", "https://www.lacoccinelle.net", "lyric translations"),
      },
      ko: {
        primary: s("멜론", "https://www.melon.com"),
        alt: s("벅스", "https://music.bugs.co.kr"),
      },
      es: {
        primary: s("Letras", "https://www.letras.com"),
        alt: s("Musica.com", "https://www.musica.com"),
      },
      de: {
        primary: s("Songtexte.com", "https://www.songtexte.com"),
        alt: s("laut.de", "https://www.laut.de", "reviews, not lyrics"),
      },
      fi: {
        primary: s("Soundi", "https://www.soundi.fi", "reviews and interviews, not lyrics"),
        alt: s("Rumba", "https://www.rumba.fi"),
      },
    },
  },
  {
    key: "fiction",
    title: "Comics & Web Fiction",
    blurb: "Serialised stories — dialogue-heavy, one chapter a day",
    registers: ["spoken", "casual"],
    sites: {
      zh: {
        primary: s("起点中文网", "https://www.qidian.com"),
        alt: s("快看漫画", "https://www.kuaikanmanhua.com"),
      },
      ja: {
        primary: s("小説家になろう", "https://syosetu.com"),
        alt: s("少年ジャンプ＋", "https://shonenjumpplus.com"),
      },
      en: {
        primary: s("WEBTOON", "https://www.webtoons.com/en/"),
        alt: s("Royal Road", "https://www.royalroad.com"),
      },
      fr: {
        primary: s("WEBTOON (fr)", "https://www.webtoons.com/fr/"),
        alt: s("Bedetheque", "https://www.bedetheque.com", "BD database and reviews"),
      },
      ko: {
        primary: s("네이버 웹툰", "https://comic.naver.com"),
        alt: s("문피아", "https://www.munpia.com", "web novels"),
      },
      es: {
        primary: s("WEBTOON (es)", "https://www.webtoons.com/es/"),
        alt: s("Tebeosfera", "https://www.tebeosfera.com"),
      },
      de: {
        primary: s("WEBTOON (de)", "https://www.webtoons.com/de/"),
        alt: s("Comic.de", "https://comic.de"),
      },
      fi: {
        primary: s(
          "Fingerpori",
          "https://www.hs.fi/fingerpori/",
          "a daily strip built on Finnish wordplay",
        ),
        alt: s("Kvaak.fi", "https://www.kvaak.fi", "comics community"),
      },
    },
  },
  {
    key: "games",
    title: "Games & Hobbies",
    blurb: "Reviews, guides and fan talk",
    registers: ["casual", "slang"],
    sites: {
      zh: {
        primary: s("机核", "https://www.gcores.com"),
        alt: s("NGA", "https://bbs.nga.cn"),
      },
      ja: {
        primary: s("ファミ通.com", "https://www.famitsu.com"),
        alt: s("4Gamer", "https://www.4gamer.net"),
      },
      en: {
        primary: s("IGN", "https://www.ign.com"),
        alt: s("Steam Community", "https://steamcommunity.com"),
      },
      fr: {
        primary: s("jeuxvideo.com", "https://www.jeuxvideo.com"),
        alt: s("Gamekult", "https://www.gamekult.com"),
      },
      ko: {
        primary: s("인벤", "https://www.inven.co.kr"),
        alt: s("루리웹", "https://bbs.ruliweb.com"),
      },
      es: {
        primary: s("Vandal", "https://vandal.elespanol.com"),
        alt: s("3DJuegos", "https://www.3djuegos.com"),
      },
      de: {
        primary: s("GameStar", "https://www.gamestar.de"),
        alt: s("PC Games", "https://www.pcgames.de"),
      },
      fi: {
        primary: s("Pelaaja", "https://www.pelaajalehti.com"),
        alt: s("V2.fi", "https://www.v2.fi"),
      },
    },
  },
  {
    key: "travel",
    title: "Travel & Places",
    blurb: "Trip reports, itineraries, local tips",
    registers: ["casual"],
    sites: {
      zh: {
        primary: s("马蜂窝", "https://www.mafengwo.cn"),
        alt: s("携程攻略", "https://you.ctrip.com"),
      },
      ja: {
        primary: s("4travel", "https://4travel.jp"),
        alt: s("じゃらんnet", "https://www.jalan.net"),
      },
      en: {
        primary: s("Lonely Planet", "https://www.lonelyplanet.com"),
        alt: s("Atlas Obscura", "https://www.atlasobscura.com"),
      },
      fr: {
        primary: s("Routard", "https://www.routard.com"),
        alt: s("Petit Futé", "https://www.petitfute.com"),
      },
      ko: {
        primary: s("마이리얼트립", "https://www.myrealtrip.com"),
        alt: s("트리플", "https://triple.guide"),
      },
      es: {
        primary: s("minube", "https://www.minube.com"),
        alt: s("Los Viajeros", "https://www.losviajeros.com"),
      },
      de: {
        primary: s("GEO Reisen", "https://www.geo.de/reisen"),
        alt: s("komoot", "https://www.komoot.com/de", "hiking and cycling routes"),
      },
      fi: {
        primary: s("Rantapallo", "https://www.rantapallo.fi"),
        alt: s("Retkipaikka", "https://retkipaikka.fi", "hiking and the outdoors"),
      },
    },
  },
  {
    key: "jobs",
    title: "Jobs & Careers",
    blurb: "Business register: postings, company reviews, workplace talk",
    registers: ["formal"],
    sites: {
      zh: {
        primary: s("BOSS直聘", "https://www.zhipin.com"),
        alt: s("脉脉", "https://maimai.cn"),
      },
      ja: {
        primary: s("OpenWork", "https://www.openwork.jp"),
        alt: s("リクナビNEXT", "https://next.rikunabi.com"),
      },
      en: {
        primary: s("LinkedIn", "https://www.linkedin.com"),
        alt: s("Glassdoor", "https://www.glassdoor.com"),
      },
      fr: {
        primary: s("Welcome to the Jungle", "https://www.welcometothejungle.com/fr"),
        alt: s("Apec", "https://www.apec.fr"),
      },
      ko: {
        primary: s("사람인", "https://www.saramin.co.kr"),
        alt: s("잡플래닛", "https://www.jobplanet.co.kr"),
      },
      es: {
        primary: s("InfoJobs", "https://www.infojobs.net"),
        alt: s("LinkedIn (es)", "https://es.linkedin.com"),
      },
      de: {
        primary: s("StepStone", "https://www.stepstone.de"),
        alt: s("kununu", "https://www.kununu.com"),
      },
      fi: {
        primary: s("Duunitori", "https://duunitori.fi"),
        alt: s("Oikotie Työpaikat", "https://www.oikotie.fi/tyopaikat"),
      },
    },
  },
  {
    key: "shopping",
    title: "Shopping & Product Reviews",
    blurb: "Specs, comparisons and deal-hunting",
    registers: ["casual", "technical"],
    sites: {
      zh: {
        primary: s("什么值得买", "https://www.smzdm.com"),
        alt: s("京东", "https://www.jd.com"),
      },
      ja: {
        primary: s("価格.com", "https://kakaku.com"),
        alt: s("Amazon.co.jp", "https://www.amazon.co.jp"),
      },
      en: {
        primary: s("Wirecutter", "https://www.nytimes.com/wirecutter/"),
        alt: s("Amazon", "https://www.amazon.com"),
      },
      fr: {
        primary: s("Les Numériques", "https://www.lesnumeriques.com"),
        alt: s("Que Choisir", "https://www.quechoisir.org"),
      },
      ko: {
        primary: s("다나와", "https://www.danawa.com"),
        alt: s("뽐뿌", "https://www.ppomppu.co.kr", "deals community, heavy slang"),
      },
      es: {
        primary: s("OCU", "https://www.ocu.org"),
        alt: s("Chollometro", "https://www.chollometro.com"),
      },
      de: {
        primary: s("Stiftung Warentest", "https://www.test.de"),
        alt: s("mydealz", "https://www.mydealz.de"),
      },
      fi: {
        primary: s("Hintaseuranta", "https://hintaseuranta.fi"),
        alt: s("Hintaopas", "https://hintaopas.fi"),
      },
    },
  },
  {
    key: "finance",
    title: "Finance & Investing",
    blurb: "Numbers, jargon and market chatter",
    registers: ["formal", "technical"],
    sites: {
      zh: {
        primary: s("雪球", "https://xueqiu.com"),
        alt: s("东方财富股吧", "https://guba.eastmoney.com"),
      },
      ja: {
        primary: s("Yahoo!ファイナンス", "https://finance.yahoo.co.jp"),
        alt: s("株探", "https://kabutan.jp"),
      },
      en: {
        primary: s("Investopedia", "https://www.investopedia.com"),
        alt: s("Reddit r/personalfinance", "https://www.reddit.com/r/personalfinance/"),
      },
      fr: {
        primary: s("Boursorama", "https://www.boursorama.com"),
        alt: s("Les Echos", "https://www.lesechos.fr"),
      },
      ko: {
        primary: s("네이버 증권", "https://finance.naver.com"),
        alt: s("한국경제", "https://www.hankyung.com"),
      },
      es: {
        primary: s("Rankia", "https://www.rankia.com"),
        alt: s("Expansión", "https://www.expansion.com"),
      },
      de: {
        primary: s("finanzen.net", "https://www.finanzen.net"),
        alt: s("Finanztip", "https://www.finanztip.de"),
      },
      fi: {
        primary: s("Kauppalehti", "https://www.kauppalehti.fi"),
        alt: s("Inderes", "https://www.inderes.fi", "investor community and forum"),
      },
    },
  },
  {
    key: "science",
    title: "Science & Popular Science",
    blurb: "Clear explanation of hard things",
    registers: ["formal", "technical"],
    sites: {
      zh: {
        primary: s("果壳", "https://www.guokr.com"),
        alt: s("科普中国", "https://www.kepuchina.cn"),
      },
      ja: {
        primary: s("ナショナル ジオグラフィック日本版", "https://natgeo.nikkeibp.co.jp"),
        alt: s("サイエンスポータル", "https://scienceportal.jst.go.jp"),
      },
      en: {
        primary: s("Scientific American", "https://www.scientificamerican.com"),
        alt: s("Ars Technica", "https://arstechnica.com"),
      },
      fr: {
        primary: s("Futura", "https://www.futura-sciences.com"),
        alt: s("Science & Vie", "https://www.science-et-vie.com"),
      },
      ko: {
        primary: s("동아사이언스", "https://www.dongascience.com"),
        alt: s("사이언스타임즈", "https://www.sciencetimes.co.kr"),
      },
      es: {
        primary: s("Muy Interesante", "https://www.muyinteresante.com"),
        alt: s("Agencia SINC", "https://www.agenciasinc.es"),
      },
      de: {
        primary: s("Spektrum", "https://www.spektrum.de"),
        alt: s("scinexx", "https://www.scinexx.de"),
      },
      fi: {
        primary: s("Tiede", "https://www.tiede.fi"),
        alt: s("Tekniikka&Talous", "https://www.tekniikkatalous.fi"),
      },
    },
  },
  {
    key: "sports",
    title: "Sports",
    blurb: "Match reports and fan arguments",
    registers: ["casual", "slang"],
    sites: {
      zh: {
        primary: s("虎扑", "https://www.hupu.com"),
        alt: s("懂球帝", "https://www.dongqiudi.com"),
      },
      ja: {
        primary: s("スポーツナビ", "https://sports.yahoo.co.jp"),
        alt: s("Number Web", "https://number.bunshun.jp"),
      },
      en: {
        primary: s("ESPN", "https://www.espn.com"),
        alt: s("The Athletic", "https://www.nytimes.com/athletic/"),
      },
      fr: {
        primary: s("L'Équipe", "https://www.lequipe.fr"),
        alt: s("Eurosport (fr)", "https://www.eurosport.fr"),
      },
      ko: {
        primary: s("네이버 스포츠", "https://sports.naver.com"),
        alt: s("스포티비뉴스", "https://www.spotvnews.co.kr"),
      },
      es: {
        primary: s("Marca", "https://www.marca.com"),
        alt: s("AS", "https://as.com"),
      },
      de: {
        primary: s("kicker", "https://www.kicker.de"),
        alt: s("Sportschau", "https://www.sportschau.de"),
      },
      fi: {
        primary: s("Yle Urheilu", "https://yle.fi/urheilu"),
        alt: s("Jatkoaika", "https://www.jatkoaika.com", "hockey, and the arguments about it"),
      },
    },
  },
  {
    key: "civic",
    title: "Official & Civic",
    blurb: "Bureaucratic register: forms, notices, law",
    registers: ["formal"],
    sites: {
      zh: { primary: s("中国政府网", "https://www.gov.cn") },
      ja: {
        primary: s("e-Gov", "https://www.e-gov.go.jp"),
        alt: s("首相官邸", "https://www.kantei.go.jp"),
      },
      en: {
        primary: s("GOV.UK", "https://www.gov.uk"),
        alt: s("USA.gov", "https://www.usa.gov"),
      },
      fr: {
        primary: s("Service-Public.fr", "https://www.service-public.fr"),
        alt: s("Légifrance", "https://www.legifrance.gouv.fr"),
      },
      ko: {
        primary: s("정부24", "https://www.gov.kr"),
        alt: s("정책브리핑", "https://www.korea.kr"),
      },
      es: {
        primary: s("administración.gob.es", "https://administracion.gob.es"),
        alt: s("BOE", "https://www.boe.es"),
      },
      de: {
        primary: s("bund.de", "https://www.bund.de"),
        alt: s("Bundesregierung", "https://www.bundesregierung.de"),
      },
      fi: {
        primary: s("Suomi.fi", "https://www.suomi.fi"),
        alt: s("Finlex", "https://www.finlex.fi"),
      },
    },
  },
];

/** Every site in the matrix, flattened — for tests and for "is this host in the matrix?". */
export function allImmersionSites(): Array<
  ImmersionSite & { domain: string; language: ImmersionLanguage; role: "primary" | "alt" }
> {
  const out: ReturnType<typeof allImmersionSites> = [];
  for (const domain of IMMERSION_DOMAINS) {
    for (const lang of IMMERSION_LANGUAGES) {
      const cell = domain.sites[lang.code];
      out.push({ ...cell.primary, domain: domain.key, language: lang.code, role: "primary" });
      if (cell.alt) out.push({ ...cell.alt, domain: domain.key, language: lang.code, role: "alt" });
    }
  }
  return out;
}
