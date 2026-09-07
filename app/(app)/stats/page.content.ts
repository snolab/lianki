import { t, type DeclarationContent } from "intlayer";

const statsContent = {
  key: "stats-page",
  content: {
    title: t({
      en: "Input hours",
      zh: "输入时长",
      ja: "インプット時間",
      ko: "인풋 시간",
    }),
    subtitle: t({
      en: "Active listening time, measured per video.",
      zh: "按视频统计的主动收听时间。",
      ja: "動画ごとに計測した、実際に聴いていた時間。",
      ko: "영상별로 측정한 실제 청취 시간.",
    }),
    totalHours: t({ en: "Total hours", zh: "总时长", ja: "合計時間", ko: "총 시간" }),
    streak: t({ en: "Day streak", zh: "连续天数", ja: "連続日数", ko: "연속 일수" }),
    videos: t({ en: "Videos", zh: "视频", ja: "動画", ko: "영상" }),
    byLanguage: t({ en: "By language", zh: "按语言", ja: "言語別", ko: "언어별" }),
    topVideos: t({ en: "Most watched", zh: "观看最多", ja: "視聴が多い順", ko: "많이 본 순" }),
    coverage: t({ en: "covered", zh: "已看", ja: "視聴済み", ko: "시청함" }),
    unknownLanguage: t({ en: "Unlabelled", zh: "未标注", ja: "未設定", ko: "미지정" }),
    videosShort: t({ en: "vids", zh: "个", ja: "本", ko: "개" }),
    unlabelledExplainer: t({
      en: "Some videos have no language yet. YouTube only exposes the spoken language to the server, so it has to be looked up.",
      zh: "部分视频尚未识别语言。YouTube 只向服务器提供口语语言，因此需要查询。",
      ja: "言語が未判定の動画があります。YouTube は音声言語をサーバーにしか公開しないため、照会が必要です。",
      ko: "언어가 확인되지 않은 영상이 있습니다. YouTube는 음성 언어를 서버에만 노출하므로 조회가 필요합니다.",
    }),
    identifyLanguages: t({
      en: "Identify languages",
      zh: "识别语言",
      ja: "言語を判定",
      ko: "언어 식별",
    }),
    identifying: t({ en: "Identifying…", zh: "识别中…", ja: "判定中…", ko: "식별 중…" }),
    identified: t({ en: "Identified", zh: "已识别", ja: "判定済み", ko: "식별됨" }),
    needsApiKey: t({
      en: "The server has no YouTube API key configured, so languages cannot be looked up.",
      zh: "服务器未配置 YouTube API 密钥，无法查询语言。",
      ja: "サーバーに YouTube API キーが設定されていないため、言語を照会できません。",
      ko: "서버에 YouTube API 키가 없어 언어를 조회할 수 없습니다.",
    }),
    empty: t({
      en: "No watch time recorded yet. Install the userscript and play a video — time is counted only while it is actually playing, audible, and on screen.",
      zh: "尚无观看记录。安装用户脚本并播放视频——仅在实际播放、有声且在屏幕上时才计时。",
      ja: "まだ記録がありません。ユーザースクリプトを入れて動画を再生してください。実際に再生中で、音が出ていて、画面に表示されている間だけ計測されます。",
      ko: "아직 기록이 없습니다. 유저스크립트를 설치하고 영상을 재생하세요. 실제로 재생 중이고, 소리가 나며, 화면에 보일 때만 집계됩니다.",
    }),
    // The distinction matters enough to state plainly: at 1.5x an hour of
    // content costs 40 minutes of your life, and this app ships speed controls.
    wallVsMedia: t({
      en: "Wall-clock time. Content duration differs when you change playback speed.",
      zh: "实际经过的时间。改变播放速度时，内容时长会有所不同。",
      ja: "実時間です。再生速度を変えると、コンテンツの長さとは異なります。",
      ko: "실제 경과 시간입니다. 재생 속도를 바꾸면 콘텐츠 길이와 달라집니다.",
    }),
  },
} satisfies DeclarationContent;

export default statsContent;
