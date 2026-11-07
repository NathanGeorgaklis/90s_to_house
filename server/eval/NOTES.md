# Evaluation notes: negative results

Measures that were built, checked against audio with a known answer, and rejected. Kept so they are not rebuilt.

| Date | Measure | Hypothesis | Check | Observed | Decision |
| --- | --- | --- | --- | --- | --- |
| 2026-11-07 | Stem low-frequency residue (energy < 120 Hz / total) | Bass and kick bleed raise low-end energy in the vocal stem | Clean voice vs full mix (`tests/real_voice_*.wav`) | −5.7 dB vs −5.1 dB: no separation. A male voice has strong energy below 120 Hz. | Rejected |
| 2026-11-07 | Stem percussive share (median-filter HPSS) | Drum bleed raises the percussive share | Same pair | 0.263 vs 0.273: no separation. Consonants are percussive. | Rejected |
| 2026-11-07 | Stem noise floor, 1 s windows | Bleed keeps the floor up between phrases | Same pair | −13.9 vs −9.3 dB: weak; most pauses are shorter than 1 s | Changed window |
| 2026-11-07 | Stem noise floor, 0.25 s windows, 10th vs 90th percentile | As above | Clean voice, AI stem (20.8 dB SDR), full mix | −160, −50.6, −14.5 dB: clear separation | **Adopted**, threshold −30 dB (uncalibrated) |
| 2026-11-07 | Vocal onset vector strength on the detected 8th-note grid | Onsets lock to a correct grid; a wrong grid scatters them | Drum loop mix, correct grid vs grid shifted 1/16 and tempo +3% | 0.093, 0.093, 0.136: cannot tell right from wrong (vector strength ignores phase; onsets not locked) | Rejected; alignment judged by tempo/downbeat truth checks and by listening |
