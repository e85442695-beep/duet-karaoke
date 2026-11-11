"""Render the three instrumental backing tracks and the matching lyric cue sheet."""

import json
import math
from pathlib import Path
import subprocess

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RATE = 44100


def add_note(mix, beat, start, length, midi, volume, instrument, pan=0):
    sample = round(start * beat * RATE)
    note_length = length * beat
    count = min(len(mix) - sample, round((note_length + 0.21) * RATE))
    if count <= 0:
        return
    t = np.arange(count) / RATE
    frequency = 440 * 2 ** ((midi - 69) / 12)
    phase = 2 * np.pi * frequency * t
    attack = np.minimum(1, t / (0.028 if instrument == "lead" else 0.009))
    release = np.exp(-np.maximum(0, t - note_length) * 29)
    if instrument == "lead":
        waveform = np.sin(phase) + 0.22 * np.sin(2 * phase) + 0.08 * np.sin(3 * phase)
        envelope = np.exp(-1.55 * t)
    elif instrument == "bell":
        waveform = np.sin(phase) + 0.24 * np.sin(2.007 * phase) + 0.13 * np.sin(3.018 * phase)
        envelope = np.exp(-4.0 * t)
    else:
        waveform = np.sin(phase) + 0.28 * np.sin(2 * phase) + 0.1 * np.sin(3 * phase)
        envelope = np.exp(-2.6 * t)
    note = (volume * waveform * attack * release * envelope).astype(np.float32)
    left = math.sqrt((1 - pan) / 2)
    right = math.sqrt((1 + pan) / 2)
    mix[sample:sample + count, 0] += note * left
    mix[sample:sample + count, 1] += note * right


def chord_pattern(mix, beat, start, length, chord, triple=False):
    step = 1.5 if triple else 2
    for position in np.arange(0, length, step):
        hold = min(length - position, step)
        add_note(mix, beat, start + position, hold * 0.9, chord[0] - 12, 0.17, "bass", -0.12)
    for index, position in enumerate(np.arange(0, length, 0.5)):
        pitch = chord[[0, 2, 1, 2][index % 4]]
        add_note(mix, beat, start + position, min(length - position, 0.43), pitch, 0.095, "pluck", 0.39)


def render(score):
    beat = 60 / score["tempo"]
    position = score["intro"]
    lyrics = []
    phrases = score["phrases"]
    harmony = score["harmony"]
    for index, verse in enumerate(score["verses"]):
        for line, text in enumerate(verse):
            notes = phrases[line % len(phrases)]
            length = sum(length for _, length in notes)
            lyrics.append((position, length, text, index % 2, line, notes))
            position += length

    duration = (position + 3) * beat
    mix = np.zeros((round(RATE * duration), 2), dtype=np.float32)
    identifier = score["id"]
    triple = identifier != "halia"
    chord_pattern(mix, beat, 0, score["intro"], harmony[0], triple)
    intro_position = 0
    for midi, length in phrases[0]:
        if intro_position + length > score["intro"]:
            break
        if midi is not None:
            add_note(mix, beat, intro_position, length * 0.89, midi, 0.22, "bell", -0.24)
        intro_position += length

    progressions = {
        "halia": [(0, 1), (2, 0), (0, 2), (1, 0)],
        "cherry": [(0, 3), (2, 0), (4, 1), (1, 0)],
        "shchedryk": [(0, 0), (1, 0), (2, 0), (3, 0)],
    }
    for line_number, (start, length, _, _, verse_line, notes) in enumerate(lyrics):
        progression = progressions[identifier]
        chord_a, chord_b = progression[(line_number if identifier == "shchedryk" else verse_line) % len(progression)]
        split = min(3 if triple else 2, length)
        chord_pattern(mix, beat, start, split, harmony[chord_a], triple)
        chord_pattern(mix, beat, start + split, length - split, harmony[chord_b], triple)
        cursor = start
        for midi, note_length in notes:
            if midi is not None:
                voice = "bell" if identifier == "shchedryk" else "lead"
                add_note(mix, beat, cursor, note_length * 0.91, midi, 0.24, voice, -0.22)
            cursor += note_length

    tonic = harmony[0]
    for index, pitch in enumerate([tonic[0] - 12, *tonic, tonic[0] + 12]):
        add_note(mix, beat, position + index * 0.12, 1.5, pitch, 0.11, "bell", (index - 2) * 0.16)
    dry = mix.copy()
    for milliseconds, level in [(39, 0.14), (73, 0.09), (137, 0.045)]:
        delay = round(RATE * milliseconds / 1000)
        mix[delay:] += level * dry[:-delay, ::-1]
    fade = round(RATE * 0.18)
    mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
    samples = (mix * (29500 / np.max(np.abs(mix)))).astype("<i2")
    output = ROOT / "audio" / (identifier + ".mp3")
    subprocess.run([
        "ffmpeg", "-loglevel", "error", "-y", "-f", "s16le", "-ar", str(RATE),
        "-ac", "2", "-i", "-", "-c:a", "libmp3lame", "-q:a", "4", str(output),
    ], input=samples.tobytes(), check=True)
    public = {key: score[key] for key in ("id", "title", "genre", "icon", "color")}
    public.update(intro=score["intro"] * beat, duration=duration, lines=[
        {"start": start * beat, "duration": length * beat, "text": text, "part": "red" if part else "blue"}
        for start, length, text, part, _, _ in lyrics
    ])
    return public


if __name__ == "__main__":
    (ROOT / "audio").mkdir(exist_ok=True)
    scores = json.loads((ROOT / "tools" / "folk-scores.json").read_text(encoding="utf-8"))
    songs = [render(score) for score in scores]
    (ROOT / "songs.js").write_text(
        "// Generated by tools/render-tracks.py.\nexport const songs = " +
        json.dumps(songs, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8"
    )
