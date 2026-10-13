// The boards z80js emulates, and how to recognize each one's ROM set.
//
// A ROM set is a zip of the board's individual chips. Sets have been dumped
// under several naming schemes over the years, so each chip is recognized by
// any of its known names (board location or part number) and its size.
//
// Every board class exposes the same interface:
//   width, height        picture size as displayed (rotated for vertical monitors)
//   aspect               (optional) display width / height, for pixels that aren't square
//   frame                Uint32Array of RGBA pixels, updated each frame
//   refresh              frames per second
//   controls             'two-way' (left/right), 'four-way' or 'eight-way'
//   buttons              number of fire buttons (0-3; button2 and button3 name the second and third)
//   dialControl          true if the game has a spinner (read as `spin`); dialHint
//                        optionally names it for the touch hint [title, text]
//   sound                sample source: buffer/readPos/writePos/available()/pull(), rate
//   runFrame(), reset()
//   setInputs({ left, right, up, down, fire, fire2, fire3, spin, coin, start1, start2 })
//   applySwitches({ id: value }) with the options listed in Board.switches
//   Board.stateVersion   (optional) bumped when older saved states no longer restore correctly

import { Galaga } from './galaga.js';
import { PacMan, MsPacMan, JrPacMan, Piranha, CrushRoller, PuckMan, PacManPlus } from './pacman.js';
import { Galaxian, MoonCresta } from './galaxian.js';
import { DonkeyKong, DonkeyKongJr } from './dkong.js';
import { Frogger } from './frogger.js';
import { Scramble, Amidar, SuperCobra } from './scramble.js';
import { DigDug } from './digdug.js';
import { TimePilot, Pooyan } from './timeplt.js';
import { MrDo } from './mrdo.js';
import { SatansHollow, Tron, Tapper, Kick, DominoMan } from './mcr.js';
import { Bosconian, Xevious, SuperXevious } from './bosco.js';
import { Berzerk, Frenzy } from './berzerk.js';
import { RallyX, NewRallyX } from './rallyx.js';
import { WarpWarp } from './warpwarp.js';
import { Mappy, DigDug2, Motos, Druaga } from './mappy.js';
import { Centipede } from './centiped.js';
import { Phoenix } from './phoenix.js';
import { SpaceInvaders } from './invaders.js';
import { LadyBug } from './ladybug.js';
import { C1942 } from './c1942.js';
import { DoCastle, DoRunRun, DoWildRide } from './docastle.js';
import { Popeye } from './popeye.js';
import { Pengo } from './pengo.js';
import { BombJack } from './bombjack.js';
import { MarioBros } from './mario.js';
import { MoonPatrol } from './mpatrol.js';
import { Zaxxon } from './zaxxon.js';
import { GhostsNGoblins } from './gng.js';
import { Asteroids } from './asteroids.js';
import { Tempest } from './tempest.js';
import { Battlezone } from './bzone.js';
import { StarWars } from './starwars.js';
import { TailGunner } from './tailg.js';
import { RushNAttack, GreenBeretJ, MrGoemon } from './gberet.js';
import { YieArKungFu } from './yiear.js';
import { MetalSlug, MetalSlug2, MetalSlugX } from './neogeo.js';
import { Strider, Mercs, FinalFight, StreetFighter2, GhoulsNGhosts, ForgottenWorlds, Game1941, Knights, CaptainCommando } from './cps1.js';
import { Gorf, WizardOfWor, RobbyRoto, SpaceZap, ExtraBases, SeaWolf2 } from './astrocade.js';
import { Robotron, Joust, Bubbles, Splat, Stargate, Defender, Sinistar } from './williams.js';

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
      ['main0', 0x1000, [/^pacman\.6e/]],
      ['main1', 0x1000, [/^pacman\.6f/]],
      ['main2', 0x1000, [/^pacman\.6h/]],
      ['main3', 0x1000, [/^pacman\.6j/]],
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
    Board: Piranha,
    chips: [
      ...[1, 5, 2, 6, 3, 7, 4, 8].map((n, i) => [`main${i}`, 0x800, [new RegExp(`^pir${n}\\.bin$`)]]),
      ['t0', 0x800, [/^pir9\.bin$/]],
      ['t1', 0x800, [/^pir11\.bin$/]],
      ['s0', 0x800, [/^pir10\.bin$/]],
      ['s1', 0x800, [/^pir12\.bin$/]],
      ['palette', 0x20, [/^82s123\.7f$/]],
      ['lut', 0x100, [/^piranha\.4a$/]],
      ['wave', 0x100, [/^82s126\.1m$/]],
    ],
    assemble: (c) => ({
      main: cat(...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => c[`main${n}`])), tiles: cat(c.t0, c.t1), sprites: cat(c.s0, c.s1),
      palette: c.palette, lut: c.lut, wave: c.wave,
    }),
  },
  {
    Board: CrushRoller,
    chips: [
      ['main0', 0x1000, [/^crushkrl\.6e$/]],
      ['main1', 0x1000, [/^crushkrl\.6f$/]],
      ['main2', 0x1000, [/^crushkrl\.6h$/]],
      ['main3', 0x1000, [/^crushkrl\.6j$/]],
      ['tiles', 0x1000, [/^maketrax\.5e$/]],
      ['sprites', 0x1000, [/^maketrax\.5f$/]],
      ['palette', 0x20, [/^82s123\.7f$/]],
      ['lut', 0x100, [/^2s140\.4a$/]],
      ['wave', 0x100, [/^82s126\.1m$/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3), tiles: c.tiles, sprites: c.sprites, palette: c.palette, lut: c.lut, wave: c.wave,
    }),
  },
  {
    Board: PuckMan,
    chips: [
      ['main0', 0x1000, [/^namcopac\.6e$/]],
      ['main1', 0x1000, [/^namcopac\.6f$/]],
      ['main2', 0x1000, [/^namcopac\.6h$/]],
      ['main3', 0x1000, [/^namcopac\.6j$/]],
      ['tiles', 0x1000, [/^pacman\.5e$/]],
      ['sprites', 0x1000, [/^pacman\.5f$/]],
      ['palette', 0x20, [/^82s123\.7f$/]],
      ['lut', 0x100, [/^82s126\.4a$/]],
      ['wave', 0x100, [/^82s126\.1m$/]],
    ],
    assemble: (c) => ({ main: cat(c.main0, c.main1, c.main2, c.main3), tiles: c.tiles, sprites: c.sprites, palette: c.palette, lut: c.lut, wave: c.wave }),
  },
  {
    Board: PacManPlus,
    chips: [
      ['main0', 0x1000, [/^pacplus\.6e$/]],
      ['main1', 0x1000, [/^pacplus\.6f$/]],
      ['main2', 0x1000, [/^pacplus\.6h$/]],
      ['main3', 0x1000, [/^pacplus\.6j$/]],
      ['tiles', 0x1000, [/^pacplus\.5e$/]],
      ['sprites', 0x1000, [/^pacplus\.5f$/]],
      ['palette', 0x20, [/^pacplus\.7f$/]],
      ['lut', 0x100, [/^pacplus\.4a$/]],
      ['wave', 0x100, [/^82s126\.1m$/]],
    ],
    assemble: (c) => ({ main: cat(c.main0, c.main1, c.main2, c.main3), tiles: c.tiles, sprites: c.sprites, palette: c.palette, lut: c.lut, wave: c.wave }),
  },
  {
    Board: SpaceInvaders,
    chips: [
      ['h', 0x800, [/^invaders\.h$/]],
      ['g', 0x800, [/^invaders\.g$/]],
      ['f', 0x800, [/^invaders\.f$/]],
      ['e', 0x800, [/^invaders\.e$/]],
    ],
    assemble: (c) => ({ main: cat(c.h, c.g, c.f, c.e) }),
  },
  {
    Board: LadyBug,
    chips: [
      ...[1, 2, 3, 4, 5, 6].map((n) => [`main${n}`, 0x1000, [new RegExp(`^lb${n}\\.cpu$`)]]),
      ['chars0', 0x1000, [/^lb9\.vid$/]],
      ['chars1', 0x1000, [/^lb10\.vid$/]],
      ['sprites0', 0x1000, [/^lb8\.cpu$/]],
      ['sprites1', 0x1000, [/^lb7\.cpu$/]],
      ['palette', 0x20, [/^10-2\.vid$/]],
      ['spriteLut', 0x20, [/^10-1\.vid$/]],
    ],
    assemble: (c) => ({
      main: cat(c.main1, c.main2, c.main3, c.main4, c.main5, c.main6),
      chars: cat(c.chars0, c.chars1), sprites: cat(c.sprites0, c.sprites1), palette: c.palette, spriteLut: c.spriteLut,
    }),
  },
  {
    Board: C1942,
    chips: [
      ['n3', 0x4000, [/^1-n3a?\.bin$/]],
      ['n4', 0x4000, [/^1-n4\.bin$/]],
      ['n5', 0x4000, [/^1-n5\.bin$/]],
      ['n6', 0x2000, [/^1-n6\.bin$/]],
      ['n7', 0x4000, [/^1-n7\.bin$/]],
      ['sound', 0x4000, [/^1-c11\.bin$/]],
      ['chars', 0x2000, [/^1-f2\.bin$/]],
      ...[1, 2, 3, 4, 5, 6].map((n) => [`a${n}`, 0x2000, [new RegExp(`^2-a${n}\\.bin$`)]]),
      ['l1', 0x4000, [/^2-l1\.bin$/]],
      ['l2', 0x4000, [/^2-l2\.bin$/]],
      ['n1', 0x4000, [/^2-n1\.bin$/]],
      ['n2', 0x4000, [/^2-n2\.bin$/]],
      ['red', 0x100, [/^08e_sb-5\.bin$/]],
      ['green', 0x100, [/^09e_sb-6\.bin$/]],
      ['blue', 0x100, [/^10e_sb-7\.bin$/]],
      ['charLut', 0x100, [/^f01_sb-0\.bin$/]],
      ['tileLut', 0x100, [/^06d_sb-4\.bin$/]],
      ['spriteLut', 0x100, [/^03k_sb-8\.bin$/]],
    ],
    assemble: (c) => ({
      main: cat(c.n3, c.n4), banks: cat(c.n5, c.n6, new Uint8Array(0x2000).fill(0xFF), c.n7), sound: c.sound, chars: c.chars,
      tiles: cat(c.a1, c.a2, c.a3, c.a4, c.a5, c.a6), sprites: cat(c.l1, c.l2, c.n1, c.n2),
      red: c.red, green: c.green, blue: c.blue, charLut: c.charLut, tileLut: c.tileLut, spriteLut: c.spriteLut,
    }),
  },
  {
    Board: DoCastle,
    chips: [
      ['a1', 0x2000, [/^01p_a1\.bin$/]],
      ['a2', 0x2000, [/^01n_a2\.bin$/]],
      ['a3', 0x2000, [/^01l_a3\.bin$/]],
      ['a4', 0x2000, [/^01k_a4\.bin$/]],
      ['sub', 0x4000, [/^07n_a0\.bin$/]],
      ['chars', 0x4000, [/^03a_a5\.bin$/]],
      ['a6', 0x2000, [/^04m_a6\.bin$/]],
      ['a7', 0x2000, [/^04l_a7\.bin$/]],
      ['a8', 0x2000, [/^04j_a8\.bin$/]],
      ['a9', 0x2000, [/^04h_a9\.bin$/]],
      ['palette', 0x200, [/^09c\.bin$/]],
    ],
    assemble: (c) => ({
      main: cat(c.a1, c.a2, c.a3, c.a4), sub: c.sub, chars: c.chars, sprites: cat(c.a6, c.a7, c.a8, c.a9), palette: c.palette.subarray(0, 0x100),
    }),
  },
  {
    Board: DoRunRun,
    chips: [
      ['p1', 0x2000, [/^2764\.p1$/]],
      ['l1', 0x2000, [/^2764\.l1$/]],
      ['k1', 0x2000, [/^2764\.k1$/]],
      ['n1', 0x2000, [/^2764\.n1$/]],
      ['sub', 0x4000, [/^27128\.p7$/]],
      ['chars', 0x4000, [/^27128\.a3$/]],
      ['m4', 0x2000, [/^2764\.m4$/]],
      ['l4', 0x2000, [/^2764\.l4$/]],
      ['j4', 0x2000, [/^2764\.j4$/]],
      ['h4', 0x2000, [/^2764\.h4$/]],
      ['palette', 0x100, [/^dorunrun\.clr$/]],
    ],
    assemble: (c) => {
      const main = new Uint8Array(0xA000);         // 0000-1FFF and 4000-9FFF
      main.set(c.p1, 0); main.set(c.l1, 0x4000); main.set(c.k1, 0x6000); main.set(c.n1, 0x8000);
      return { main, sub: c.sub, chars: c.chars, sprites: cat(c.m4, c.l4, c.j4, c.h4), palette: c.palette };
    },
  },
  {
    Board: DoWildRide,
    chips: [
      ...['w1', 'w3', 'w4', 'w2', 'w6', 'w7', 'w8', 'w9'].map((n) => [n, 0x2000, [new RegExp(`^${n}$`)]]),
      ['sub', 0x4000, [/^w10$/]],
      ['chars', 0x4000, [/^w5$/]],
      ['palette', 0x100, [/^dowild\.clr$/]],
    ],
    assemble: (c) => {
      const main = new Uint8Array(0xA000);         // 0000-1FFF and 4000-9FFF
      main.set(c.w1, 0); main.set(c.w3, 0x4000); main.set(c.w4, 0x6000); main.set(c.w2, 0x8000);
      return { main, sub: c.sub, chars: c.chars, sprites: cat(c.w6, c.w7, c.w8, c.w9), palette: c.palette };
    },
  },
  {
    Board: Popeye,
    chips: [
      ['a', 0x2000, [/^c-7a$/]],
      ['b', 0x2000, [/^c-7b$/]],
      ['c', 0x2000, [/^c-7c$/]],
      ['e', 0x2000, [/^c-7e$/]],
      ['chars', 0x1000, [/^v-5n$/]],
      ['s1e', 0x2000, [/^v-1e$/]],
      ['s1f', 0x2000, [/^v-1f$/]],
      ['s1j', 0x2000, [/^v-1j$/]],
      ['s1k', 0x2000, [/^v-1k$/]],
      ['bgPal', 0x20, [/^prom-cpu\.4a$/]],
      ['charPal', 0x20, [/^prom-cpu\.3a$/]],
      ['spriteLo', 0x100, [/^prom-cpu\.5b$/]],
      ['spriteHi', 0x100, [/^prom-cpu\.5a$/]],
    ],
    assemble: (c) => ({
      main: cat(c.a, c.b, c.c, c.e), chars: c.chars.subarray(0x800), sprites: cat(c.s1e, c.s1f, c.s1j, c.s1k),
      bgPal: c.bgPal, charPal: c.charPal, spriteLo: c.spriteLo, spriteHi: c.spriteHi,
    }),
  },
  {
    Board: Pengo,
    chips: [
      ...['ep1689c.8', 'ep1690b.7', 'ep1691b.15', 'ep1692b.14', 'ep1693b.21', 'ep1694b.20', 'ep5118b.32', 'ep5119c.31']
        .map((n, i) => [`main${i}`, 0x1000, [new RegExp(`^${n.replace('.', '\\.')}$`)]]),
      ['gfx0', 0x2000, [/^ep1640\.92$/]],
      ['gfx1', 0x2000, [/^ep1695\.105$/]],
      ['palette', 0x20, [/^pr1633\.78$/]],
      ['lut', 0x400, [/^pr1634\.88$/]],
      ['wave', 0x100, [/^pr1635\.51$/]],
    ],
    assemble: (c) => ({
      main: cat(...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => c[`main${i}`])),
      // Each graphics ROM holds a bank of tiles, then a bank of sprites.
      tiles: cat(c.gfx0.subarray(0, 0x1000), c.gfx1.subarray(0, 0x1000)),
      sprites: cat(c.gfx0.subarray(0x1000), c.gfx1.subarray(0x1000)),
      palette: c.palette, lut: c.lut, wave: c.wave,
    }),
  },
  {
    Board: BombJack,
    chips: [
      ['m09', 0x2000, [/^09_j01b\.bin$/]],
      ['m10', 0x2000, [/^10_l01b\.bin$/]],
      ['m11', 0x2000, [/^11_m01b\.bin$/]],
      ['m12', 0x2000, [/^12_n01b\.bin$/]],
      ['m13', 0x2000, [/^13\.1r$/, /^13_r01b\.bin$/]],
      ['sound', 0x2000, [/^01_h03t\.bin$/]],
      ['c03', 0x1000, [/^03_e08t\.bin$/]],
      ['c04', 0x1000, [/^04_h08t\.bin$/]],
      ['c05', 0x1000, [/^05_k08t\.bin$/]],
      ['t06', 0x2000, [/^06_l08t\.bin$/]],
      ['t07', 0x2000, [/^07_n08t\.bin$/]],
      ['t08', 0x2000, [/^08_r08t\.bin$/]],
      ['s16', 0x2000, [/^16_m07b\.bin$/]],
      ['s15', 0x2000, [/^15_l07b\.bin$/]],
      ['s14', 0x2000, [/^14_j07b\.bin$/]],
      ['map', 0x1000, [/^02_p04t\.bin$/]],
    ],
    assemble: (c) => ({
      main: cat(c.m09, c.m10, c.m11, c.m12, c.m13), sound: c.sound, chars: cat(c.c03, c.c04, c.c05),
      tiles: cat(c.t06, c.t07, c.t08), sprites: cat(c.s16, c.s15, c.s14), map: c.map,
    }),
  },
  {
    Board: MarioBros,
    chips: [
      ['f', 0x2000, [/^mario\.7f$/, /^tma1-c\.7f/]],
      ['e', 0x2000, [/^mario\.7e$/, /^tma1-c\.7e/]],
      ['d', 0x2000, [/^mario\.7d$/, /^tma1-c\.7d/]],
      ['c', 0x1000, [/^mario\.7c$/, /^tma1-c\.7c/]],
      ['sound', 0x1000, [/^tma1c-a\.6k$/]],
      ['c3f', 0x1000, [/^mario\.3f$/]],
      ['c3j', 0x1000, [/^mario\.3j$/]],
      ...['7m', '7n', '7p', '7s', '7t', '7u'].map((n) => [`s${n}`, 0x1000, [new RegExp(`^(mario|tma1-v)\\.${n}$`)]]),
      ['palette', 0x200, [/^mario\.4p$/]],
    ],
    assemble: (c) => ({
      main: cat(c.f, c.e, c.d, new Uint8Array(0x3000), c.c), sound: c.sound, chars: cat(c.c3f, c.c3j),
      sprites: cat(c.s7m, c.s7n, c.s7p, c.s7s, c.s7t, c.s7u), palette: c.palette,
    }),
  },
  {
    Board: MoonPatrol,
    chips: [
      ['m', 0x1000, [/^mp-?a-?1?\.3m$/, /^mpa-1\.3m$/]],
      ['l', 0x1000, [/^mp-?a-?2?\.3l$/, /^mpa-2\.3l$/]],
      ['k', 0x1000, [/^mp-?a-?3?\.3k$/, /^mpa-3\.3k$/]],
      ['j', 0x1000, [/^mp-?a-?4?\.3j$/, /^mpa-4\.3j$/]],
      ['sound', 0x1000, [/^mp-snd\.1a$/, /^mp-s1\.1a$/]],
      ['c3e', 0x1000, [/^mp-?e-?5?\.3e$/]],
      ['c3f', 0x1000, [/^mp-?e-?4?\.3f$/]],
      ['s3m', 0x1000, [/^mp-?b-?2?\.3m$/]],
      ['s3n', 0x1000, [/^mp-?b-?1?\.3n$/]],
      ['bg3l', 0x1000, [/^mp-?e-?1?\.3l$/]],
      ['bg3k', 0x1000, [/^mp-?e-?2?\.3k$/]],
      ['bg3h', 0x1000, [/^mp-?e-?3?\.3h$/]],
      ['charPal', 0x100, [/^2a$/, /^mpc-4\.2a$/]],
      ['bgPal', 0x20, [/^1m$/, /^mpc-3\.1m$/]],
      ['spritePal', 0x20, [/^1c1j$/, /^mpc-1\.1f$/]],
      ['spriteLut', 0x100, [/^2hx$/, /^mpc-2\.2h$/]],
    ],
    assemble: (c) => ({
      main: cat(c.m, c.l, c.k, c.j), sound: c.sound, chars: cat(c.c3e, c.c3f), sprites: cat(c.s3m, c.s3n),
      mountains: c.bg3l, hills: c.bg3k, city: c.bg3h,
      charPal: c.charPal, bgPal: c.bgPal, spritePal: c.spritePal, spriteLut: c.spriteLut,
    }),
  },
  {
    Board: Joust,
    chips: [
      ...['a', 'b', 'c'].map((n) => [`top${n}`, 0x1000, [new RegExp(`^joust\\.wg${n}$`)]]),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`bank${n}`, 0x1000, [new RegExp(`^joust\\.wg${n}$`)]]),
      ['sound', 0x1000, [/^joust\.snd$/]],
    ],
    assemble: (c) => ({
      main: cat(c.topa, c.topb, c.topc), sound: c.sound,
      banked: cat(...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => c[`bank${n}`])),
    }),
  },
  {
    Board: Robotron,
    chips: [
      ...['a', 'b', 'c'].map((n) => [`top${n}`, 0x1000, [new RegExp(`^robotron\\.sb${n}$`)]]),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`bank${n}`, 0x1000, [new RegExp(`^robotron\\.sb${n}$`)]]),
      ['sound', 0x1000, [/^robotron\.snd$/]],
    ],
    assemble: (c) => ({
      main: cat(c.topa, c.topb, c.topc), sound: c.sound,
      banked: cat(...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => c[`bank${n}`])),
    }),
  },
  {
    Board: Bubbles,
    chips: [
      ...['10', '11', '12'].map((n, i) => [`top${i}`, 0x1000, [new RegExp(`^bubbles\\.${n}b$`)]]),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`bank${n}`, 0x1000, [new RegExp(`^bubbles\\.${n}b$`)]]),
      ['sound', 0x1000, [/^bubbles\.snd$/]],
    ],
    assemble: (c) => ({
      main: cat(c.top0, c.top1, c.top2), sound: c.sound,
      banked: cat(...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => c[`bank${n}`])),
    }),
  },
  {
    Board: Splat,
    chips: [
      ...['10', '11', '12'].map((n, i) => [`top${i}`, 0x1000, [new RegExp(`^splat\\.${n}$`)]]),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`bank${n}`, 0x1000, [new RegExp(`^splat\\.0${n}$`)]]),
      ['sound', 0x1000, [/^splat\.snd$/]],
    ],
    assemble: (c) => ({
      main: cat(c.top0, c.top1, c.top2), sound: c.sound,
      banked: cat(...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => c[`bank${n}`])),
    }),
  },
  {
    Board: Stargate,
    chips: [
      ...['10', '11', '12'].map((n, i) => [`top${i}`, 0x1000, [new RegExp(`^${n}$`)]]),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`bank${n}`, 0x1000, [new RegExp(`^0${n}$`)]]),
      ['sound', 0x800, [/^sg\.snd$/]],
    ],
    assemble: (c) => ({
      main: cat(c.top0, c.top1, c.top2), sound: cat(c.sound, c.sound),
      banked: cat(...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => c[`bank${n}`])),
    }),
  },
  {
    Board: Defender,
    chips: [
      ...[1, 4, 2, 3, 9, 12, 8, 11, 7, 10, 6].map((n) => [`d${n}`, n === 2 || n === 3 ? 0x1000 : 0x800, [new RegExp(`^defend\\.${n}$`)]]),
      ['sound', 0x800, [/^defend\.snd$/]],
    ],
    assemble: (c) => {
      const banked = new Uint8Array(0x9000).fill(0xFF);
      [[9, 0], [12, 0x800], [8, 0x1000], [11, 0x1800], [7, 0x2000], [10, 0x2800], [6, 0x6000]].forEach(([n, o]) => banked.set(c[`d${n}`], o));
      return { main: cat(c.d1, c.d4, c.d2, c.d3), sound: cat(c.sound, c.sound), banked };
    },
  },
  {
    Board: Sinistar,
    chips: [
      ['top10', 0x1000, [/^sinistar\.10$/]],
      ['top11', 0x1000, [/^sinistar\.11$/]],
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`bank${n}`, 0x1000, [new RegExp(`^sinistar\\.0${n}$`)]]),
      ['ic7', 0x1000, [/^speech\.ic7$/]],
      ['ic5', 0x1000, [/^speech\.ic5$/]],
      ['ic6', 0x1000, [/^speech\.ic6$/]],
      ['ic4', 0x1000, [/^speech\.ic4$/]],
      ['snd', 0x1000, [/^sinistar\.snd$/]],
    ],
    assemble: (c) => ({
      main: cat(new Uint8Array(0x1000), c.top10, c.top11),
      banked: cat(...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => c[`bank${n}`])),
      sound: cat(c.ic7, c.ic5, c.ic6, c.ic4, c.snd),          // B000-FFFF
    }),
  },
  {
    Board: Zaxxon,
    chips: [
      ...[[3, 0x2000], [2, 0x2000], [1, 0x1000], [14, 0x800], [15, 0x800], [6, 0x2000], [5, 0x2000], [4, 0x2000],
        [11, 0x2000], [12, 0x2000], [13, 0x2000], [8, 0x2000], [7, 0x2000], [10, 0x2000], [9, 0x2000]]
        .map(([n, size]) => [`z${n}`, size, [new RegExp(`^zaxxon\\.${n}$`), new RegExp(`^zaxxon${n}\\.u`)]]),
      ['palette', 0x100, [/^zaxxon\.u98$/]],
      ['colors', 0x100, [/^zaxxon\.u72$/]],
    ],
    assemble: (c) => ({
      main: cat(c.z3, c.z2, c.z1), chars: cat(c.z14, c.z15), tiles: cat(c.z6, c.z5, c.z4),
      sprites: cat(c.z11, c.z12, c.z13), map: cat(c.z8, c.z7, c.z10, c.z9), palette: c.palette, colors: c.colors,
    }),
  },
  {
    Board: GhostsNGoblins,
    chips: [
      ['gg4', 0x4000, [/^gg4\.bin$/]],
      ['gg3', 0x8000, [/^gg3\.bin$/]],
      ['gg5', 0x8000, [/^gg5\.bin$/]],
      ['sound', 0x8000, [/^gg2\.bin$/]],
      ['chars', 0x4000, [/^gg1\.bin$/]],
      ...[11, 10, 9, 8, 7, 6, 17, 16, 15, 14, 13, 12].map((n) => [`gg${n}`, 0x4000, [new RegExp(`^gg${n}\\.bin$`)]]),
    ],
    assemble: (c) => {
      const main = new Uint8Array(0x18000);
      main.set(c.gg4, 0x4000); main.set(c.gg3, 0x8000); main.set(c.gg5, 0x10000);
      const ff = new Uint8Array(0x4000).fill(0xFF);
      return {
        main, sound: c.sound, chars: c.chars, tiles: cat(c.gg11, c.gg10, c.gg9, c.gg8, c.gg7, c.gg6),
        sprites: cat(c.gg17, c.gg16, c.gg15, ff, c.gg14, c.gg13, c.gg12, ff),
      };
    },
  },
  {
    Board: SuperCobra,
    chips: [
      ['main0', 0x1000, [/^epr1265\.2c$/, /^scobra2c/]],
      ['main1', 0x1000, [/^2e$/, /^scobra2e/]],
      ['main2', 0x1000, [/^epr1267\.2f$/, /^scobra2f/]],
      ['main3', 0x1000, [/^2h$/, /^scobra2h/]],
      ['main4', 0x1000, [/^epr1269\.2j$/, /^scobra2j/]],
      ['main5', 0x1000, [/^2l$/, /^scobra2l/]],
      ['sound0', 0x800, [/^5c$/]],
      ['sound1', 0x800, [/^5d$/]],
      ['sound2', 0x800, [/^5e$/]],
      ['gfx0', 0x800, [/^epr1274\.5h$/]],
      ['gfx1', 0x800, [/^epr1273\.5f$/]],
      ['palette', 0x20, [/^82s123\.6e$/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3, c.main4, c.main5), sound: cat(c.sound0, c.sound1, c.sound2),
      gfx: cat(c.gfx0, c.gfx1), palette: c.palette,
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
    Board: SuperXevious,
    chips: [
      ['main0', 0x1000, [/^cpu_3p\.rom$/]],
      ['main1', 0x1000, [/^cpu_3m\.rom$/]],
      ['main2', 0x1000, [/^cpu_2m\.rom$/]],
      ['main3', 0x1000, [/^cpu_2l\.rom$/]],
      ['sub0', 0x1000, [/^cpu_3f\.rom$/]],
      ['sub1', 0x1000, [/^cpu_3j\.rom$/]],
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
    Board: RallyX,
    chips: [
      ['main0', 0x1000, [/^1b$/]],
      ['main1', 0x1000, [/^rallyxn\.1e$/, /^1e$/]],
      ['main2', 0x1000, [/^rallyxn\.1h$/, /^1h$/]],
      ['main3', 0x1000, [/^rallyxn\.1k$/, /^1k$/]],
      ['gfx', 0x1000, [/^8e$/]],
      ['dots', 0x100, [/^im5623\.8m$/, /^rx1-6\.8m$/]],
      ['palette', 0x20, [/^m3-7603\.11n$/, /^rx1-1\.11n$/]],
      ['lut', 0x100, [/^im5623\.8p$/, /^rx1-7\.8p$/]],
      ['wave', 0x100, [/^im5623\.3p$/, /^rx1-5\.3p$/]],
    ],
    assemble: (c) => ({ main: cat(c.main0, c.main1, c.main2, c.main3), gfx: c.gfx, dots: c.dots, palette: c.palette, lut: c.lut, wave: c.wave }),
  },
  {
    Board: NewRallyX,
    chips: [
      ['main0', 0x1000, [/^nrallyx\.1b$/, /^nrx_prg1\.1d$/]],
      ['main1', 0x1000, [/^nrallyx\.1e$/]],
      ['main2', 0x1000, [/^nrallyx\.1h$/]],
      ['main3', 0x1000, [/^nrallyx\.1k$/]],
      ['gfx', 0x1000, [/^nrallyx\.8e$/]],
      ['dots', 0x100, [/^im5623\.8m$/, /^rx1-6\.8m$/]],
      ['palette', 0x20, [/^nrallyx\.pr1$/, /^nrx1-1\.11n$/]],
      ['lut', 0x100, [/^nrallyx\.pr2$/, /^nrx1-7\.8p$/]],
      ['wave', 0x100, [/^nrallyx\.spr$/, /^rx1-5\.3p$/]],
    ],
    assemble: (c) => ({ main: cat(c.main0, c.main1, c.main2, c.main3), gfx: c.gfx, dots: c.dots, palette: c.palette, lut: c.lut, wave: c.wave }),
  },
  {
    Board: WarpWarp,
    chips: [
      ['r0', 0x1000, [/^g-n9601n\.2r$/, /^g-09601\.2r$/]],
      ['r1', 0x1000, [/^g-09602n\.2m$/, /^g-09602\.2m$/]],
      ['r2', 0x1000, [/^g-09603n\.1p$/, /^g-09603\.1p$/]],
      ['r3', 0x800, [/^g-09613n\.1t$/, /^g-09613\.1t$/]],
      ['chars', 0x800, [/^g-9611n\.4c$/, /^g-09611\.4c$/]],
    ],
    assemble: (c) => ({ main: cat(c.r0, c.r1, c.r2, c.r3), chars: c.chars }),
  },
  {
    Board: Mappy,
    chips: [
      ['m3', 0x2000, [/^mpx_3\.1d$/, /^mp1_3\.1d$/]],
      ['m2', 0x2000, [/^mp1_2\.1c$/]],
      ['m1', 0x2000, [/^mpx_1\.1b$/, /^mp1_1\.1b$/]],
      ['sub', 0x2000, [/^mp1_4\.1k$/]],
      ['chars', 0x1000, [/^mp1_5\.3b$/]],
      ['s0', 0x2000, [/^mp1_6\.3m$/]],
      ['s1', 0x2000, [/^mp1_7\.3n$/]],
      ['palette', 0x20, [/^mp1-5\.5b$/]],
      ['charLut', 0x100, [/^mp1-6\.4c$/]],
      ['spriteLut', 0x100, [/^mp1-7\.5k$/]],
      ['wave', 0x100, [/^mp1-3\.3m$/]],
    ],
    assemble: (c) => ({
      main: cat(c.m3, c.m2, c.m1), sub: c.sub, chars: c.chars, sprites: cat(c.s0, c.s1),
      palette: c.palette, charLut: c.charLut, spriteLut: c.spriteLut, wave: c.wave,
    }),
  },
  {
    Board: DigDug2,
    chips: [
      ['m3', 0x4000, [/^d23_3\.1d$/]],
      ['m1', 0x4000, [/^d23_1\.1b$/]],
      ['sub', 0x2000, [/^d21_4\.1k$/]],
      ['chars', 0x1000, [/^d21_5\.3b$/]],
      ['s0', null, [/^d21_6\.3m$/]],
      ['s1', null, [/^d21_7\.3n$/]],
      ['palette', 0x20, [/^d21-5\.5b$/]],
      ['charLut', 0x100, [/^d21-6\.4c$/]],
      ['spriteLut', 0x100, [/^d21-7\.5k$/]],
      ['wave', 0x100, [/^d21-3\.3m$/]],
    ],
    assemble: (c) => ({
      main: cat(c.m3, c.m1), sub: c.sub, chars: c.chars, sprites: cat(c.s0, c.s1),
      palette: c.palette, charLut: c.charLut, spriteLut: c.spriteLut, wave: c.wave,
    }),
  },
  {
    Board: Motos,
    chips: [
      ['m3', 0x4000, [/^mo1_3\.1d$/]],
      ['m1', 0x4000, [/^mo1_1\.1b$/]],
      ['sub', 0x2000, [/^mo1_4\.1k$/]],
      ['chars', 0x1000, [/^mo1_5\.3b$/]],
      ['s0', null, [/^mo1_6\.3m$/]],
      ['s1', null, [/^mo1_7\.3n$/]],
      ['palette', 0x20, [/^mo1-5\.5b$/]],
      ['charLut', 0x100, [/^mo1-6\.4c$/]],
      ['spriteLut', 0x100, [/^mo1-7\.5k$/]],
      ['wave', 0x100, [/^mo1-3\.3m$/]],
    ],
    assemble: (c) => ({
      main: cat(c.m3, c.m1), sub: c.sub, chars: c.chars, sprites: cat(c.s0, c.s1),
      palette: c.palette, charLut: c.charLut, spriteLut: c.spriteLut, wave: c.wave,
    }),
  },
  {
    Board: Druaga,
    chips: [
      ['m3', 0x4000, [/^td2_3\.1d$/]],
      ['m1', 0x4000, [/^td2_1\.1b$/]],
      ['sub', 0x2000, [/^td1_4\.1k$/]],
      ['chars', 0x1000, [/^td1_5\.3b$/]],
      ['s0', null, [/^td1_6\.3m$/]],
      ['s1', null, [/^td1_7\.3n$/]],
      ['palette', 0x20, [/^td1-5\.5b$/]],
      ['charLut', 0x100, [/^td1-6\.4c$/]],
      ['spriteLut', 0x400, [/^td1-7\.5k$/]],
      ['wave', 0x100, [/^td1-3\.3m$/]],
    ],
    assemble: (c) => ({
      main: cat(c.m3, c.m1), sub: c.sub, chars: c.chars, sprites: cat(c.s0, c.s1),
      palette: c.palette, charLut: c.charLut, spriteLut: c.spriteLut, wave: c.wave,
    }),
  },
  {
    Board: Centipede,
    chips: [
      ['p0', 0x800, [/^centiped\.307$/, /^136001-307/]],
      ['p1', 0x800, [/^centiped\.308$/, /^136001-308/]],
      ['p2', 0x800, [/^centiped\.309$/, /^136001-309/]],
      ['p3', 0x800, [/^centiped\.310$/, /^136001-310/]],
      ['g0', 0x800, [/^centiped\.211$/, /^136001-211/, /^136001-201/]],
      ['g1', 0x800, [/^centiped\.212$/, /^136001-212/, /^136001-202/]],
    ],
    assemble: (c) => ({ main: cat(c.p0, c.p1, c.p2, c.p3), gfx: cat(c.g0, c.g1) }),
  },
  {
    Board: Phoenix,
    chips: [
      ...[45, 46, 47, 48, 49, 50, 51, 52].map((n, i) => [`main${i}`, 0x800, [new RegExp(`^(h\\d-)?ic${n}(\\.\\d?a)?$`)]]),
      ['bg0', 0x800, [/^ic23(\.3d)?$/]],
      ['bg1', 0x800, [/^ic24(\.4d)?$/]],
      ['fg0', 0x800, [/^(b1-)?ic39(\.3b)?$/]],
      ['fg1', 0x800, [/^(b2-)?ic40(\.4b)?$/]],
      ['palLo', 0x100, [/^ic40_b\.bin$/, /^mmi6301\.ic40$/]],
      ['palHi', 0x100, [/^ic41_a\.bin$/, /^mmi6301\.ic41$/]],
    ],
    assemble: (c) => ({
      main: cat(...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => c[`main${n}`])), bg: cat(c.bg0, c.bg1), fg: cat(c.fg0, c.fg1),
      palLo: c.palLo, palHi: c.palHi,
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
    Board: Kick,
    chips: [
      ...['1200a', '1300b', '1400c', '1500d', '1600e', '1700f'].map((n, i) => [`main${i}`, 0x1000, [new RegExp(`^${n}`)]]),
      ...['4200-a', '4300-b', '4400-c', '4500-d'].map((n, i) => [`sound${i}`, 0x1000, [new RegExp(`^${n}`)]]),
      ['bg0', 0x1000, [/^1800g/]],
      ['bg1', 0x1000, [/^1900h/]],
      ...['2600a', '2700b', '2800c', '2900d'].map((n, i) => [`fg${i}`, 0x2000, [new RegExp(`^${n}`)]]),
      ['prom', 0x20, [/^82s123/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3, c.main4, c.main5), sound: cat(c.sound0, c.sound1, c.sound2, c.sound3),
      bg: cat(c.bg0, c.bg1), fg: cat(c.fg0, c.fg1, c.fg2, c.fg3), prom: c.prom,
    }),
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
    Board: DominoMan,
    chips: [
      ...[0, 1, 2, 3].map((n) => [`main${n}`, 0x2000, [new RegExp(`^dmanpg${n}\\.bin$`)]]),
      ...[7, 8, 9, 10].map((n) => [`sound${n}`, 0x1000, [new RegExp(`^dm-a${n}\\.snd$`)]]),
      ['bg0', 0x2000, [/^dmanbg0\.bin$/]],
      ['bg1', 0x2000, [/^dmanbg1\.bin$/]],
      ...[0, 1, 2, 3].map((n) => [`fg${n}`, 0x2000, [new RegExp(`^dmanfg${n}\\.bin$`)]]),
      ['prom', 0x20, [/^82s123/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3), sound: cat(c.sound7, c.sound8, c.sound9, c.sound10),
      bg: cat(c.bg0, c.bg1), fg: cat(c.fg0, c.fg1, c.fg2, c.fg3), prom: c.prom,
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
  {
    Board: Asteroids,
    chips: [
      ['p0', 0x800, [/^035145\.02$/]],
      ['p1', 0x800, [/^035144\.02$/]],
      ['p2', 0x800, [/^035143\.02$/]],
      ['vector', 0x800, [/^035127\.02$/]],
    ],
    assemble: (c) => ({ main: cat(c.p0, c.p1, c.p2), vector: c.vector }),
  },
  {
    Board: Tempest,
    chips: [
      ...['113', '114', '115', '316', '217', '118', '119', '120', '121', '222', '123', '124']
        .map((n) => [`t${n}`, 0x800, [new RegExp(`^136002[.-]${n}`)]]),
    ],
    assemble: (c) => ({
      main: cat(...['113', '114', '115', '316', '217', '118', '119', '120', '121', '222'].map((n) => c[`t${n}`])),
      vector: cat(c.t123, c.t124),
    }),
  },
  {
    Board: Battlezone,
    chips: ['414', '413', '412', '411', '410', '409', '422', '421']
      .map((n) => [`b${n}`, 0x800, [new RegExp(`^036${n}[.-]01`)]]),
    assemble: (c) => ({
      main: cat(...['414', '413', '412', '411', '410', '409'].map((n) => c[`b${n}`])),
      vector: cat(c.b422, c.b421),
    }),
  },
  {
    Board: StarWars,
    chips: [['105', 0x1000], ['214', 0x4000], ['102', 0x2000], ['203', 0x2000], ['104', 0x2000], ['206', 0x2000],
      ['107', 0x2000], ['208', 0x2000], ['110', 0x400], ['111', 0x400], ['112', 0x400], ['113', 0x400]]
      .map(([n, size]) => [`s${n}`, size, [new RegExp(`^136021[.-]${n}`)]]),
    assemble: (c) => ({
      main: cat(c.s102, c.s203, c.s104, c.s206), banked: c.s214, vector: c.s105,
      sound: cat(c.s107, c.s208), prom: cat(c.s110, c.s111, c.s112, c.s113),
    }),
  },
  {
    Board: TailGunner,
    chips: ['t70', 'p70', 't71', 'p71'].map((n) => [n, 0x800, [new RegExp(`^tgunner\\.${n}$`)]]),
    // Each 4K bank: the T ROM on even bytes, the P ROM on odd.
    assemble: (c) => ({ main: cat(interleave(c.t70, c.p70), interleave(c.t71, c.p71)) }),
  },
  {
    Board: RushNAttack,
    chips: [['h03', 0x4000], ['h02', 0x4000], ['h01', 0x4000], ['h07', 0x4000], ['l06', 0x4000], ['h05', 0x4000],
      ['l08', 0x4000], ['l04', 0x4000], ['h09', 0x20], ['h10', 0x100], ['h11', 0x100]]
      .map(([n, size]) => [n, size, [new RegExp(`^577${n}`)]]),
    assemble: (c) => ({
      main: cat(c.h03, c.h02, c.h01), chars: c.h07, sprites: cat(c.l06, c.h05, c.l08, c.l04),
      palette: c.h09, sprLut: c.h10, charLut: c.h11,
    }),
  },
  {
    Board: GreenBeretJ,
    chips: [['l03', 0x4000], ['l02', 0x4000], ['l01', 0x4000], ['l07', 0x4000], ['l06', 0x4000], ['l05', 0x4000],
      ['l08', 0x4000], ['l04', 0x4000], ['h09', 0x20], ['h10', 0x100], ['h11', 0x100]]
      .map(([n, size]) => [n, size, [new RegExp(`^577${n}`)]]),
    assemble: (c) => ({
      main: cat(c.l03, c.l02, c.l01), chars: c.l07, sprites: cat(c.l06, c.l05, c.l08, c.l04),
      palette: c.h09, sprLut: c.h10, charLut: c.h11,
    }),
  },
  {
    Board: MrGoemon,
    chips: [['d01', 0x8000], ['d02', 0x8000], ['a05', 0x4000], ['d03', 0x8000], ['d04', 0x8000], ['a06', 0x20], ['a07', 0x100], ['a08', 0x100]]
      .map(([n, size]) => [n, size, [new RegExp(`^621${n}`)]]),
    assemble: (c) => {
      // 0000-BFFF, then the banked 16K at 10000 (the second program ROM's upper half).
      const main = new Uint8Array(0x14000);
      main.set(c.d01, 0); main.set(c.d02.subarray(0, 0x4000), 0x8000); main.set(c.d02.subarray(0x4000), 0x10000);
      return { main, chars: c.a05, sprites: cat(c.d03, c.d04), palette: c.a06, sprLut: c.a07, charLut: c.a08 };
    },
  },
  {
    Board: YieArKungFu,
    chips: [['i08', 0x4000, [/^i08/]], ['i07', 0x4000, [/^i07/]], ['g16', 0x2000, [/^g16_1/]], ['g15', 0x2000, [/^g15_2/]],
      ['g04', 0x4000, [/^g04_5/]], ['g03', 0x4000, [/^g03_6/]], ['g06', 0x4000, [/^g06_3/]], ['g05', 0x4000, [/^g05_4/]],
      ['clr', 0x20, [/^yiear\.clr/]], ['speech', 0x2000, [/^a12_9/]]],
    assemble: (c) => ({
      main: cat(c.i08, c.i07), chars: cat(c.g16, c.g15), sprites: cat(c.g04, c.g03, c.g06, c.g05), palette: c.clr, speech: c.speech,
    }),
  },
  {
    Board: Gorf,
    chips: 'abcdefgh'.split('').map((l) => [l, 0x1000, [new RegExp(`^gorf-${l}`)]]),
    assemble: (c) => ({ main: place([[c.a, 0], [c.b, 0x1000], [c.c, 0x2000], [c.d, 0x3000], [c.e, 0x8000], [c.f, 0x9000], [c.g, 0xA000], [c.h, 0xB000]]) }),
  },
  {
    Board: WizardOfWor,
    chips: [1, 2, 3, 4, 5, 6, 7].map((n) => [`x${n}`, 0x1000, [new RegExp(`^wow\\.x${n}$`)]]),
    assemble: (c) => ({ main: place([[c.x1, 0], [c.x2, 0x1000], [c.x3, 0x2000], [c.x4, 0x3000], [c.x5, 0x8000], [c.x6, 0x9000], [c.x7, 0xA000]]) }),
  },
  {
    Board: RobbyRoto,
    chips: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [`x${n}`, 0x1000, [new RegExp(`^rotox${n}\\.`)]]),
    assemble: (c) => ({
      main: place([[c.x1, 0], [c.x2, 0x1000], [c.x3, 0x2000], [c.x4, 0x3000], [c.x5, 0x8000], [c.x6, 0x9000], [c.x7, 0xA000], [c.x8, 0xB000], [c.x9, 0xC000], [c.x10, 0xD000]]),
    }),
  },
  {
    Board: SpaceZap,
    chips: [['a', 0x1000, [/^0662/]], ['b', 0x1000, [/^0663/]], ['c', 0x1000, [/^0664/]], ['d', 0x1000, [/^0665/]]],
    assemble: (c) => ({ main: place([[c.a, 0], [c.b, 0x1000], [c.c, 0x2000], [c.d, 0x3000]]) }),
  },
  {
    Board: ExtraBases,
    chips: 'abcd'.split('').map((l) => [l, 0x1000, [new RegExp(`^m761${l}`)]]),
    assemble: (c) => ({ main: place([[c.a, 0], [c.b, 0x1000], [c.c, 0x2000], [c.d, 0x3000]]) }),
  },
  {
    Board: SeaWolf2,
    chips: [1, 2, 3, 4].map((n) => [`x${n}`, 0x800, [new RegExp(`^sw2x${n}`)]]),
    assemble: (c) => ({ main: place([[c.x1, 0], [c.x2, 0x800], [c.x3, 0x1000], [c.x4, 0x1800]]) }),
  },
  ...[
    // CPS-1. prog: [file, offset, kind] with kind 'even'/'odd' (byte-interleaved), 'swap' (byte-swapped
    // words) or 'word'; gfx: [file, offset, step] with step 2 (word groups) or 1 (single bytes) every 8.
    [Strider, ['strider.30', 0, 'even'], ['strider.35', 0, 'odd'], ['strider.31', 0x40000, 'even'], ['strider.36', 0x40000, 'odd'], ['strider.32', 0x80000, 'swap'],
      { size: 0x400000, files: [['strider.06', 0, 2], ['strider.08', 2, 2], ['strider.02', 4, 2], ['strider.04', 6, 2], ['strider.05', 0x200000, 2], ['strider.07', 0x200002, 2], ['strider.01', 0x200004, 2], ['strider.03', 0x200006, 2]] },
      'strider.09', ['strider.18', 'strider.19']],
    [Mercs, ['so2_30e', 0, 'even'], ['so2_35e', 0, 'odd'], ['so2_31e', 0x40000, 'even'], ['so2_36e', 0x40000, 'odd'], ['so2_32', 0x80000, 'swap'],
      { size: 0x300000, files: [['so2_gfx6', 0, 2], ['so2_gfx8', 2, 2], ['so2_gfx2', 4, 2], ['so2_gfx4', 6, 2],
        ['so2_24', 0x200000, 1], ['so2_14', 0x200001, 1], ['so2_26', 0x200002, 1], ['so2_16', 0x200003, 1], ['so2_20', 0x200004, 1], ['so2_10', 0x200005, 1], ['so2_22', 0x200006, 1], ['so2_12', 0x200007, 1]] },
      'so2_09', ['so2_18', 'so2_19']],
    [FinalFight, ['ff30-36', 0, 'even'], ['ff35-42', 0, 'odd'], ['ff31-37', 0x40000, 'even'], ['ff36-43', 0x40000, 'odd'], ['ff32-32m', 0x80000, 'swap'],
      { size: 0x200000, files: [['ff05-05m', 0, 2], ['ff07-07m', 2, 2], ['ff01-01m', 4, 2], ['ff03-03m', 6, 2]] },
      'ff09-09', ['ff18-18', 'ff19-19']],
    [StreetFighter2, ['sf2e.30g', 0, 'even'], ['sf2e.37g', 0, 'odd'], ['sf2e.31g', 0x40000, 'even'], ['sf2e.38g', 0x40000, 'odd'],
      ['sf2e.28g', 0x80000, 'even'], ['sf2e.35g', 0x80000, 'odd'], ['sf2_29a', 0xC0000, 'even'], ['sf2_36a', 0xC0000, 'odd'],
      { size: 0x600000, files: [['sf2_06', 0, 2], ['sf2_08', 2, 2], ['sf2_05', 4, 2], ['sf2_07', 6, 2], ['sf2_15', 0x200000, 2], ['sf2_17', 0x200002, 2],
        ['sf2_14', 0x200004, 2], ['sf2_16', 0x200006, 2], ['sf2_25', 0x400000, 2], ['sf2_27', 0x400002, 2], ['sf2_24', 0x400004, 2], ['sf2_26', 0x400006, 2]] },
      'sf2_09', ['sf2_18', 'sf2_19']],
    [GhoulsNGhosts, ['ghl29', 0, 'even'], ['ghl30', 0, 'odd'], ['ghl27', 0x40000, 'even'], ['ghl28', 0x40000, 'odd'], ['ghl17', 0x80000, 'word'],
      { size: 0x300000, files: [['ghl5', 0, 2], ['ghl7', 2, 2], ['ghl6', 4, 2], ['ghl8', 6, 2],
        ['ghl09', 0x200000, 1], ['ghl18', 0x200001, 1], ['ghl13', 0x200002, 1], ['ghl22', 0x200003, 1], ['ghl11', 0x200004, 1], ['ghl20', 0x200005, 1], ['ghl15', 0x200006, 1], ['ghl24', 0x200007, 1],
        ['ghl10', 0x280000, 1], ['ghl19', 0x280001, 1], ['ghl14', 0x280002, 1], ['ghl23', 0x280003, 1], ['ghl12', 0x280004, 1], ['ghl21', 0x280005, 1], ['ghl16', 0x280006, 1], ['ghl25', 0x280007, 1]] },
      'ghl26', null],
    [ForgottenWorlds, ['lwu11a', 0, 'even'], ['lwu15a', 0, 'odd'], ['lwu10a', 0x40000, 'even'], ['lwu14a', 0x40000, 'odd'], ['lw-07', 0x80000, 'swap'],
      { size: 0x400000, files: [['lw-02', 0, 2], ['lw-09', 2, 2], ['lw-06', 4, 2], ['lw-13', 6, 2], ['lw-01', 0x200000, 2], ['lw-08', 0x200002, 2], ['lw-05', 0x200004, 2], ['lw-12', 0x200006, 2]] },
      'lwu00', ['lw-03u', 'lw-04u']],
    [Game1941, ['41e_30', 0, 'even'], ['41e_35', 0, 'odd'], ['41e_31', 0x40000, 'even'], ['41e_36', 0x40000, 'odd'], ['41_32', 0x80000, 'swap'],
      { size: 0x200000, files: [['41_gfx5', 0, 2], ['41_gfx7', 2, 2], ['41_gfx1', 4, 2], ['41_gfx3', 6, 2]] },
      '41_09', ['41_18', '41_19']],
    [Knights, ['kr_23e', 0, 'swap'], ['kr_22', 0x80000, 'swap'],
      { size: 0x400000, files: [['kr_gfx1', 0, 2], ['kr_gfx3', 2, 2], ['kr_gfx2', 4, 2], ['kr_gfx4', 6, 2], ['kr_gfx5', 0x200000, 2], ['kr_gfx7', 0x200002, 2], ['kr_gfx6', 0x200004, 2], ['kr_gfx8', 0x200006, 2]] },
      'kr_09', ['kr_18', 'kr_19']],
    [CaptainCommando, ['cce_23d', 0, 'swap'], ['cc_22d', 0x80000, 'swap'], ['cc_24d', 0x100000, 'even'], ['cc_28d', 0x100000, 'odd'],
      { size: 0x400000, files: [['gfx_01', 0, 2], ['gfx_03', 2, 2], ['gfx_02', 4, 2], ['gfx_04', 6, 2], ['gfx_05', 0x200000, 2], ['gfx_07', 0x200002, 2], ['gfx_06', 0x200004, 2], ['gfx_08', 0x200006, 2]] },
      'cc_09', ['cc_18', 'cc_19']],
  ].map(cpsEntry),
  ...[
    // Neo Geo: [Board, game number, P ROMs as [name, size, swap halves?], V ROM count, C ROM count]
    [MetalSlug, '201', [['201-p1', 0x200000, true]], 2, 4, 0xD00BD152],   // some sets store its C ROMs with halves swapped
    [MetalSlug2, '241', [['241-p1', 0x100000], ['241-p2', 0x200000]], 2, 4],
    [MetalSlugX, '250', [['250-p1', 0x100000], ['250-p2', 0x400000]], 3, 6],
  ].map(neoEntry),
];

function interleave(even, odd) {
  const out = new Uint8Array(even.length * 2);
  for (let i = 0; i < even.length; i++) { out[i * 2] = even[i]; out[i * 2 + 1] = odd[i]; }
  return out;
}

function swap01(rom) {
  return rom.map((v) => (v & 0xFC) | ((v & 1) << 1) | ((v >> 1) & 1));
}

// A CPS-1 registry entry from its ROM list (see the table above).
function cpsEntry([Board, ...rest]) {
  const prog = rest.filter((r) => Array.isArray(r) && typeof r[2] === 'string');
  const gfx = rest.find((r) => r && r.files), [sound, samples] = rest.slice(-2);
  const names = [...prog.map((p) => p[0]), ...gfx.files.map((f) => f[0]), sound, ...(samples || [])];
  const esc = (n) => n.replace(/[.]/g, '\\.');
  return {
    Board,
    chips: names.map((n) => [n, null, [new RegExp(`^${esc(n)}(\\.(bin|rom))?$`)]]),
    assemble: (c) => {
      const main = new Uint8Array(0x200000).fill(0xFF);
      for (const [n, at, kind] of prog) {
        const r = c[n];
        if (kind === 'even' || kind === 'odd') for (let i = 0; i < r.length; i++) main[at + i * 2 + (kind === 'odd' ? 1 : 0)] = r[i];
        else if (kind === 'swap') for (let i = 0; i < r.length; i += 2) { main[at + i] = r[i + 1]; main[at + i + 1] = r[i]; }
        else main.set(r, at);
      }
      const g = new Uint8Array(gfx.size);
      for (const [n, at, step] of gfx.files) {
        const r = c[n];
        for (let i = 0; i < r.length; i += step) for (let k = 0; k < step; k++) g[at + (i / step) * 8 + k] = r[i + k];
      }
      // Sound program: the first 32K at 0, the rest banked in from 10000.
      const z = new Uint8Array(0x18000), sr = c[sound];
      z.set(sr.subarray(0, 0x8000), 0); z.set(sr.subarray(0x8000, 0x10000), 0x10000);
      return { main, gfx: g, sound: z, samples: samples ? cat(c[samples[0]], c[samples[1]]) : null };
    },
  };
}

// A Neo Geo registry entry. The system BIOS, fix-layer font and shrink table
// come in the same zip (merged sets) or a separate neogeo.zip.
function neoEntry([Board, num, prog, nv, nc, swappedCrc]) {
  const name = (n) => new RegExp(`^${n}\\.(bin|rom)$`);
  const chips = [
    ['bios', 0x20000, [/^sp-s2\.sp1$/]], ['sfix', 0x20000, [/^sfix\.sfx$/]], ['zoom', 0x10000, [/^000-lo\.lo$/, /^mamelo\.lo$/]],
    ...prog.map(([n, size]) => [n, size, [name(n)]]),
    [`${num}-s1`, null, [name(`${num}-s1`)]], [`${num}-m1`, null, [name(`${num}-m1`)]],
    ...Array.from({ length: nv }, (_, i) => [`v${i + 1}`, null, [name(`${num}-v${i + 1}`)]]),
    ...Array.from({ length: nc }, (_, i) => [`c${i + 1}`, null, [name(`${num}-c${i + 1}`)]]),
  ];
  return {
    Board,
    chips,
    assemble: (c) => {
      const swapWords = (r) => { const o = new Uint8Array(r.length); for (let i = 0; i < r.length; i += 2) { o[i] = r[i + 1]; o[i + 1] = r[i]; } return o; };
      const parts = prog.map(([n, , halves]) => {
        const r = swapWords(c[n]);
        return halves ? cat(r.subarray(r.length / 2), r.subarray(0, r.length / 2)) : r;
      });
      // Sprite tiles: each C ROM pair interleaved byte by byte.
      const c0 = c.c1.length, spr = new Uint8Array(c0 * nc);
      const swap = swappedCrc && crc32(c.c1) === swappedCrc;
      const half = (r) => (swap ? cat(r.subarray(r.length / 2), r.subarray(0, r.length / 2)) : r);
      for (let k = 0; k < nc; k += 2) {
        const a = half(c[`c${k + 1}`]), b = half(c[`c${k + 2}`]), at = k * c0;
        for (let i = 0; i < c0; i++) { spr[at + i * 2] = a[i]; spr[at + i * 2 + 1] = b[i]; }
      }
      return {
        bios: swapWords(c.bios), sfix: c.sfix, zoom: c.zoom, p: cat(...parts),
        s: c[`${num}-s1`], m: c[`${num}-m1`], v: cat(...Array.from({ length: nv }, (_, i) => c[`v${i + 1}`])), c: spr,
      };
    },
  };
}

let CRC_TABLE = null;
function crc32(data) {
  if (!CRC_TABLE) CRC_TABLE = Int32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
  let crc = -1;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// A 64K address space image: ROMs at their addresses, 0xFF elsewhere.
function place(parts) {
  const out = new Uint8Array(0x10000).fill(0xFF);
  for (const [rom, at] of parts) out.set(rom, at);
  return out;
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
      const name = names.find((n) => (size === null || files[n].length === size) && patterns.some((p) => p.test(n)));
      if (!name) break;
      found[role] = files[name];
    }
    if (Object.keys(found).length === chips.length) return { Board, roms: assemble(found) };
  }
  throw new Error(`this isn't a supported ROM set (${BOARDS.map((b) => b.Board.title).join(', ')})`);
}

export const SUPPORTED = BOARDS.map((b) => b.Board.title);
// The MAME set name each board expects (its id), for the "upload" hint.
export const ROM_FILES = Object.fromEntries(BOARDS.map((b) => [b.Board.title, `${b.Board.id}.zip`]));
