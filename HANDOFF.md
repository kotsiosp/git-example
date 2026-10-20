# Elena — session handoff (state as of 20 Oct 2026, evening UK)

Read this first when resuming. The full production guide (rules, sets, pipeline) is at
https://claude.ai/code/artifact/70ffa6f7-54d2-49b2-b113-abf5e80e151a. See README.md for the summary.

## Accounts and standing rules
- Handle **@elena.markets** (Instagram, TikTok, YouTube). Display name "Elena | Commodities Explained". Category: Education.
- The user posts manually. Elena is openly AI: turn on the AI label on every post. Education only; never claim
  credentials (the "10 years on a trading desk" backstory was rejected); no advice or predictions.
- Always quote credits before spending. Two reputable sources per fact.
- Instagram bio: "AI presenter 🤖 / Oil, gold & grains explained in 30s / What moved, why, and what it means for you / Education only · Not financial advice".

## Higgsfield
- Workspace 9f6f6bb4-0f5a-47e8-bbc5-f980858a984a (Max plan, 1,800 credits/month, next refill ~9 Nov 2026).
- **Balance: ~9 credits.** No talking-video renders until a refill or top-up. Voiceover Reels (~1 credit) and carousels are fine.
- Project "Elena Vance" d245d029-d7bc-4f97-ad11-a72ec0b0ea5f. Folders: Character 3a8407cf…, Sets 73c9a6e7-ca14-4678-8019-1c5bbcada477,
  Voice 850789a2-7fd8-497c-a546-52c42d5d53af, Reels 9da2c973-e37f-406b-a357-cd415a08fa1a.
- Voice clone **Elena-1** 646df622-e51e-4380-a38f-71e96e106e99 (seed_audio, voice_type element). Never edit the clips.
- Soul ID 068ff0dc-a93e-4944-8ab4-aee7259d5137. Front headshot 9e0e6a07-7ebb-440b-80c2-b9a3061a9b5b.
- Canary Wharf sets: wide 5ab845ec-7e54-4dd1-87f4-7ed2c326abdd, medium close-up b9785961-7bef-4244-8424-8419b5455f04
  (extended background 537a888f…, from the user's own photo).
- Topic photos (no Elena), soul_2 3:4: pumpjacks b8bae8d2…, tanker from above 4d1188a0…, motorway at night a3f12e68…,
  dollars b9172c7b…, storage tanks 5676a907… (CDN result URLs hf_20261020_1709xx_<id>.png).
- Network: the environment allows upload.higgsfield.ai, d2ol7oe51mr4n9.cloudfront.net and d8j0ntlcm91z4.cloudfront.net,
  so files can go both ways and be sent to the user with SendUserFile.
- Sandbox (ephemeral): TikTok Sans Bold font installed at $HF_WORKFLOWS/video-montage/scripts/fonts/TikTokSans-Bold.ttf
  (made with fontTools from Google Fonts tiktoksans; fontTools unpacked at /home/user/pylib). Headline helper: ~/launch/hook.py
  (args: out W H top "LINE1|LINE2" font). Carousel generator: ~/car1/make.py.

## Finished media (cloudfront d2ol7oe51mr4n9 …/user_3KTd9QbkP2vfmaEGcGyLseZePKj/<id>.mp4)
| Asset | Media ID | Status |
| --- | --- | --- |
| Oil "$110, then slipped", HQ (headline grid-safe, no grain) | 9ffde096-df52-4bb4-92e0-e0283cb00daf | Posted 20 Oct (an earlier version, b0313f30); HQ is for any repost |
| Brent vs WTI, HQ | 6b86fd23-69b5-4513-b903-035fb6570d88 | Posted 20 Oct evening, pinned |
| Cutdown "Why is Brent more expensive?" 12 s | d6e74155-146e-4fdc-a984-19c32af6b33c | TikTok 22 Oct |
| Carousel "5 things that move oil prices", slides 1–7 | 0bf18870…(1), 2cf82279…(2), cbd98a7d…(3), 2befb129…(4), dd9bb4ce…(5), 2936cbf7…(6), 7e33deb7…(7) | Instagram 22 Oct |
| Recut "70%" 13.5 s (hook test) | 75a1f4fa-2cee-4a98-a5e7-5c6447eec87d | TikTok Sat 24 Oct, 10am–12pm |
| Meet Elena | — | Dropped (weak). Replaced by a new intro script in the guide (after the refill) |

## Results so far
- TikTok oil Reel: 255 views, **5.4 s average watch, 3% full watch**. Most people left in the first 5 s.
  New retention rules: 20–25 s, curiosity hook, moving visual plus a big number in the first 2 s, new visual every 2–4 s, payoff before the sign-off.
- The first TikTok has TikTok's automatic "AI-generated media" label; the creator label can't be added after posting, which is OK.

## Pending / next
1. **Wed 21 Oct, 14:45 UTC scheduled task** (trig_01L2WxGtVjUZF72eQ1k2CrD1) fires in this session: research Tue/Wed news plus the EIA
   stockpile report (15:30 UK), send a 20–25 s voiceover script plus shot plan for approval, then build and send it for posting 6–8pm UK.
2. Thu 22 Oct: user posts the carousel (Instagram) and the cutdown (TikTok), evening. Captions already given.
3. Sat 24 Oct: the 70% recut on TikTok. Compare its average watch time with 5.4 s (target 7 s+).
4. Daily-posting test for 2 weeks: voiceover news 3×/week, carousels 2×/week, short talking news 2×/week once credits are available.
   Track average watch time, % full watch, saves, shares and follows. Ask the user for analytics.
5. The user may buy a credit top-up (~350–400 for the 2-week test). Not bought yet.
6. After the 9 Nov refill: new intro Reel (script in the guide), OPEC+ results, Contango, Petrol, Gold.
7. TikTok Promote: not yet. Later, test £10–20 on the best-performing video with the "followers" goal.
8. README is on branch `elena-readme` (pushed). The user hasn't decided yet between a PR and merging to main.

## Lessons (also in the guide)
- Never cut pauses or speed up voice clips (it made Seedance's speech break up). Test one scene before a full render.
- Seedance can repeat words; check the transcript and cut repeats at natural pauses.
- No film grain (Instagram's compression smears it). Export about 10 Mbps.
- Keep hook headlines out of the top and bottom 12.5% (the Instagram grid crops them).
- Carousels: Elena only on the cover and last slide.
