import type { ReactNode } from "react";
import type { HomeFeatureKey } from "@/lib/home-features";

/**
 * The drawing behind each Explore card on /home, one per feature, saying what
 * it does without words: no letters or digits in any of them, so a card reads
 * the same in every locale. Decoration only (the card's own text names the
 * feature). Inks are the .lk-feature-art tokens in globals.css, which follow
 * the page in light and dark. The subject sits in the top half of the square,
 * above the card's text and its scrim, and the whole width always shows.
 */
const DRAWINGS: Record<HomeFeatureKey, ReactNode> = {
  // A brush stroke in a practice square, both ways with its sound.
  alphabet: (
    <>
      <path
        d="M32 28Q71 25 110 27 112 66 110 105 71 108 32 106 30 66 32 28Z"
        fill="var(--wash)"
        stroke="none"
      />
      <path
        d="M26 22Q65 19 104 21 106 60 104 99 65 102 26 100 24 60 26 22Z"
        fill="var(--sheet)"
        strokeWidth="2.8"
      />
      <path d="M65 25V96M29 60H101" strokeWidth="1.3" strokeDasharray="2 6" />
      <path
        d="M38 36C52 44 64 58 72 72 76 78 82 82 88 84 80 90 70 90 65 84 55 70 47 52 38 36Z"
        fill="var(--ink)"
        stroke="none"
      />
      <path d="M99 66L122 28" strokeWidth="4" />
      <path
        d="M86 84C86 76 90 70 94 63L103 69C101 77 95 82 86 84Z"
        fill="var(--seal)"
        stroke="none"
      />
      <path d="M116 60H138M122 53L115 60 122 67M132 53L139 60 132 67" stroke="var(--seal)" />
      <path d="M150 52V68M159 40V80M168 28V92M177 44V76M186 54V66" strokeWidth="3.6" />
    </>
  ),
  // A list, a video and a link, all coming down into one stack of cards.
  learn: (
    <>
      <g transform="rotate(-6 36 30)">
        <path d="M20 10H52V50H20Z" fill="var(--sheet)" />
        <path d="M27 20H45M27 30H45M27 40H39" strokeWidth="2" />
      </g>
      <rect x="78" y="10" width="46" height="33" rx="7" fill="var(--wash)" />
      <path d="M94 18V35L110 26.5Z" fill="var(--seal)" stroke="var(--seal)" />
      <g transform="rotate(-34 166 28)">
        <rect x="146" y="21" width="24" height="14" rx="7" />
        <rect x="162" y="21" width="24" height="14" rx="7" />
      </g>
      <path
        d="M40 56Q46 64 66 68M101 50V64M164 48Q156 62 134 68"
        strokeWidth="2"
        strokeDasharray="1 6"
      />
      <g transform="translate(0 -8)">
        <path d="M62 86L148 80 150 112 64 118Z" fill="var(--wash)" stroke="none" />
        <path
          d="M56 80Q100 77 142 79 144 96 142 110 100 113 56 111 54 96 56 80Z"
          fill="var(--sheet)"
        />
        <path d="M70 92Q84 89 112 92" />
        <path d="M70 101Q82 99 94 101" stroke="var(--seal)" />
      </g>
    </>
  ),
  // One word, in red, in new lines of writing; the sparks make them new.
  aiVocab: (
    <>
      <g transform="translate(0 -12)">
        <path d="M34 40L148 34 152 112 38 118Z" fill="var(--wash)" stroke="none" />
        <path
          d="M26 34Q84 30 142 32 145 70 142 106 84 110 28 108 24 70 26 34Z"
          fill="var(--sheet)"
          strokeWidth="2.8"
        />
        <path d="M40 52H66M98 51H128M58 72Q74 70 92 72M122 71H130M40 92H82" strokeWidth="2.4" />
        <path d="M72 52H92M36 72H52M98 72H116M88 92H108" stroke="var(--seal)" strokeWidth="3.6" />
      </g>
      <path
        d="M160 12Q163 32 182 36 163 40 160 60 157 40 138 36 157 32 160 12Z"
        fill="var(--seal)"
        stroke="none"
      />
      <path
        d="M176 72Q177 80 186 82 177 84 176 92 175 84 166 82 175 80 176 72Z"
        fill="var(--sheet)"
      />
    </>
  ),
  // One question, and an answer in each of several scripts: a wave, angles, loops.
  polyglot: (
    <>
      <path
        d="M16 54C16 34 32 24 50 26 68 28 80 40 78 58 76 74 60 84 44 80L24 92 28 74C20 70 16 62 16 54Z"
        fill="var(--wash)"
        strokeWidth="2.8"
      />
      <path d="M34 54H35M48 54H49M62 54H63" strokeWidth="5" />
      <g transform="translate(0 -4)">
        <path
          d="M96 12Q140 9 184 12 188 24 184 36 140 39 104 36L90 42 94 30Q92 20 96 12Z"
          fill="var(--sheet)"
        />
        <path d="M106 24Q113 16 120 24T134 24 148 24 162 24 174 24" />
      </g>
      <g transform="translate(0 -8)">
        <path
          d="M96 50Q140 47 184 50 188 62 184 74 140 77 104 74L90 80 94 68Q92 58 96 50Z"
          fill="var(--sheet)"
        />
        <path
          d="M106 66L114 56 122 66 130 56 138 66 146 56 154 66 162 56 172 66"
          stroke="var(--seal)"
        />
      </g>
      <g transform="translate(0 -12)">
        <path
          d="M96 88Q140 85 184 88 188 100 184 112 140 115 104 112L90 118 94 106Q92 96 96 88Z"
          fill="var(--sheet)"
        />
        <path d="M106 100C106 92 118 92 118 100S130 108 130 100 142 92 142 100 154 108 154 100 166 92 172 100" />
      </g>
    </>
  ),
  // A person speaking: words written in the bubble, and their sound.
  selfIntro: (
    <>
      <path
        d="M30 118Q32 80 62 78 96 80 100 118ZM82 50A19 19 0 1 1 44 50 19 19 0 1 1 82 50Z"
        fill="var(--wash)"
        stroke="none"
      />
      <circle cx="58" cy="46" r="19" fill="var(--sheet)" strokeWidth="2.8" />
      <path
        d="M24 114Q26 76 58 74 90 76 94 114 58 118 24 114Z"
        fill="var(--sheet)"
        strokeWidth="2.8"
      />
      <path
        d="M100 14Q144 10 186 14 190 38 186 62 150 66 112 62L92 74 98 56Q94 34 100 14Z"
        fill="var(--sheet)"
        strokeWidth="2.8"
      />
      <path d="M112 28Q132 25 174 28" strokeWidth="2.4" />
      <path
        d="M114 47V49M124 43V53M134 39V57M144 44V52M154 41V55M164 46V50M174 47V49"
        stroke="var(--seal)"
        strokeWidth="3.2"
      />
    </>
  ),
  // An open book; one word lifts off the page onto a card.
  read: (
    <>
      <path
        d="M100 54C84 42 50 40 18 48V116C50 108 84 110 100 122 116 110 150 108 182 116V48C150 40 116 42 100 54Z"
        fill="var(--wash)"
        stroke="none"
      />
      <path
        d="M100 48C84 36 50 34 14 42V108C50 100 84 102 100 114Z"
        fill="var(--sheet)"
        strokeWidth="2.8"
      />
      <path
        d="M100 48C116 36 150 34 186 42V108C150 100 116 102 100 114Z"
        fill="var(--sheet)"
        strokeWidth="2.8"
      />
      <path d="M28 54Q58 48 88 60M28 68Q58 62 88 74M28 82Q50 77 74 84" strokeWidth="2.2" />
      <path d="M112 60Q124 55 134 53M112 74Q142 64 172 68M112 88Q142 78 172 82" strokeWidth="2.2" />
      <path d="M142 51Q156 50 172 54" stroke="var(--seal)" strokeWidth="3.6" />
      <path d="M152 46Q148 34 156 26" strokeWidth="1.8" strokeDasharray="1 5" />
      <g transform="rotate(7 168 16)">
        <rect x="150" y="6" width="36" height="20" rx="4" fill="var(--seal)" stroke="var(--seal)" />
        <path d="M168 11V21M162 16H174" stroke="var(--sheet)" />
      </g>
    </>
  ),
  // The way to a goal over the hills: steps done, steps to come, the flag.
  roadmap: (
    <>
      <path
        d="M-120 96Q-50 62 0 88 26 52 54 74 76 38 112 66 140 40 200 82 260 110 320 86V200H-120Z"
        fill="var(--wash)"
        stroke="none"
      />
      <path
        d="M14 100C50 104 88 96 72 82 58 70 92 68 118 62 150 56 128 42 152 32"
        strokeWidth="2.6"
        strokeDasharray="7 7"
      />
      <circle cx="14" cy="100" r="5.5" fill="var(--ink)" />
      <circle cx="75" cy="85" r="5.5" fill="var(--ink)" />
      <circle cx="124" cy="61" r="5.5" fill="var(--sheet)" />
      <path d="M152 34V6" strokeWidth="2.8" />
      <path d="M152 7Q166 3 182 11 168 14 152 22Z" fill="var(--seal)" stroke="var(--seal)" />
    </>
  ),
};

export function FeatureArt({ feature }: { feature: HomeFeatureKey }) {
  return (
    <svg
      viewBox="0 0 200 200"
      preserveAspectRatio="xMidYMin meet"
      aria-hidden="true"
      fill="none"
      stroke="var(--ink)"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="lk-feature-art"
    >
      {DRAWINGS[feature]}
    </svg>
  );
}
