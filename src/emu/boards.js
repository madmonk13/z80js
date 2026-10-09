// The boards z80js emulates, and how to recognize each one's ROM set.
//
// A ROM set is a zip of the board's individual chips. Sets have been dumped
// under several naming schemes over the years, so each chip is recognized by
// any of its known names (board location or part number) and its size.
//
// Every board class exposes the same interface:
//   width, height        picture size as displayed (rotated for vertical monitors)
//   frame                Uint32Array of RGBA pixels, updated each frame
//   refresh              frames per second
//   controls             'two-way' (left/right), 'four-way' or 'eight-way'
//   buttons              number of fire buttons (0-2; button2 names the second)
//   dialControl          true if the game has a spinner (read as `spin`)
//   sound                sample source: buffer/readPos/writePos/available()/pull(), rate
//   runFrame(), reset()
//   setInputs({ left, right, up, down, fire, fire2, spin, coin, start1, start2 })
//   applySwitches({ id: value }) with the options listed in Board.switches
//   Board.stateVersion   (optional) bumped when older saved states no longer restore correctly

import { Galaga } from './galaga.js';
import { PacMan, MsPacMan, JrPacMan } from './pacman.js';
import { Galaxian, MoonCresta } from './galaxian.js';
import { DonkeyKong, DonkeyKongJr } from './dkong.js';
import { Frogger } from './frogger.js';
import { Scramble, Amidar } from './scramble.js';
import { DigDug } from './digdug.js';
import { TimePilot, Pooyan } from './timeplt.js';
import { MrDo } from './mrdo.js';
import { SatansHollow, Tron, Tapper } from './mcr.js';
import { Bosconian, Xevious } from './bosco.js';
import { Berzerk, Frenzy } from './berzerk.js';

const BOARDS = [
  {
    Board: Galaga,
    chips: [
      ['main0', 0x1000, [/^04m_g01/, /^gg1[-_]1(b|\.|$)/, /^3200a/, /^mk2-1/]],
      ['main1', 0x1000, [/^04k_g02/, /^gg1[-_]2(b|\.|$)/, /^3300b/, /^mk2-2/, /^gallag\.2/]],
      ['main2', 0x1000, [/^04j_g03/, /^gg1[-_]3(b|\.|$)/, /^3400c/]],
      ['main3', 0x1000, [/^04h_g04/, /^gg1[-_]4(b|\.|$)/, /^3500d/, /^mk2-4/]],
      ['sub', 0x1000, [/^04e_g05/, /^gg1[-_]5(b|\.|$)/, /^3600e/, /^3600fast/]],
      ['sound', 0x1000, [/^04d_g06/, /^gg1[-_]7(b|\.|$)/, /^3700g/]],
      ['chars', 0x1000, [/^07m_g08/, /^gg1[-_]9(\.|$)/, /^gallag\.8/]],
      ['sprites0', 0x1000, [/^07e_g10/, /^gg1[-_]11/]],
      ['sprites1', 0x1000, [/^07h_g09/, /^gg1[-_]10/]],
      ['palette', 0x20, [/^5n\./, /prom-5\.5n/, /\.5n$/]],
      ['charLut', 0x100, [/^2n\./, /prom-4\.2n/, /\.2n$/]],
      ['spriteLut', 0x100, [/^1c\./, /prom-3\.1c/, /\.1c$/]],
      ['wave', 0x100, [/^1d\./, /prom-1\.1d/, /\.1d$/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3), sub: c.sub, sound: c.sound, chars: c.chars,
      sprites: cat(c.sprites0, c.sprites1), palette: c.palette, charLut: c.charLut, spriteLut: c.spriteLut, wave: c.wave,
    }),
  },
  {
    Board: PacMan,
    chips: [
      ['main0', 0x1000, [/^pacman\.6e/, /^namcopac\.6e/]],
      ['main1', 0x1000, [/^pacman\.6f/, /^namcopac\.6f/]],
      ['main2', 0x1000, [/^pacman\.6h/, /^namcopac\.6h/]],
      ['main3', 0x1000, [/^pacman\.6j/, /^namcopac\.6j/]],
      ['tiles', 0x1000, [/^pacman\.5e/]],
      ['sprites', 0x1000, [/^pacman\.5f/]],
      ['palette', 0x20, [/^82s123\.7f/, /^pm1-1\.7f/]],
      ['lut', 0x100, [/^82s126\.4a/, /^pm1-4\.4a/]],
      ['wave', 0x100, [/^82s126\.1m/, /^pm1-3\.1m/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3), tiles: c.tiles, sprites: c.sprites,
      palette: c.palette, lut: c.lut, wave: c.wave,
    }),
  },
  {
    Board: JrPacMan,
    chips: [
      ['p8d', 0x2000, [/^jrp8d/]],
      ['p8e', 0x2000, [/^jrp8e/]],
      ['p8h', 0x2000, [/^jrp8h/]],
      ['p8j', 0x2000, [/^jrp8j/]],
      ['p8k', 0x2000, [/^jrp8k/]],
      ['tiles', 0x2000, [/^jrp2c/]],
      ['sprites', 0x2000, [/^jrp2e/]],
      ['palLow', 0x100, [/^jrprom\.9e/]],
      ['palHigh', 0x100, [/^jrprom\.9f/]],
      ['lut', 0x100, [/^jrprom\.9p/]],
      ['wave', 0x100, [/^jrprom\.7p/]],
    ],
    // The palette is two 4-bit PROMs side by side; 4000-7FFF is RAM and I/O.
    assemble: (c) => ({
      main: cat(c.p8d, c.p8e, new Uint8Array(0x4000), c.p8h, c.p8j, c.p8k), tiles: c.tiles, sprites: c.sprites,
      palette: Uint8Array.from({ length: 32 }, (_, i) => (c.palLow[i] & 0x0F) | ((c.palHigh[i] & 0x0F) << 4)),
      lut: c.lut, wave: c.wave,
    }),
  },
  {
    Board: Galaxian,
    chips: [
      ['main0', 0x800, [/\.u$/, /^galmidw\.u/, /^galaxian\.u/]],
      ['main1', 0x800, [/\.v$/, /^galmidw\.v/, /^galaxian\.v/]],
      ['main2', 0x800, [/\.w$/, /^galmidw\.w/, /^galaxian\.w/]],
      ['main3', 0x800, [/\.y$/, /^galmidw\.y/, /^galaxian\.y/]],
      ['main4', 0x800, [/^7l(\.|$)/]],
      ['gfx0', 0x800, [/^1h(\.|$)/]],
      ['gfx1', 0x800, [/^1k(\.|$)/]],
      ['palette', 0x20, [/^6l(\.|$)/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3, c.main4), gfx: cat(c.gfx0, c.gfx1), palette: c.palette,
    }),
  },
  {
    Board: DonkeyKong,
    chips: [
      ['main0', 0x1000, [/^c_5et/]],
      ['main1', 0x1000, [/^c_5ct/]],
      ['main2', 0x1000, [/^c_5bt/]],
      ['main3', 0x1000, [/^c_5at/]],
      ['sound0', 0x800, [/^s_3i/]],
      ['sound1', 0x800, [/^s_3j/]],
      ['tiles0', 0x800, [/^v_5h/]],
      ['tiles1', 0x800, [/^v_3p/]],
      ['sprites0', 0x800, [/^l_4m/]],
      ['sprites1', 0x800, [/^l_4n/]],
      ['sprites2', 0x800, [/^l_4r/]],
      ['sprites3', 0x800, [/^l_4s/]],
      ['palLow', 0x100, [/^c-2k/, /^dkong\.2k/]],
      ['palHigh', 0x100, [/^c-2j/, /^dkong\.2j/]],
      ['colors', 0x100, [/^v-5e/, /^dkong\.5f/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3), sound: cat(c.sound0, c.sound1),
      tiles: cat(c.tiles0, c.tiles1), sprites: cat(c.sprites0, c.sprites1, c.sprites2, c.sprites3),
      palLow: c.palLow, palHigh: c.palHigh, colors: c.colors,
    }),
  },
  {
    Board: MsPacMan,
    chips: [
      ['main0', 0x1000, [/^pacman\.6e/, /^boot1/]],
      ['main1', 0x1000, [/^pacman\.6f/, /^boot2/]],
      ['main2', 0x1000, [/^pacman\.6h/, /^boot3/]],
      ['main3', 0x1000, [/^pacman\.6j/, /^boot4/]],
      ['u5', 0x800, [/^u5(\.|$)/]],
      ['u6', 0x1000, [/^u6(\.|$)/]],
      ['u7', 0x1000, [/^u7(\.|$)/]],
      ['tiles', 0x1000, [/^5e(\.|$)/]],
      ['sprites', 0x1000, [/^5f(\.|$)/]],
      ['palette', 0x20, [/^82s123\.7f/]],
      ['lut', 0x100, [/^82s126\.4a/]],
      ['wave', 0x100, [/^82s126\.1m/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3), u5: c.u5, u6: c.u6, u7: c.u7,
      tiles: c.tiles, sprites: c.sprites, palette: c.palette, lut: c.lut, wave: c.wave,
    }),
  },
  {
    Board: DonkeyKongJr,
    chips: [
      ['p5b', 0x2000, [/^dkj\.5b/]],
      ['p5c', 0x2000, [/^dkj\.5c/]],
      ['p5e', 0x2000, [/^dkj\.5e/]],
      ['sound', 0x1000, [/^c_3h/]],
      ['tiles0', 0x1000, [/^dkj\.3n/]],
      ['tiles1', 0x1000, [/^dkj\.3p/]],
      ['sprites0', 0x800, [/^v_7c/]],
      ['sprites1', 0x800, [/^v_7d/]],
      ['sprites2', 0x800, [/^v_7e/]],
      ['sprites3', 0x800, [/^v_7f/]],
      ['palLow', 0x100, [/^c-2e/]],
      ['palHigh', 0x100, [/^c-2f/]],
      ['colors', 0x100, [/^v-2n/]],
    ],
    // The 8K program chips are wired in 2K and 4K pieces scattered across 0000-5FFF.
    assemble: (c) => {
      const main = new Uint8Array(0x6000);
      const place = (rom, pieces) => pieces.forEach(([to, size], i) => {
        const from = pieces.slice(0, i).reduce((n, [, s]) => n + s, 0);
        main.set(rom.subarray(from, from + size), to);
      });
      place(c.p5b, [[0x0000, 0x1000], [0x3000, 0x1000]]);
      place(c.p5c, [[0x2000, 0x800], [0x4800, 0x800], [0x1000, 0x800], [0x5800, 0x800]]);
      place(c.p5e, [[0x4000, 0x800], [0x2800, 0x800], [0x5000, 0x800], [0x1800, 0x800]]);
      return {
        main, sound: c.sound, tiles: cat(c.tiles0, c.tiles1),
        sprites: cat(c.sprites0, c.sprites1, c.sprites2, c.sprites3),
        palLow: c.palLow, palHigh: c.palHigh, colors: c.colors,
      };
    },
  },
  {
    Board: Frogger,
    chips: [
      ['main0', 0x1000, [/^frogger\.26/]],
      ['main1', 0x1000, [/^frogger\.27/]],
      ['main2', 0x1000, [/^frsm3\.7/]],
      ['sound0', 0x800, [/^frogger\.608/]],
      ['sound1', 0x800, [/^frogger\.609/]],
      ['sound2', 0x800, [/^frogger\.610/]],
      ['gfx0', 0x800, [/^frogger\.607/]],
      ['gfx1', 0x800, [/^frogger\.606/]],
      ['palette', 0x20, [/^pr-91\.6l/]],
    ],
    // Two chips are wired with data lines 0 and 1 swapped: the first sound
    // ROM and the second graphics ROM.
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2),
      sound: cat(swap01(c.sound0), c.sound1, c.sound2),
      gfx: cat(c.gfx0, swap01(c.gfx1)),
      palette: c.palette,
    }),
  },
  {
    Board: Scramble,
    chips: [
      ...['2d', '2e', '2f', '2h', '2j', '2l', '2m', '2p'].map((l, n) => [`main${n}`, 0x800, [new RegExp(`^${l}\\.k$`), new RegExp(`^s${n + 1}\\.${l}$`)]]),
      ['sound0', 0x800, [/^5c$/, /^ot1\.5c$/]],
      ['sound1', 0x800, [/^5d$/, /^ot2\.5d$/]],
      ['sound2', 0x800, [/^5e$/, /^ot3\.5e$/]],
      ['gfx0', 0x800, [/^5f\.k$/, /^c2\.5f$/]],
      ['gfx1', 0x800, [/^5h\.k$/, /^c1\.5h$/]],
      ['palette', 0x20, [/^82s123\.6e$/, /^c01s\.6e$/]],
    ],
    assemble: (c) => ({
      main: cat(...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => c[`main${n}`])), sound: cat(c.sound0, c.sound1, c.sound2),
      gfx: cat(c.gfx0, c.gfx1), palette: c.palette,
    }),
  },
  {
    Board: Amidar,
    chips: [
      ['main0', 0x1000, [/^amidar\.2c$/]],
      ['main1', 0x1000, [/^amidar\.2e$/]],
      ['main2', 0x1000, [/^amidar\.2f$/]],
      ['main3', 0x1000, [/^amidar\.2h$/]],
      ['sound0', 0x1000, [/^amidar\.5c$/]],
      ['sound1', 0x1000, [/^amidar\.5d$/]],
      ['gfx0', 0x800, [/^amidar\.5f$/]],
      ['gfx1', 0x800, [/^amidar\.5h$/]],
      ['palette', 0x20, [/^amidar\.clr$/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3), sound: cat(c.sound0, c.sound1),
      gfx: cat(c.gfx0, c.gfx1), palette: c.palette,
    }),
  },
  {
    Board: MoonCresta,
    chips: [
      ...['mc1', 'mc2', 'mc3', 'mc4', 'mc5\\.7r', 'mc6\\.8d', 'mc7\\.8e', 'mc8'].map((n, i) => [`main${i}`, 0x800, [new RegExp(`^${n}$`)]]),
      ['gfxB', 0x800, [/^mcs_b$/]],
      ['gfxD', 0x800, [/^mcs_d$/]],
      ['gfxA', 0x800, [/^mcs_a$/]],
      ['gfxC', 0x800, [/^mcs_c$/]],
      ['palette', 0x20, [/^l06_prom\.bin$/, /^mmi6331\.6l$/]],
    ],
    assemble: (c) => ({
      main: cat(...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => c[`main${n}`])), gfx: cat(c.gfxB, c.gfxD, c.gfxA, c.gfxC), palette: c.palette,
    }),
  },
  {
    Board: DigDug,
    chips: [
      ['main0', 0x1000, [/^136007\.101/, /^dd1a\.1$/, /^136007\.201/]],
      ['main1', 0x1000, [/^136007\.102/, /^dd1a\.2$/, /^136007\.202/]],
      ['main2', 0x1000, [/^136007\.103/, /^dd1a\.3$/, /^136007\.203/]],
      ['main3', 0x1000, [/^dd1\.4b/, /^dd1a\.4$/, /^136007\.104/, /^136007\.204/]],
      ['sub0', 0x1000, [/^dd1\.5b/, /^dd1a\.5$/, /^136007\.105/, /^136007\.205/]],
      ['sub1', 0x1000, [/^dd1\.6b/, /^dd1a\.6$/, /^136007\.106/, /^136007\.206/]],
      ['sound', 0x1000, [/^136007\.107/]],
      ['chars', 0x800, [/^dd1\.9$/, /^136007\.108/]],
      ['sprites0', 0x1000, [/^136007\.116/]],
      ['sprites1', 0x1000, [/^dd1\.14/, /^136007\.117/]],
      ['sprites2', 0x1000, [/^136007\.118/]],
      ['sprites3', 0x1000, [/^136007\.119/]],
      ['bgTiles', 0x1000, [/^dd1\.11/, /^136007\.115/]],
      ['bgMap', 0x1000, [/^dd1\.10b/, /^136007\.114/]],
      ['palette', 0x20, [/^digdug\.5n/, /^136007\.113/]],
      ['spriteLut', 0x100, [/^digdug\.1c/, /^136007\.111/]],
      ['bgLut', 0x100, [/^digdug\.2n/, /^136007\.112/]],
      ['wave', 0x100, [/^digdug\.spr/, /^136007\.110/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3), sub: cat(c.sub0, c.sub1), sound: c.sound,
      chars: c.chars, sprites: cat(c.sprites0, c.sprites1, c.sprites2, c.sprites3),
      bgTiles: c.bgTiles, bgMap: c.bgMap, palette: c.palette, spriteLut: c.spriteLut, bgLut: c.bgLut, wave: c.wave,
    }),
  },
  {
    Board: TimePilot,
    chips: [
      ['main0', 0x2000, [/^tm1$/, /^cd1y/, /^cd_e1/]],
      ['main1', 0x2000, [/^tm2$/, /^cd2y/, /^cd_e2/]],
      ['main2', 0x2000, [/^tm3$/, /^cd3y/, /^cd_e3/]],
      ['sound', 0x1000, [/^tm7$/]],
      ['chars', 0x2000, [/^tm6$/]],
      ['sprites0', 0x2000, [/^tm4$/]],
      ['sprites1', 0x2000, [/^tm5$/]],
      ['palLo', 0x20, [/^timeplt\.b4/]],
      ['palHi', 0x20, [/^timeplt\.b5/]],
      ['spriteLut', 0x100, [/^timeplt\.e9/]],
      ['charLut', 0x100, [/^timeplt\.e12/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2), sound: c.sound, chars: c.chars, sprites: cat(c.sprites0, c.sprites1),
      palLo: c.palLo, palHi: c.palHi, spriteLut: c.spriteLut, charLut: c.charLut,
    }),
  },
  {
    Board: Pooyan,
    chips: [
      ['main0', 0x2000, [/^1\.4a$/, /^ic22_a4/]],
      ['main1', 0x2000, [/^2\.5a$/, /^ic23_a5/]],
      ['main2', 0x2000, [/^3\.6a$/, /^ic24_a6/]],
      ['main3', 0x2000, [/^4\.7a$/, /^ic25_a7/]],
      ['sound0', 0x1000, [/^xx\.7a$/]],
      ['sound1', 0x1000, [/^xx\.8a$/]],
      ['chars0', 0x1000, [/^8\.10g$/]],
      ['chars1', 0x1000, [/^7\.9g$/]],
      ['sprites0', 0x1000, [/^6\.9a$/]],
      ['sprites1', 0x1000, [/^5\.8a$/]],
      ['palette', 0x20, [/^pooyan\.pr1/]],
      ['spriteLut', 0x100, [/^pooyan\.pr2/]],
      ['charLut', 0x100, [/^pooyan\.pr3/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3), sound: cat(c.sound0, c.sound1),
      chars: cat(c.chars0, c.chars1), sprites: cat(c.sprites0, c.sprites1),
      palette: c.palette, spriteLut: c.spriteLut, charLut: c.charLut,
    }),
  },
  {
    Board: MrDo,
    chips: [
      ['main0', 0x2000, [/^a4-01/, /^d1$/]],
      ['main1', 0x2000, [/^c4-02/, /^d2$/]],
      ['main2', 0x2000, [/^e4-03/, /^d3$/]],
      ['main3', 0x2000, [/^f4-04/, /^d4$/]],
      ['fg0', 0x1000, [/^s8-09/, /^d9$/]],
      ['fg1', 0x1000, [/^u8-10/, /^d10$/]],
      ['bg0', 0x1000, [/^r8-08/]],
      ['bg1', 0x1000, [/^n8-07/]],
      ['sprites0', 0x1000, [/^h5-05/]],
      ['sprites1', 0x1000, [/^k5-06/]],
      ['palHi', 0x20, [/^u02--2/]],
      ['palLo', 0x20, [/^t02--3/]],
      ['spriteLut', 0x20, [/^f10--1/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3), fg: cat(c.fg0, c.fg1), bg: cat(c.bg0, c.bg1),
      sprites: cat(c.sprites0, c.sprites1), palHi: c.palHi, palLo: c.palLo, spriteLut: c.spriteLut,
    }),
  },
  {
    Board: Bosconian,
    chips: [
      ['main0', 0x1000, [/^bos3_1/, /^bos1_1/, /^bos2_1/]],
      ['main1', 0x1000, [/^bos1_2/]],
      ['main2', 0x1000, [/^bos1_3/]],
      ['main3', 0x1000, [/^bos1_4/]],
      ['sub0', 0x1000, [/^bos1_5/]],
      ['sub1', 0x1000, [/^bos3_6/, /^bos1_6/]],
      ['sound', 0x1000, [/^2900\.3e/]],
      ['chars', 0x1000, [/^5300\.5d/]],
      ['sprites', 0x1000, [/^5200\.5e/]],
      ['dots', 0x100, [/^prom\.2d/]],
      ['palette', 0x20, [/^bosco\.6b/]],
      ['charLut', 0x100, [/^bosco\.4m/]],
      ['wave', 0x100, [/^prom\.1d/, /^bosco\.spr/]],
      ['speech0', 0x1000, [/^4900\.5n/]],
      ['speech1', 0x1000, [/^5000\.5m/]],
      ['speech2', 0x1000, [/^5100\.5l/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3), sub: cat(c.sub0, c.sub1), sound: c.sound,
      chars: c.chars, sprites: c.sprites, dots: c.dots, palette: c.palette, charLut: c.charLut, spriteLut: c.charLut,
      wave: c.wave, speech: cat(c.speech0, c.speech1, c.speech2),
    }),
  },
  {
    Board: Xevious,
    chips: [
      ['main0', 0x1000, [/^xvi_1\.3p/]],
      ['main1', 0x1000, [/^xvi_2\.3m/]],
      ['main2', 0x1000, [/^xvi_3\.2m/]],
      ['main3', 0x1000, [/^xvi_4\.2l/]],
      ['sub0', 0x1000, [/^xvi_5\.3f/]],
      ['sub1', 0x1000, [/^xvi_6\.3j/]],
      ['sound', 0x1000, [/^xvi_7\.2c/]],
      ['fg', 0x1000, [/^xvi_12\.3b/]],
      ['bg0', 0x1000, [/^xvi_13\.3c/]],
      ['bg1', 0x1000, [/^xvi_14\.3d/]],
      ['sp15', 0x2000, [/^xvi_15\.4m/]],
      ['sp17', 0x2000, [/^xvi_17\.4p/]],
      ['sp16', 0x1000, [/^xvi_16\.4n/]],
      ['sp18', 0x2000, [/^xvi_18\.4r/]],
      ['map2a', 0x1000, [/^xvi_9\.2a/]],
      ['map2b', 0x2000, [/^xvi_10\.2b/]],
      ['map2c', 0x1000, [/^xvi_11\.2c/]],
      ['red', 0x100, [/^xvi_8bpr\.6a/]],
      ['green', 0x100, [/^xvi_9bpr\.6d/]],
      ['blue', 0x100, [/^xvi10bpr\.6e/]],
      ['bgLutLo', 0x200, [/^xvi_7bpr\.4h/]],
      ['bgLutHi', 0x200, [/^xvi_6bpr\.4f/]],
      ['spLutLo', 0x200, [/^xvi_4bpr\.3l/]],
      ['spLutHi', 0x200, [/^xvi_5bpr\.3m/]],
      ['wave', 0x100, [/^xvi_2bpr\.7n/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3), sub: cat(c.sub0, c.sub1), sound: c.sound,
      fg: c.fg, bg: cat(c.bg0, c.bg1), sp15: c.sp15, sp17: c.sp17, sp16: c.sp16, sp18: c.sp18,
      bgMap: cat(c.map2a, c.map2b, c.map2c), red: c.red, green: c.green, blue: c.blue,
      bgLutLo: c.bgLutLo, bgLutHi: c.bgLutHi, spLutLo: c.spLutLo, spLutHi: c.spLutHi, wave: c.wave,
    }),
  },
  {
    Board: Berzerk,
    chips: [
      ['r0', 0x800, [/^1c-0/, /^rom0\.1c/]],
      ['r1', 0x800, [/^1d-1/, /^rom1\.1d/]],
      ['r2', 0x800, [/^3d-2/, /^rom2\.3d/]],
      ['r3', 0x800, [/^5d-3/, /^rom3\.5d/]],
      ['r4', 0x800, [/^6d-4/, /^rom4\.6d/]],
      ['r5', 0x800, [/^5c-5/, /^rom5\.5c/]],
    ],
    // 0800-0FFF is RAM; the program sits at 0000-07FF and 1000-37FF.
    assemble: (c) => ({ main: cat(c.r0, new Uint8Array(0x800), c.r1, c.r2, c.r3, c.r4, c.r5, new Uint8Array(0x800).fill(0xFF)) }),
  },
  {
    Board: Frenzy,
    chips: [
      ['r0', 0x1000, [/^1c-0/]],
      ['r1', 0x1000, [/^1d-1/]],
      ['r2', 0x1000, [/^3d-2/]],
      ['r3', 0x1000, [/^5d-3/]],
      ['r4', 0x1000, [/^6d-4/]],
    ],
    assemble: (c) => ({ main: cat(c.r0, c.r1, c.r2, c.r3), high: c.r4 }),
  },
  {
    Board: SatansHollow,
    chips: [
      ...[0, 1, 2, 3, 4, 5].map((n) => [`main${n}`, 0x2000, [new RegExp(`^sh-pro\\.0${n}`)]]),
      ['sound0', 0x1000, [/^sh-snd\.01/, /^snd-0\.a7/]],
      ['sound1', 0x1000, [/^sh-snd\.02/, /^snd-1\.a8/]],
      ['sound2', 0x1000, [/^sh-snd\.03/, /^snd-2\.a9/]],
      ['bg0', 0x2000, [/^sh-bg\.00/]],
      ['bg1', 0x2000, [/^sh-bg\.01/]],
      ...[0, 1, 2, 3].map((n) => [`fg${n}`, 0x2000, [new RegExp(`^sh-fg\\.0${n}`)]]),
      ['prom', 0x20, [/^82s123/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3, c.main4, c.main5), sound: cat(c.sound0, c.sound1, c.sound2),
      bg: cat(c.bg0, c.bg1), fg: cat(c.fg0, c.fg1, c.fg2, c.fg3), prom: c.prom,
    }),
  },
  {
    Board: Tron,
    chips: [
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((n) => [`main_${n}`, 0x2000, [new RegExp(`^scpu_pg${n}`)]]),
      ['sound0', 0x1000, [/^ssi_0a/]],
      ['sound1', 0x1000, [/^ssi_0b/]],
      ['sound2', 0x1000, [/^ssi_0c/]],
      ['bg0', 0x2000, [/^scpu_bgg/]],
      ['bg1', 0x2000, [/^scpu_bgh/]],
      ...[3, 2, 1, 0].map((n) => [`fg${n}`, 0x2000, [new RegExp(`^vg_${n}\\.`)]]),
      ['prom', 0x20, [/^82s123/]],
    ],
    assemble: (c) => ({
      main: cat(c.main_a, c.main_b, c.main_c, c.main_d, c.main_e, c.main_f), sound: cat(c.sound0, c.sound1, c.sound2),
      bg: cat(c.bg0, c.bg1), fg: cat(c.fg3, c.fg2, c.fg1, c.fg0), prom: c.prom,
    }),
  },
  {
    Board: Tapper,
    chips: [
      ['main0', 0x4000, [/^tappg0/]],
      ['main1', 0x4000, [/^tappg1/]],
      ['main2', 0x4000, [/^tappg2/]],
      ['main3', 0x2000, [/^tappg3/]],
      ['sound0', 0x1000, [/^tapsnda7/]],
      ['sound1', 0x1000, [/^tapsnda8/]],
      ['sound2', 0x1000, [/^tapsnda9/]],
      ['sound3', 0x1000, [/^tapsda10/]],
      ['bg0', 0x4000, [/^tapbg0/]],
      ['bg1', 0x4000, [/^tapbg1/]],
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => [`fg${n}`, 0x4000, [new RegExp(`^tapfg${n}`)]]),
      ['prom', 0x20, [/^5784$/, /^82s123/]],
    ],
    // The graphics chips are wired in pairs, the odd-numbered one first.
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3), sound: cat(c.sound0, c.sound1, c.sound2, c.sound3),
      bg: cat(c.bg1, c.bg0), fg: cat(c.fg1, c.fg0, c.fg3, c.fg2, c.fg5, c.fg4, c.fg7, c.fg6), prom: c.prom,
    }),
  },
];

function swap01(rom) {
  return rom.map((v) => (v & 0xFC) | ((v & 1) << 1) | ((v >> 1) & 1));
}

function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// files: { lowercase name -> Uint8Array }. Returns { Board, roms } for the
// first board whose chips are all present, or throws.
export function identify(files) {
  const names = Object.keys(files);
  for (const { Board, chips, assemble } of BOARDS) {
    const found = {};
    for (const [role, size, patterns] of chips) {
      const name = names.find((n) => files[n].length === size && patterns.some((p) => p.test(n)));
      if (!name) break;
      found[role] = files[name];
    }
    if (Object.keys(found).length === chips.length) return { Board, roms: assemble(found) };
  }
  throw new Error(`this isn't a supported ROM set (${BOARDS.map((b) => b.Board.title).join(', ')})`);
}

export const SUPPORTED = BOARDS.map((b) => b.Board.title);
