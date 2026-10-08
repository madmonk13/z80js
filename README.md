# z80js

A touch-first emulator for Z80-based arcade boards of the late 1970s and early 80s, for
phones and desktop. Plain HTML, CSS and JavaScript modules, with no dependencies and no
build step. It shares its app shell (touch controls, settings, game library, audio) with
[6502js](https://github.com/madmonk13/6502js), the Atari 2600 emulator it was forked from.

No ROMs are included: add your own ROM sets, the zips used by MAME. A set is recognized
by its chips' file names, so the zip's own name doesn't matter.

## Supported games

| Game | Board | MAME sets | Status |
|---|---|---|---|
| Galaga (1981) | Namco Galaga: 3 Z80s, custom I/O chips, waveform sound | `galagao` | **Tested:** boots, attract mode, coin, start and play |
| | | `galaga`, `galagamw`, `galagamk`, `galagamf`, `gallag` | Recognized, not yet tested |
| Pac-Man (1980) | Namco Pac-Man: 1 Z80, waveform sound | `pacman` (Midway) | **Tested:** boots, attract mode, coin, start and play |
| Galaxian (1979) | Namco Galaxian: 1 Z80, analog sound | `galaxian` | **Tested:** boots, attract mode, coin, start and play |
| Donkey Kong (1981) | Nintendo: Z80, an 8035 sound CPU with a DAC, analog effects | `dkong` (US set 1) | **Tested:** boots, attract mode, coin, start and play |
| Ms. Pac-Man (1981) | Pac-Man board plus Midway's add-on board (its ROMs are stored scrambled; z80js unscrambles them) | `mspacman` | **Tested:** boots, attract mode, coin, start and play |
| Frogger (1981) | Konami: Galaxian-style video, a second Z80 and an AY-3-8910 for sound | `frogger` | **Tested:** boots, attract mode, coin, start and play |
| Donkey Kong Jr. (1982) | Donkey Kong board with a second tile bank and different sound wiring | `dkongjr` (US) | **Tested:** boots, attract mode, coin, start and play |

Galaga's older dumps that name the chips by board location (`04m_g01.bin` … `5n.bin`) are
recognized too; that's the tested Galaga set. Gallag's extra Z80 stood in for Namco's
custom chips, which z80js emulates directly, so that CPU's ROM is ignored.

Not supported: **Gatsbee** (Galaga hack with switchable graphics), **Puck Man** (Namco's
set splits the program across eight smaller chips, not yet handled), and the many other Galaxian-board clones and conversions (Moon Cresta,
Scramble, Super Cobra, Amidar and others), each of which changes the hardware a little.

## Controls

The touch layout follows the game:

- **Galaga, Galaxian:** the left half is a left/right pad, the right half is fire.
- **Donkey Kong, Donkey Kong Jr.:** the left half is a 4-way joystick, the right half is jump.
- **Pac-Man, Ms. Pac-Man, Frogger:** no fire button, so the whole lower screen is a 4-way joystick.
- **Coin / Start** sit in the top bar. Drop a coin, then press Start.
- Keyboards and gamepads also work: arrows or WASD to move, Space/Z/X to fire, 5 or C for
  a coin, 1 or Return to start (2 for two players).
- **Left-handed** mode in settings swaps the halves.

## Settings (⚙) and Games

- **Games:** add ROM sets (.zip). They're kept whole in `localStorage`; the last game
  played starts on launch.
- **Controls, Sound and volume**, as in 6502js.
- **Resume where I left off** (on by default): the game in progress is saved when the
  page is hidden or closed, and every few seconds while playing, so a refresh or relaunch
  picks up exactly where you were. Restart / Power cycle starts over.
- **Game switches:** each game's own DIP switches (lives, bonus life, difficulty and so
  on), remembered per game. Like the real boards, games read them at power-on, so they
  apply when you tap **Restart game**.

Settings and Games open full screen; the game pauses while either is open.

## Run

```bash
npm start     # http://localhost:1976
```

Headless check (boots a set and saves the screen as a PNG):

```bash
node tools/run-board.mjs path/to/set.zip 1500 out/frame.png
```

`COIN=600 START=700` in the environment drops a coin and starts a game; `HOLD=left` (or
right, up, down, fire) then holds a control.

## Layout

- `src/emu/z80.js`: the Z80 CPU (full instruction set including the undocumented parts,
  T-state timing, IM 0/1/2, NMI, HALT).
- `src/emu/boards.js`: the supported boards, how each ROM set is recognized, and the
  interface every board implements.
- `src/emu/galaga.js`: three Z80s on a shared bus, control latches and interrupts, the
  06xx bus interface, a high-level 51xx (coins, credits, controls), tiles, 64 sprites and
  the starfield (`galaga-stars.js`).
- `src/emu/pacman.js`: tiles, 8 sprites, IM 2 interrupts; Ms. Pac-Man's add-on board
  (unscrambling its ROMs and patching the Pac-Man program).
- `src/emu/galaxian.js`: column-scrolled tiles, sprites, hardware bullets and the star
  generator; `galaxian-sound.js` models its analog sound board.
- `src/emu/dkong.js`: Donkey Kong and Donkey Kong Jr.: tiles (colored per column and
  4-row block), 96 sprites and the interface to the sound CPU; `dkong-sound.js` is the DAC and analog effects.
- `src/emu/i8035.js`: the Intel 8035/8039 (MCS-48) microcontroller, Donkey Kong's sound CPU.
- `src/emu/frogger.js`: Frogger, built on the Galaxian board: its river background,
  rewired color and position lines, the 8255 PPI interface, and the sound board's Z80.
- `src/emu/ay8910.js`: the General Instrument AY-3-8910 sound chip.
- `src/emu/wsg.js`: Namco's 3-voice waveform sound generator (Pac-Man, Galaga).
- `src/emu/video.js`: graphics decoding, PROM palettes and rotation for vertical monitors.
- `src/main.js`, `src/touch.js`, `src/input.js`, `src/audio-out.js`: the app shell.

## Known gaps

- **Galaga explosions:** the 54xx sound chip runs its own program, which isn't part of the
  game ROMs, so a short burst of noise stands in.
- **Galaga starfield:** generated by z80js, not the arcade's exact star pattern.
- **Galaxian sound**, **Donkey Kong's walk, jump and stomp** and **Donkey Kong Jr.'s
  climb, jump, land, roar, snapjaw, death and drop** effects are models (of analog
  circuits, or of recorded samples on the original), so they're close but not exact. Donkey Kong's music is the real thing:
  its own sound CPU program, run by the 8035 core.
- Upright cabinets only (no cocktail flip); coinage is fixed at 1 coin, 1 credit.

## Other games on related hardware

Namco's next boards share Galaga's design (three Z80s, the 06xx and 51xx chips, the
waveform sound) but each adds its own video and custom chips:

| Game | Year | What it adds |
|---|---|---|
| Dig Dug | 1982 | A background playfield layer (the dirt) and the 53xx input chip. The closest to Galaga. |
| Bosconian | 1981 | A scrolling playfield, the radar display, the 50xx score chip and 52xx speech. |
| Xevious | 1982 | Two scrolling tile layers, a ROM-based terrain data chip, and the 50xx and 52xx. |
