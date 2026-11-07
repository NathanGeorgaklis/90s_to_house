# Listening protocol

Each rework is judged by a person. The deciding question for the quality gate is:

> **Would you play this to another person without needing to explain or excuse obvious technical problems?**

## Setup

- Good headphones or studio monitors, the same volume for every song.
- Rate within a day of the run, ideally in one sitting, in manifest order.
- Write the scorecard yourself; do not change ground truth after listening.

## For each song

1. Play 30 seconds of the original.
2. Play the whole rework (`<id>/rework.wav`) without skipping.
3. Play the vocal stem (`<id>/vocal_stem.wav`) at the times in `listen_for_bleed_at_s`. These are the stem's quietest moments, where leftover drums or instruments are easiest to hear.
4. Fill in the scorecard row.

## Ratings (1 = unusable, 3 = acceptable with flaws, 5 = release quality)

| Column | What to judge |
| --- | --- |
| `sep_quality_1to5` | Does the vocal sound natural, or watery, phasey, robotic or thin? |
| `bleed_1to5` | 5 = no other instruments audible in the vocal; 1 = drums or music clearly audible |
| `tempo_grid_ok_YN` | Does the new beat sit at the right speed under the vocal (no drift)? |
| `vocal_beat_alignment_1to5` | Do vocal phrases land on the beat and start on the bar? |
| `arrangement_1to5` | Do the intro, groove, build, drop, break and outro happen at sensible moments? Any vocal cut mid-word? |
| `mix_1to5` | Vocal level against the beat, muddiness, harshness, chords clashing with the vocal |
| `master_1to5` | Loud enough next to commercial house tracks? Any distortion or pumping artefacts? |
| `overall_1to5` | Does it sound like a legitimate DJ-ready house rework rather than an AI demo? |
| `would_play_to_someone_YN` | The gate question above |
| `first_failed_stage` | The earliest stage that caused a problem: `none`, `1-separation`, `2-analysis`, `3-beat`, `4-arrangement`, `5-mix`, `6-master` |
| `exact_failure` | What went wrong and where, with times: e.g. "hi-hats audible in vocal 0:45–1:10", "vocal one beat late from 1:32", "chords clash with vocal in drop at 2:05" |

## Picking the first failed stage

Problems in later stages are often caused by earlier ones. Name the earliest:

- **1-separation**: drums, bass or music audible in the vocal; vocal sounds watery or robotic.
- **2-analysis**: beat at the wrong speed or drifting; vocal starts on the wrong beat; new chords clash with the vocal throughout (wrong key or chords).
- **3-beat**: the generated beat itself sounds wrong for the style or amateurish.
- **4-arrangement**: sections in odd places; drop with no vocal; vocal chopped mid-word.
- **5-mix**: levels, muddiness, harshness, vocal buried or too loud.
- **6-master**: too quiet, distorted, or pumping.
