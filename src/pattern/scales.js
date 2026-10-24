// Musical scales, for turning scale DEGREES into actual pitches.
//
// Why this exists: writing a melody as note names pins it to one key, so
// transposing it ("the same phrase, up a whole step") either has to be done
// by hand or produces chromatic nonsense - `add 2` moves every note by two
// semitones regardless of whether the result is still in key. Degrees fix
// that: "0 2 4" is the first, third and fifth note OF THE SCALE, so a change
// of root or mode re-harmonises the whole phrase correctly.
//
// Semitone offsets from the root, one entry per scale degree. Kept as plain
// data (not generated from a formula) so an unusual scale is a one-line
// addition rather than a special case in the lookup.
export const SCALE_INTERVALS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10], // natural minor / aeolian
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export const SCALE_NAMES = Object.keys(SCALE_INTERVALS);

const NOTE_SEMITONES = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

// parseScaleSpec("c4:minor") -> { rootMidi, intervals }.
//
// The octave is optional and defaults to 4, matching the octave a bare "c4"
// note name already means elsewhere in this project (miniNotation.js's
// (octave+1)*12 + semitone convention, so c4 = 60).
export function parseScaleSpec(spec) {
  const [rootPart, scalePart] = String(spec).split(':');
  if (!scalePart) {
    throw new Error(`scale "${spec}" needs a root and a scale name, e.g. "c4:minor" or "c:dorian".`);
  }
  const m = /^([a-gA-G])([sf#b]?)(-?\d+)?$/.exec(rootPart.trim());
  if (!m) {
    throw new Error(`scale "${spec}": "${rootPart}" isn't a note name (expected e.g. c, fs, ef, c4).`);
  }
  const [, letter, accidental, octave] = m;
  let semitone = NOTE_SEMITONES[letter.toLowerCase()];
  if (accidental === 's' || accidental === '#') semitone += 1;
  if (accidental === 'f' || accidental === 'b') semitone -= 1;
  const intervals = SCALE_INTERVALS[scalePart.trim()];
  if (!intervals) {
    throw new Error(`scale "${spec}": unknown scale "${scalePart}" (known: ${SCALE_NAMES.join(', ')}).`);
  }
  const oct = octave === undefined ? 4 : Number(octave);
  return { rootMidi: (oct + 1) * 12 + semitone, intervals };
}

// degreeToMidi(degree, { rootMidi, intervals }) -> a MIDI note number.
//
// Degrees past the end of the scale wrap into the next octave (degree 7 of a
// 7-note scale is the root an octave up), and negative degrees wrap downward
// the same way - so "0 2 4 7" is a rising arpeggio that keeps going rather
// than stopping at the top of one octave.
export function degreeToMidi(degree, { rootMidi, intervals }) {
  const n = intervals.length;
  const idx = Math.round(degree);
  const octaveShift = Math.floor(idx / n);
  const within = ((idx % n) + n) % n;
  return rootMidi + octaveShift * 12 + intervals[within];
}
