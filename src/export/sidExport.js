// Build a PSID v2 file from a recorded register-write timeline.
//
// File layout:
//   00..7B     PSID header (0x7C bytes)
//   7C..7D     2-byte LE load address (we set this to 0x1000 -> player code)
//   7E..       6502 player program + event data
//
// The player is a generic "register dump" replayer, not a real music
// routine: it just walks the recorded frame/register/value events and pokes
// them back in order, once per player call (50Hz PAL vsync). Any frameSource
// can be exported this way without a native 6502 music routine.
//
//   init ($1000): clear SID registers, reset the event pointer/countdown, RTS
//   play ($1020): count down to the next recorded write event, apply all
//     writes scheduled for the current frame in recorded order

const SID_WRITE_REG_COUNT = 25;
const VOICE_CONTROL_REGS = [0x04, 0x0B, 0x12];
const END_STREAM_REG = 0xFF;
const NOOP_STREAM_REG = 0xFE;
const MAX_EVENT_DELAY = 0xFFFF;
const EVENT_RECORD_BYTES = 4;

const PSID_LOAD_ADDR = 0x1000;
const PSID_INIT_ADDR = 0x1000;
const PSID_PLAY_ADDR = 0x1020;
const PSID_DATA_ADDR = 0x1100;
const PLAYER_PLAY_OFFSET = PSID_PLAY_ADDR - PSID_LOAD_ADDR;

// ---- Public API ---------------------------------------------------------

// frameSourceToTimeline(frameSource, frames) -> [{ frame, reg, value }, ...]
// Walks frameSource(0..frames-1) sequentially (its frame-diffing state
// assumes exactly that call pattern - see compile.js's header comment) and
// flattens every frame's pokes into one timeline, chip-relative register
// addresses already masked (addr & 0x1f), ready for buildPsidFromTimeline.
export function frameSourceToTimeline(frameSource, frames) {
  const timeline = [];
  for (let index = 0; index < frames; index += 1) {
    const pokes = frameSource ? frameSource(index) : null;
    if (!pokes) continue;
    for (const { addr, value } of pokes) {
      timeline.push({ frame: index, reg: addr & 0x1f, value: value & 0xff });
    }
  }
  return timeline;
}

export function buildPsidFromTimeline(timeline, options = {}) {
  const {
    title = 'rasterklang',
    author = 'anon',
    released = new Date().getFullYear().toString(),
    model = '6581',
    clock = 'PAL',
  } = options;

  const loadAddress = PSID_LOAD_ADDR;
  const initAddress = PSID_INIT_ADDR;
  const playAddress = PSID_PLAY_ADDR;
  const dataAddress = PSID_DATA_ADDR;
  const program = buildPlayerProgram(loadAddress, dataAddress);
  const events = timelineToEventRecords(timeline);

  // Concatenate program (zero-padded to dataAddress - loadAddress) + event data.
  const codeOffset = 0;
  const dataOffset = dataAddress - loadAddress;
  const totalLen = dataOffset + events.length * EVENT_RECORD_BYTES;
  const maxPayloadLen = 0x10000 - loadAddress;
  if (totalLen > maxPayloadLen) {
    throw new Error(`PSID payload is too large for C64 memory (${totalLen} > ${maxPayloadLen} bytes)`);
  }
  const payload = new Uint8Array(totalLen);
  payload.set(program, codeOffset);
  let p = dataOffset;
  for (const event of events) {
    payload[p + 0] = event.delay & 0xFF;
    payload[p + 1] = (event.delay >> 8) & 0xFF;
    payload[p + 2] = event.reg & 0xFF;
    payload[p + 3] = event.value & 0xFF;
    p += EVENT_RECORD_BYTES;
  }

  // Build PSID header (0x7C bytes), then load-addr (2 bytes), then payload.
  const header = buildPsidHeader({
    initAddress, playAddress,
    title, author, released, model, clock,
    songCount: 1, defaultSong: 1,
  });

  // Real PSID layout: dataOffset = 0x7C means the load-addr little-endian
  // word follows the header *as part of the data block*. Many tools handle
  // the case where loadAddress in header is 0 and the LE word in the file
  // body specifies the actual load address. We do exactly that.
  const out = new Uint8Array(header.length + 2 + payload.length);
  out.set(header, 0);
  out[0x7C] = loadAddress & 0xFF;
  out[0x7D] = (loadAddress >> 8) & 0xFF;
  out.set(payload, 0x7E);
  return out;
}

// ---- Header --------------------------------------------------------------

function buildPsidHeader({
  initAddress, playAddress,
  title, author, released, model, clock,
  songCount, defaultSong,
}) {
  const buf = new Uint8Array(0x7C);
  // "PSID" magic
  buf[0] = 0x50; buf[1] = 0x53; buf[2] = 0x49; buf[3] = 0x44;
  // version = 2
  writeBE16(buf, 0x04, 0x0002);
  // dataOffset = 0x7C
  writeBE16(buf, 0x06, 0x007C);
  // loadAddress = 0 (means: take from file body LE word)
  writeBE16(buf, 0x08, 0x0000);
  // initAddress
  writeBE16(buf, 0x0A, initAddress);
  // playAddress
  writeBE16(buf, 0x0C, playAddress);
  // songs / default song
  writeBE16(buf, 0x0E, songCount);
  writeBE16(buf, 0x10, defaultSong);
  // speed (one bit per song; 0 = vsync/PAL ~50 Hz)
  writeBE32(buf, 0x12, 0);
  // name (32 bytes), author (32 bytes), released (32 bytes)
  writePadded(buf, 0x16, title, 32);
  writePadded(buf, 0x36, author, 32);
  writePadded(buf, 0x56, released, 32);
  // flags @ 0x76: bit0=builtinmusicplayer? bit1=PSID_specific. bit2-3=clock
  // 00=unknown, 01=PAL, 10=NTSC, 11=any. bit4-5=model (00 unknown, 01=6581, 10=8580, 11=any)
  let flags = 0;
  flags |= clock === 'PAL' ? (1 << 2) : (clock === 'NTSC' ? (1 << 3) : (3 << 2));
  flags |= model === '6581' ? (1 << 4) : (model === '8580' ? (1 << 5) : (3 << 4));
  writeBE16(buf, 0x76, flags);
  // startPage / pageLength / secondSIDAddress / thirdSIDAddress: keep as 0.
  return buf;
}

function writeBE16(buf, off, value) {
  buf[off] = (value >> 8) & 0xFF;
  buf[off + 1] = value & 0xFF;
}
function writeBE32(buf, off, value) {
  buf[off] = (value >> 24) & 0xFF;
  buf[off + 1] = (value >> 16) & 0xFF;
  buf[off + 2] = (value >> 8) & 0xFF;
  buf[off + 3] = value & 0xFF;
}
function writePadded(buf, off, str, len) {
  const ascii = String(str).slice(0, len - 1);
  for (let i = 0; i < len; i += 1) {
    buf[off + i] = i < ascii.length ? ascii.charCodeAt(i) & 0xFF : 0;
  }
}

// ---- 6502 player ---------------------------------------------------------

// Event stream record, 4 bytes each: delayLo, delayHi, reg, value
//
// delay is the number of player calls (PAL frames) until this event fires.
// The first event stores frame+1 because the first play() call is frame 0.
// Events on the same frame use delay 0 and are applied in their original
// order.
function buildPlayerProgram(loadAddress, dataAddress) {
  const out = [];
  const labels = new Map();
  const branches = [];
  const absolutes = [];

  const lo = (n) => n & 0xFF;
  const hi = (n) => (n >> 8) & 0xFF;
  const pc = () => loadAddress + out.length;
  const label = (name) => labels.set(name, pc());
  const emit = (...bytes) => out.push(...bytes.map((b) => b & 0xFF));
  const emitBranch = (opcode, target) => {
    emit(opcode, 0x00);
    branches.push({ operandOffset: out.length - 1, target });
  };
  const emitJSR = (target) => {
    emit(0x20, 0x00, 0x00);
    absolutes.push({ operandOffset: out.length - 2, target });
  };

  // ----- init ($1000)
  emit(0xA2, SID_WRITE_REG_COUNT - 1); // LDX #$18
  emit(0xA9, 0x00); // LDA #$00
  label('clearSID');
  emit(0x9D, 0x00, 0xD4); // STA $D400,X
  emit(0xCA); // DEX
  emitBranch(0x10, 'clearSID'); // BPL clearSID
  emit(0xA9, lo(dataAddress)); // LDA #<DATA
  emit(0x85, 0xFB); // STA $FB
  emit(0xA9, hi(dataAddress)); // LDA #>DATA
  emit(0x85, 0xFC); // STA $FC
  emitJSR('loadWait');
  emit(0x60); // RTS
  // Pad to $1020 (so play sits at fixed offset after the init routine).
  if (out.length > PLAYER_PLAY_OFFSET) {
    throw new Error('SID player init routine exceeds fixed play offset');
  }
  while (out.length < PLAYER_PLAY_OFFSET) emit(0xEA); // NOP

  // ----- play ($1020)
  if (pc() !== PSID_PLAY_ADDR) {
    throw new Error(`SID player play routine is at $${pc().toString(16)}, expected $${PSID_PLAY_ADDR.toString(16)}`);
  }
  label('play');
  // If wait is already zero, process the current event now.
  emit(0xA5, 0xFD); // LDA $FD
  emit(0x05, 0xFE); // ORA $FE
  emitBranch(0xF0, 'process'); // BEQ process
  // Decrement wait.
  emit(0x38); // SEC
  emit(0xA5, 0xFD); // LDA $FD
  emit(0xE9, 0x01); // SBC #$01
  emit(0x85, 0xFD); // STA $FD
  emit(0xA5, 0xFE); // LDA $FE
  emit(0xE9, 0x00); // SBC #$00
  emit(0x85, 0xFE); // STA $FE
  emit(0xA5, 0xFD); // LDA $FD
  emit(0x05, 0xFE); // ORA $FE
  emitBranch(0xD0, 'done'); // BNE done

  label('process');
  emit(0xA0, 0x02); // LDY #$02
  emit(0xB1, 0xFB); // LDA ($FB),Y
  emit(0xC9, END_STREAM_REG); // CMP #$FF
  emitBranch(0xF0, 'reset'); // BEQ reset
  emit(0xC9, NOOP_STREAM_REG); // CMP #$FE
  emitBranch(0xF0, 'advance'); // BEQ advance
  emit(0xAA); // TAX
  emit(0xC8); // INY
  emit(0xB1, 0xFB); // LDA ($FB),Y
  emit(0x9D, 0x00, 0xD4); // STA $D400,X

  label('advance');
  emit(0x18); // CLC
  emit(0xA5, 0xFB); // LDA $FB
  emit(0x69, EVENT_RECORD_BYTES); // ADC #$04
  emit(0x85, 0xFB); // STA $FB
  emit(0xA5, 0xFC); // LDA $FC
  emit(0x69, 0x00); // ADC #$00
  emit(0x85, 0xFC); // STA $FC
  emitJSR('loadWait');
  emit(0xA5, 0xFD); // LDA $FD
  emit(0x05, 0xFE); // ORA $FE
  emitBranch(0xF0, 'process'); // BEQ process

  label('done');
  emit(0x60); // RTS

  label('reset');
  emit(0xA9, lo(dataAddress)); // LDA #<DATA
  emit(0x85, 0xFB); // STA $FB
  emit(0xA9, hi(dataAddress)); // LDA #>DATA
  emit(0x85, 0xFC); // STA $FC
  emitJSR('loadWait');
  emit(0x60); // RTS

  label('loadWait');
  emit(0xA0, 0x00); // LDY #$00
  emit(0xB1, 0xFB); // LDA ($FB),Y
  emit(0x85, 0xFD); // STA $FD
  emit(0xC8); // INY
  emit(0xB1, 0xFB); // LDA ($FB),Y
  emit(0x85, 0xFE); // STA $FE
  emit(0x60); // RTS

  // Pad to $100 bytes total (so program covers $1000..$10FF cleanly,
  // leaving frames at $1100 = dataAddress).
  const targetLength = dataAddress - loadAddress; // 0x100
  if (out.length > targetLength) {
    throw new Error(`SID player program exceeds reserved space (${out.length} > ${targetLength} bytes)`);
  }
  for (const patch of absolutes) {
    const target = labels.get(patch.target);
    if (target == null) throw new Error(`missing SID player label ${patch.target}`);
    out[patch.operandOffset] = lo(target);
    out[patch.operandOffset + 1] = hi(target);
  }
  for (const patch of branches) {
    const target = labels.get(patch.target);
    if (target == null) throw new Error(`missing SID player label ${patch.target}`);
    const nextPc = loadAddress + patch.operandOffset + 1;
    const rel = target - nextPc;
    if (rel < -128 || rel > 127) {
      throw new Error(`branch to ${patch.target} is out of range`);
    }
    out[patch.operandOffset] = rel & 0xFF;
  }
  while (out.length < targetLength) emit(0x00);

  return new Uint8Array(out);
}

// ---- Timeline -> event stream -------------------------------------------

// Convert a sequence of timestamped writes into ordered event records.
// timeline = [{ frame, reg, value }, ...]
function timelineToEventRecords(timeline, { tailFrames = 25 } = {}) {
  const writes = timeline
    .map((w, index) => ({
      index,
      frame: Math.max(0, Math.floor(Number(w.frame) || 0)),
      reg: Math.floor(Number(w.reg)),
      value: Math.floor(Number(w.value) || 0) & 0xFF,
    }))
    .filter((w) => Number.isFinite(w.reg) && w.reg >= 0 && w.reg < SID_WRITE_REG_COUNT);

  writes.sort((a, b) => (a.frame - b.frame) || (a.index - b.index));

  const events = [];
  let previousFrame = -1;
  const controlValues = [0, 0, 0];
  for (const write of writes) {
    const delay = previousFrame < 0 ? write.frame + 1 : write.frame - previousFrame;
    pushEventRecord(events, delay, write.reg, write.value);
    previousFrame = write.frame;
    const voice = VOICE_CONTROL_REGS.indexOf(write.reg);
    if (voice >= 0) controlValues[voice] = write.value;
  }

  if (writes.length) {
    const releaseFrame = previousFrame + 1;
    for (let voice = 0; voice < VOICE_CONTROL_REGS.length; voice += 1) {
      const control = controlValues[voice];
      if ((control & 0x01) === 0) continue;
      pushEventRecord(events, releaseFrame - previousFrame, VOICE_CONTROL_REGS[voice], control & 0xFE);
      previousFrame = releaseFrame;
    }
  }

  pushEventRecord(events, writes.length ? tailFrames : 1, END_STREAM_REG, 0x00);
  return events;
}

function pushEventRecord(events, delay, reg, value) {
  let remaining = Math.max(0, Math.floor(Number(delay) || 0));
  while (remaining > MAX_EVENT_DELAY) {
    events.push({ delay: MAX_EVENT_DELAY, reg: NOOP_STREAM_REG, value: 0x00 });
    remaining -= MAX_EVENT_DELAY;
  }
  events.push({ delay: remaining, reg, value });
}
