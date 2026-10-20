# Elena — AI commodities presenter

Elena is an openly AI presenter who explains oil, gold and grains in plain English.
Every post is education only (never buy/sell direction) and is labelled as AI.

- **Handle:** @elena.markets (Instagram, TikTok, YouTube Shorts)
- **Display name:** Elena | Commodities Explained
- **Full production guide:** https://claude.ai/code/artifact/70ffa6f7-54d2-49b2-b113-abf5e80e151a
  (the guide is the source of truth; this README is a quick summary)

## Production pipeline

| Step | Tool | Notes |
| --- | --- | --- |
| Research | Public news | Two reputable sources per fact; keep links with the script |
| Voice | Higgsfield `seed_audio`, voice element **Elena-1** (`646df622-e51e-4380-a38f-71e96e106e99`) | Never cut pauses or speed up clips; shorten the script instead |
| Talking scenes | Higgsfield **Seedance 2.5** omni-reference, 720p, 9:16 | Set image as `start_image`, voice clip as `audio_references`, static tripod prompt. About 7 credits per second |
| Voiceover Reels | Elena-1 voice over stills, charts and topic photos | About 1 credit each |
| Carousels | Pillow in the Higgsfield sandbox, 1080 × 1350 | Elena on the cover and last slide only; topic photos on the inside slides |
| Captions | video-montage caption workflow | TikTok Sans Bold, 5 words max, kept clear of Elena's face |
| Finishing | ffmpeg | 1080 × 1920, light sharpen, warm grade, **no grain**, faint room tone, loudnorm −14 LUFS, H.264 about 10 Mbps |

## Format rules

- **Daily news:** filmed entirely at Canary Wharf (wide `5ab845ec…`, close-up `b9785961…`), 20–25 s.
- **Retention:** curiosity hook in line 1, a moving visual and a big number in the first 2 s,
  a new visual every 2–4 s, a personal payoff before the sign-off.
- **Hook headline** sits in Instagram's grid-safe zone (about 16–26% from the top).
- **Sign-off:** "Not advice. Just context. Follow the barrels!"
- **Never** claim credentials (no trading-desk backstory), give advice, or make price predictions.

## Sets

| Set | Image ID | Use for |
| --- | --- | --- |
| Canary Wharf (real photo) | `5ab845ec-7e54-4dd1-87f4-7ed2c326abdd` | Daily news, markets |
| Home desk | `9ed57a87-8b83-4b1d-8027-d5d6c26fa9c6` | Explainers, sign-offs |
| Harbour wall | `447375b1-0740-430e-986b-8efd134cceba` | Oil and shipping explainers |
| Office window | `450f36fc-c815-44a6-92b3-fadf24702ec5` | Rates, gold, the dollar |
| News studio | `ec8dfe81-8c8d-4835-b7fc-da00bfc088ac` | Breaking news |

Retired: podcast studio, container port, Athens window, café, London.

## Posted so far

| Date | Post | Platforms |
| --- | --- | --- |
| 20 Oct 2026 | "Oil hit $110. Then it slipped." (news Reel) | Instagram, TikTok |
| 20 Oct 2026 | "Brent vs WTI: what's the difference?" (pinned) | Instagram, TikTok |

First result (TikTok, oil Reel): 255 views, 5.4 s average watch, 3% watched to the end. This led to
the 20–25 s retention format above.

## Next up

- **21 Oct:** voiceover news Reel (Tuesday and Wednesday news plus the EIA stockpile report)
- **22 Oct:** carousel "5 things that move oil prices" (Instagram); cutdown "Why is Brent more expensive?" (TikTok)
- **24 Oct:** 13.5 s "70%" recut on TikTok (hook test)
- **9 Nov:** credit refill, then the new intro Reel, the OPEC+ results and Contango

## Credits

About 1,800 Higgsfield credits a month on the Max plan (next refill around 9 Nov 2026).
A full 3-scene talking Reel costs about 250; a voiceover Reel about 1; carousels and edits are free.
