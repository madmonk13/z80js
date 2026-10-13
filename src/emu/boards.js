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
//   startLabels          optional [label1, label2]: show two start buttons (each start picks a side)
//   sound                sample source: buffer/readPos/writePos/available()/pull(), rate
//   runFrame(), reset()
//   setInputs({ left, right, up, down, fire, fire2, fire3, spin, coin, start1, start2 })
//   applySwitches({ id: value }) with the options listed in Board.switches
//   Board.stateVersion   (optional) bumped when older saved states no longer restore correctly

import { Galaga } from './galaga.js';
import { PacMan, MsPacMan, JrPacMan, Piranha, CrushRoller, PuckMan, PacManPlus, Eyes, MrTNT, LizardWizard, Ponpoko, JumpShot, MakeTrax, MagicBrush, DreamShopper } from './pacman.js';
import { Galaxian, MoonCresta, Eagle, UniWarS, Pisces, BlackHole, Swarm, RedUFO, MoonAlien, WarOfTheBugs } from './galaxian.js';
import { DonkeyKong, DonkeyKongJr } from './dkong.js';
import { Frogger } from './frogger.js';
import { Scramble, Amidar, SuperCobra, ArmoredCar, TazzMania, Anteater } from './scramble.js';
import { DigDug } from './digdug.js';
import { TimePilot, Pooyan } from './timeplt.js';
import { MrDo } from './mrdo.js';
import { SatansHollow, Tron, Tapper, Kick, DominoMan, Timber, SolarFox, Wacko } from './mcr.js';
import { Bosconian, Xevious, SuperXevious } from './bosco.js';
import { Berzerk, Frenzy } from './berzerk.js';
import { RallyX, NewRallyX } from './rallyx.js';
import { WarpWarp } from './warpwarp.js';
import { Mappy, DigDug2, Motos, Druaga, SuperPacMan, PacAndPal, Grobda } from './mappy.js';
import { Centipede, Millipede, Warlords } from './centiped.js';
import { Phoenix, Pleiads } from './phoenix.js';
import { SpaceInvaders, SpaceInvadersPartII, SpaceInvadersCV, LunarRescue, GalaxyWars, OzmaWars } from './invaders.js';
import { LadyBug, CosmicAvenger, SnapJack } from './ladybug.js';
import { C1942 } from './c1942.js';
import { DoCastle, DoRunRun, DoWildRide, KickRider } from './docastle.js';
import { Popeye } from './popeye.js';
import { Pengo } from './pengo.js';
import { BombJack } from './bombjack.js';
import { MarioBros } from './mario.js';
import { MoonPatrol } from './mpatrol.js';
import { Zaxxon } from './zaxxon.js';
import { GhostsNGoblins } from './gng.js';
import { Asteroids, AsteroidsDeluxe, LunarLander } from './asteroids.js';
import { Tempest } from './tempest.js';
import { Battlezone, RedBaron } from './bzone.js';
import { BlackWidow, Gravitar, SpaceDuel } from './bwidow.js';
import { StarWars } from './starwars.js';
import { TailGunner } from './tailg.js';
import { Silkworm } from './tecmo.js';
import { RoboCop } from './dec0.js';
import { Aliens, Ajax, CrimeFighters, SuperContra, GangBusters, BottomOfTheNinth } from './konamik.js';
import { TMNT, MissingInAction } from './tmnt.js';
import { StarCastle, RipOff, ArmorAttack, SolarQuest } from './cinemat.js';
import { RushNAttack, GreenBeretJ, MrGoemon } from './gberet.js';
import { YieArKungFu } from './yiear.js';
import { Qbert, MadPlanets, Krull, QbertsQubes } from './gottlieb.js';
import { LegendOfKage } from './lkage.js';
import { Shinobi } from './segas16b.js';
import { RollingThunder, WonderMomo, Genpei, ReturnOfIshtar, HoppingMappy, SkyKidDeluxe } from './namcos86.js';
import { SmashTV, TotalCarnage, MortalKombat } from './midyunit.js';
import { RType, RType2, HammerinHarry, MajorTitle, BattleChopper, NinjaSpirit, ImageFight, HeroTonma, XMultiply, DragonBreed, AirDuel, Gallop } from './m72.js';
import { MetalSlug, MetalSlug2, MetalSlugX } from './neogeo.js';
import { Strider, Mercs, FinalFight, StreetFighter2, GhoulsNGhosts, ForgottenWorlds, Game1941, Knights, CaptainCommando } from './cps1.js';
import { Gorf, WizardOfWor, RobbyRoto, SpaceZap, ExtraBases, SeaWolf2 } from './astrocade.js';
import { Robotron, Joust, Bubbles, Splat, Stargate, Defender, Sinistar, Colony7, Mayday } from './williams.js';

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
  ...[
    // Pac-Man board games: [Board, main [file, offset]..., ext (8000-BFFF) [file, offset]..., gfx [file, offset]... (8K: tiles then sprites), palette, lut]
    [Eyes, [['d7', 0], ['e7', 0x1000], ['f7', 0x2000], ['h7', 0x3000]], [], [['d5', 0], ['e5', 0x1000]], '82s123\\.7f', '82s129\\.4a'],
    [MrTNT, [['tnt\\.1', 0], ['tnt\\.2', 0x1000], ['tnt\\.3', 0x2000], ['tnt\\.4', 0x3000]], [], [['tnt\\.5', 0], ['tnt\\.6', 0x1000]], '82s123\\.7f', '82s126\\.4a'],
    [LizardWizard, [['6e\\.cpu', 0], ['6f\\.cpu', 0x1000], ['6h\\.cpu', 0x2000], ['6j\\.cpu', 0x3000]], [['wiza', 0], ['wizb', 0x1000]], [['5e\\.cpu', 0], ['5f\\.cpu', 0x1000]], '7f\\.cpu', '4a\\.cpu'],
    [Ponpoko, [['ppokoj1\\.bin', 0], ['ppokoj2\\.bin', 0x1000], ['ppokoj3\\.bin', 0x2000], ['ppokoj4\\.bin', 0x3000]],
      [['ppoko5\\.bin', 0], ['ppoko6\\.bin', 0x1000], ['ppoko7\\.bin', 0x2000], ['ppokoj8\\.bin', 0x3000]], [['ppoko9\\.bin', 0], ['ppoko10\\.bin', 0x1000]], '82s123\\.7f', '82s126\\.4a'],
    [JumpShot, [['6e', 0], ['6f', 0x1000], ['6h', 0x2000], ['6j', 0x3000]], [], [['5e', 0], ['5f', 0x1000]], 'prom\\.7f', 'prom\\.4a'],
    [MakeTrax, [['maketrax\\.6e', 0], ['maketrax\\.6f', 0x1000], ['maketrax\\.6h', 0x2000], ['maketrax\\.6j', 0x3000]], [], [['maketrax\\.5e', 0], ['maketrax\\.5f', 0x1000]], '82s123\\.7f', '2s140\\.4a'],
    [MagicBrush, [['mbrush\\.6e', 0], ['mbrush\\.6f', 0x1000], ['mbrush\\.6h', 0x2000], ['mbrush\\.6j', 0x3000]], [],
      [['tpa', 0], ['mbrush\\.5h', 0x800], ['mbrush\\.5f', 0x1000], ['tpd', 0x1800]], '82s123\\.7f', '2s140\\.4a'],
  ].map(([Board, main, ext, gfx, palette, lut]) => {
    const re = (p) => [new RegExp(`^${p}$`)];
    return {
      Board,
      chips: [...main.map(([p], i) => [`m${i}`, null, re(p)]), ...ext.map(([p], i) => [`x${i}`, null, re(p)]), ...gfx.map(([p], i) => [`g${i}`, null, re(p)]),
        ['palette', 0x20, re(palette)], ['lut', 0x100, re(lut)], ['wave', 0x100, re('82s126\\.1m|pr\\.1k')]],
      assemble: (c) => {
        const mainRom = new Uint8Array(0x4000), gfxRom = new Uint8Array(0x2000);
        main.forEach(([, at], i) => mainRom.set(c[`m${i}`], at));
        gfx.forEach(([, at], i) => gfxRom.set(c[`g${i}`], at));
        let extRom = null;
        if (ext.length) { extRom = new Uint8Array(0x4000); ext.forEach(([, at], i) => extRom.set(c[`x${i}`], at)); }
        return { main: mainRom, ext: extRom, tiles: gfxRom.slice(0, 0x1000), sprites: gfxRom.slice(0x1000), palette: c.palette, lut: c.lut, wave: c.wave };
      },
    };
  }),
  {
    Board: DreamShopper,
    chips: [
      ...['1\\.50', '2\\.51', '3\\.52', '4\\.53', '5\\.39', '6\\.40', '7\\.41'].map((n, i) => [`m${i}`, 0x1000, [new RegExp(`^red_${n}$`)]]),
      ['tiles', 0x1000, [/^red-20\.18$/]],
      ['sprites', 0x1000, [/^red-21\.19$/]],
      ['palette', 0x20, [/^6331-1\.6$/]],
      ['lut', 0x100, [/^6301-1\.37$/]],
    ],
    assemble: (c) => {
      const ext = new Uint8Array(0x4000).fill(0xFF);
      ext.set(cat(c.m4, c.m5, c.m6), 0);
      return { main: cat(c.m0, c.m1, c.m2, c.m3), ext, tiles: c.tiles, sprites: c.sprites, palette: c.palette, lut: c.lut, wave: new Uint8Array(0x100) };
    },
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
  // Invaders-board games: [Board, ROMs at 0000 up, ROMs at 4000 up, color PROMs]
  ...[
    [SpaceInvadersPartII, ['pv\\.?01', 'pv\\.?02', 'pv\\.?03', 'pv\\.?04'], ['pv\\.?05'], ['pv\\.?06', 'pv\\.?07']],
    [SpaceInvadersCV, ['cv17\\.bin', 'cv18\\.bin', 'cv19\\.bin', 'cv20\\.bin'], [], ['cv01', 'cv02']],
    [LunarRescue, ['lrescue\\.1', 'lrescue\\.2', 'lrescue\\.3', 'lrescue\\.4'], ['lrescue\\.5', 'lrescue\\.6'], ['7643-1\\.cpu']],
    [GalaxyWars, ['univgw3\\.0', 'univgw4\\.1', 'univgw5\\.2', 'univgw6\\.3'], ['univgw1\\.4', 'univgw2\\.5'], []],
    [OzmaWars, ['mw01', 'mw02', 'mw03', 'mw04'], ['mw05', 'mw06'], []],
  ].map(([Board, lo, hi, proms]) => ({
    Board,
    chips: [
      ...lo.map((n, i) => [`lo${i}`, null, [new RegExp(`^${n}`)]]),
      ...hi.map((n, i) => [`hi${i}`, null, [new RegExp(`^${n}`)]]),
      ...proms.map((n, i) => [`c${i}`, 0x400, [new RegExp(`^${n}`)]]),
    ],
    assemble: (c) => {
      const main = new Uint8Array(0x5000);
      const place = (arr, at) => { for (const r of arr) { main.set(r, at); at += r.length; } };
      place(lo.map((_, i) => c[`lo${i}`]), 0);
      place(hi.map((_, i) => c[`hi${i}`]), 0x4000);
      const colors = proms.length ? cat(c.c0, c.c1 || c.c0) : null;
      return colors ? { main, colors } : { main };
    },
  })),
  ...[
    [SnapJack, ['sj2a\\.bin', 'sj2b\\.bin', 'sj2c\\.bin', 'sj2d\\.bin', 'sj2e\\.bin', 'sj2f\\.bin'], ['sj2i\\.bin', 'sj2j\\.bin'], ['sj2h\\.bin', 'sj2g\\.bin'], 'sj8t\\.bin', 'sj9k\\.bin'],
    [CosmicAvenger, ['1', '2', '3', '4', '5', '6'], ['9', '0'], ['8'], 't8\\.bpr', 'k9\\.bpr'],
  ].map(([Board, main, chars, sprites, palette, lut]) => {
    const re = (p) => [new RegExp(`^${p}$`)];
    return {
      Board,
      chips: [...main.map((p, i) => [`m${i}`, 0x1000, re(p)]), ...chars.map((p, i) => [`c${i}`, 0x1000, re(p)]), ...sprites.map((p, i) => [`s${i}`, 0x1000, re(p)]),
        ['palette', 0x20, re(palette)], ['lut', 0x20, re(lut)]],
      assemble: (c) => {
        const spr = new Uint8Array(0x2000);
        sprites.forEach((_, i) => spr.set(c[`s${i}`], i * 0x1000));
        return { main: cat(...main.map((_, i) => c[`m${i}`])), chars: cat(...chars.map((_, i) => c[`c${i}`])), sprites: spr, palette: c.palette, spriteLut: c.lut };
      },
    };
  }),
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
    Board: KickRider,
    chips: [
      ...['k1', 'k3', 'k4', 'k2', 'k6', 'k7', 'k8', 'k9'].map((n) => [n, 0x2000, [new RegExp(`^${n}$`)]]),
      ['sub', 0x4000, [/^k10$/]],
      ['chars', 0x4000, [/^k5$/]],
      ['palette', 0x100, [/^kickridr\.clr$/]],
    ],
    assemble: (c) => {
      const main = new Uint8Array(0xA000);         // 0000-1FFF and 4000-9FFF
      main.set(c.k1, 0); main.set(c.k3, 0x4000); main.set(c.k4, 0x6000); main.set(c.k2, 0x8000);
      return { main, sub: c.sub, chars: c.chars, sprites: cat(c.k6, c.k7, c.k8, c.k9), palette: c.palette };
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
    Board: Colony7,
    chips: [
      ...[3, 2, 1].map((n) => [`m${n}`, 0x1000, [new RegExp(`^cs0${n}\\.bin$`)]]),
      ...[6, 4, 7, 5, 8].map((n) => [`b${n}`, 0x800, [new RegExp(`^cs0${n}\\.bin$`)]]),
      ['sound', 0x800, [/^cs11\.bin$/]],
    ],
    assemble: (c) => {
      const banked = new Uint8Array(0x9000).fill(0xFF);
      [[6, 0], [4, 0x800], [7, 0x1000], [5, 0x1800], [8, 0x2000], [8, 0x2800]].forEach(([n, o]) => banked.set(c[`b${n}`], o));
      return { main: cat(c.m3, c.m2, c.m1), sound: cat(c.sound, c.sound), banked };
    },
  },
  {
    Board: Mayday,
    chips: [
      ...['03-3', '02-2', '01-1', '04-4', '05-5', '06-6', '07-7d'].map((n) => [n, 0x1000, [new RegExp(`^ic${n}\\.bin$`)]]),
      ['sound', 0x800, [/^ic28-8\.bin$/]],
    ],
    assemble: (c) => {
      const banked = new Uint8Array(0x9000).fill(0xFF);
      [['04-4', 0], ['05-5', 0x1000], ['06-6', 0x2000], ['07-7d', 0x6000]].forEach(([n, o]) => banked.set(c[n], o));
      return { main: cat(c['03-3'], c['02-2'], c['01-1']), sound: cat(c.sound, c.sound), banked };
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
  ...[
    // Stern on the Super Cobra board: [Board, main ROMs..., sound ROMs..., gfx ROMs (first half, second), palette]
    [ArmoredCar, ['cpu\\.2c', 'cpu\\.2e', 'cpu\\.2f', 'cpu\\.2h', 'cpu\\.2j'], ['sound\\.5c', 'sound\\.5d'], ['cpu\\.5f', 'cpu\\.5h'], '82s123\\.6e'],
    [TazzMania, ['2c\\.cpu', '2e\\.cpu', '2f\\.cpu', '2h\\.cpu', '2j\\.cpu', '2k\\.cpu'], ['rom0\\.snd'], ['5f\\.cpu', '5h\\.cpu'], 'colr6f\\.cpu'],
    [Anteater, ['ra1-2c', 'ra1-2e', 'ra1-2f', 'ra1-2h'], ['ra4-5c', 'ra4-5d'], ['ra6-5f', 'ra6-5h'], 'colr6f\\.cpu'],
  ].map(([Board, main, sound, gfx, palette]) => {
    const re = (p) => [new RegExp(`^${p}$`)];
    return {
      Board,
      chips: [...main.map((p, i) => [`m${i}`, 0x1000, re(p)]), ...sound.map((p, i) => [`s${i}`, 0x800, re(p)]), ...gfx.map((p, i) => [`g${i}`, 0x800, re(p)]), ['palette', 0x20, re(palette)]],
      assemble: (c) => ({ main: cat(...main.map((_, i) => c[`m${i}`])), sound: cat(...sound.map((_, i) => c[`s${i}`])), gfx: cat(c.g0, c.g1), palette: c.palette }),
    };
  }),
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
  ...[
    // Galaxian-board games: [Board, main ROMs (2K each, or [file, address, size]), gfx ROMs (plane 0 first), palette]
    [UniWarS, ['f07_1a\\.bin', 'h07_2a\\.bin', 'k07_3a\\.bin', 'm07_4a\\.bin', 'd08p_5a\\.bin', 'gg6', 'm08p_7a\\.bin', 'n08p_8a\\.bin'], ['egg10', 'h01_2\\.bin', 'egg9', 'k01_2\\.bin'], 'uniwars\\.clr'],
    [Pisces, ['p1\\.bin', 'p2\\.bin', 'p3\\.bin', 'p4\\.bin', 'p5\\.bin', 'p6\\.bin'], ['g09\\.bin', 'g11\\.bin', 'g10\\.bin', 'g12\\.bin'], 'colour\\.bin'],
    [BlackHole, ['bh1', 'bh2', 'bh3', 'bh4', 'bh5', 'bh6'], ['bh7', 'bh8'], '6l\\.bpr'],
    [Swarm, ['swarm1\\.bin', 'swarm2\\.bin', 'swarm3\\.bin', 'swarm4\\.bin', 'swarm5\\.bin'], ['swarma\\.bin', 'swarmb\\.bin'], '6l\\.bpr'],
    [RedUFO, ['ru1a', 'ru2a', 'ru3a', 'ru4a', 'ru5a', 'ru6a'], ['ruhja', 'rukla'], '6l\\.bpr'],
    [MoonAlien, ['galx\\.u', 'prg2\\.bin', 'prg3\\.bin', 'superg\\.y', 'prg5\\.bin'], ['ca1\\.bin', 'ca2\\.bin'], '6l\\.bpr'],
    [WarOfTheBugs, ['warofbug\\.u', 'warofbug\\.v', 'warofbug\\.w', 'warofbug\\.y', 'warofbug\\.z'], ['warofbug\\.1k', 'warofbug\\.1j'], 'warofbug\\.clr'],
  ].map(([Board, main, gfx, palette]) => {
    const re = (p) => [new RegExp(`^${p}$`)];
    const parts = main.map((m, i) => (Array.isArray(m) ? m : [m, i * 0x800, 0x800]));
    return {
      Board,
      chips: [...parts.map(([p, , size], i) => [`m${i}`, size, re(p)]), ...gfx.map((p, i) => [`g${i}`, 0x800, re(p)]), ['palette', 0x20, re(palette)]],
      assemble: (c) => {
        const mainRom = new Uint8Array(Math.max(...parts.map(([, at, size]) => at + size)));
        parts.forEach(([, at], i) => mainRom.set(c[`m${i}`], at));
        return { main: mainRom, gfx: cat(...gfx.map((_, i) => c[`g${i}`])), palette: c.palette };
      },
    };
  }),
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
    Board: Eagle,
    chips: [
      ...['e1', 'e2', 'f03\\.bin', 'f04\\.bin', 'e5', 'e6', 'e7', 'e8'].map((n, i) => [`main${i}`, 0x800, [new RegExp(`^${n}$`)]]),
      ['e10', 0x800, [/^e10$/]], ['e12', null, [/^e12$/]], ['e9', 0x800, [/^e9$/]], ['e11', null, [/^e11$/]],
      ['palette', 0x20, [/^l06_prom\.bin$/]],
    ],
    assemble: (c) => {
      const gfx = new Uint8Array(0x2000);
      gfx.set(c.e10, 0); gfx.set(c.e12.subarray(0, 0x800), 0x800); gfx.set(c.e9, 0x1000); gfx.set(c.e11.subarray(0, 0x800), 0x1800);
      return { main: cat(...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => c[`main${n}`])), gfx, palette: c.palette };
    },
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
  ...[
    // Super Pac-Man board: [Board, main ROMs (low to high), sub, chars, sprites..., palette, char LUT, sprite LUT, wave]
    [SuperPacMan, ['sp1-2\\.1c', 'sp1-1\\.1b'], 'spc-3\\.1k', 'sp1-6\\.3c', ['spv-2\\.3f'], 'superpac\\.4c', 'superpac\\.4e', 'superpac\\.3l', 'superpac\\.3m'],
    [PacAndPal, ['(pap13b\\.1d|pap1-3b\\.1d)', '(pap12b\\.1c|pap1-2b\\.1c)', '(pap1\\.1b|pap3-1\\.1b)'], '(pap14\\.1k|pap1-4\\.1k)', '(pap16\\.3c|pap1-6\\.3c)', ['(pap15\\.3f|pap1-5\\.3f)'],
      '(papi6\\.4c|pap1-6\\.4c)', '(papi5\\.4e|pap1-5\\.4e)', '(papi4\\.3l|pap1-4\\.3l)', '(papi3\\.3m|pap1-3\\.3m)'],
    [Grobda, ['gr2-3\\.1d', 'gr2-2\\.1c', 'gr2-1\\.1b'], 'gr1-4\\.1k', 'gr1-7\\.3c', ['gr1-5\\.3f', 'gr1-6\\.3e'], 'gr1-6\\.4c', 'gr1-5\\.4e', 'gr1-4\\.3l', 'gr1-3\\.3m'],
  ].map(([Board, main, sub, chars, sprites, palette, charLut, spriteLut, wave]) => {
    const re = (p) => [new RegExp(`^${p}$`)];
    return {
      Board,
      chips: [...main.map((p, i) => [`m${i}`, null, re(p)]), ['sub', null, re(sub)], ['chars', 0x1000, re(chars)], ...sprites.map((p, i) => [`s${i}`, 0x2000, re(p)]),
        ['palette', 0x20, re(palette)], ['charLut', 0x100, re(charLut)], ['spriteLut', 0x100, re(spriteLut)], ['wave', 0x100, re(wave)]],
      assemble: (c) => {
        const subRom = new Uint8Array(0x2000).fill(0xFF);
        subRom.set(c.sub, 0x2000 - c.sub.length);
        return { main: cat(...main.map((_, i) => c[`m${i}`])), sub: subRom, chars: c.chars, sprites: cat(...sprites.map((_, i) => c[`s${i}`])),
          palette: c.palette, charLut: c.charLut, spriteLut: c.spriteLut, wave: c.wave };
      },
    };
  }),
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
    Board: Warlords,
    chips: [
      ...[154, 153, 158, 157, 156, 155].map((n, i) => [`p${i}`, 0x800, [new RegExp(`^037${n}`)]]),
      ['gfx', 0x800, [/^037159/]],
      ['prom', 0x100, [/^warlord\.clr$/]],
    ],
    assemble: (c) => ({ main: cat(c.p0, c.p1, c.p2, c.p3, c.p4, c.p5), gfx: c.gfx, prom: c.prom }),
  },
  {
    Board: Millipede,
    chips: [
      ...[104, 103, 102, 101].map((n, i) => [`p${i}`, 0x1000, [new RegExp(`^(milliped|136013)[.-]${n}`)]]),
      ['g0', 0x800, [/^(milliped|136013)[.-]107/]],
      ['g1', 0x800, [/^(milliped|136013)[.-]106/]],
    ],
    assemble: (c) => ({ main: cat(c.p0, c.p1, c.p2, c.p3), gfx: cat(c.g0, c.g1) }),
  },
  {
    Board: Pleiads,
    chips: [
      ...['ic47.r1', 'ic48.r2', 'ic47.bin', 'ic48.bin', 'ic51.r5', 'ic50.bin', 'ic53.r7', 'ic52.bin'].map((n, i) => [`main${i}`, 0x800, [new RegExp(`^${n.replace('.', '\\.')}$`)]]),
      ['bg0', 0x800, [/^ic23\.bin$/]],
      ['bg1', 0x800, [/^ic24\.bin$/]],
      ['fg0', 0x800, [/^ic39\.bin$/]],
      ['fg1', 0x800, [/^ic40\.bin$/]],
      ['palLo', 0x100, [/^7611-5\.26$/]],
      ['palHi', 0x100, [/^7611-5\.33$/]],
    ],
    assemble: (c) => ({
      main: cat(...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => c[`main${n}`])), bg: cat(c.bg0, c.bg1), fg: cat(c.fg0, c.fg1),
      palLo: c.palLo, palHi: c.palHi,
    }),
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
    Board: Timber,
    chips: [
      ...[0, 1, 2, 3].map((n) => [`main${n}`, null, [new RegExp(`^timpg${n}\\.bin$`)]]),
      ...[7, 8, 9].map((n) => [`sound${n}`, 0x1000, [new RegExp(`^tima${n}\\.bin$`)]]),
      ['bg0', 0x4000, [/^timbg0\.bin$/]],
      ['bg1', 0x4000, [/^timbg1\.bin$/]],
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => [`fg${n}`, 0x4000, [new RegExp(`^timfg${n}\\.bin$`)]]),
      ['prom', 0x20, [/^82s123/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3), sound: cat(c.sound7, c.sound8, c.sound9),
      bg: cat(c.bg1, c.bg0), fg: cat(c.fg1, c.fg0, c.fg3, c.fg2, c.fg5, c.fg4, c.fg7, c.fg6), prom: c.prom,
    }),
  },
  {
    Board: SolarFox,
    chips: [
      ...['3b', '4b', '5b', '4d', '5d', '6d', '7d'].map((n, i) => [`main${i}`, 0x1000, [new RegExp(`^sfcpu\\.${n}$`)]]),
      ...['7a', '8a', '9a'].map((n, i) => [`sound${i}`, 0x1000, [new RegExp(`^sfsnd\\.${n}$`)]]),
      ['bg0', 0x1000, [/^sfcpu\.4g$/]],
      ['bg1', 0x1000, [/^sfcpu\.5g$/]],
      ...['1a', '1b', '1d', '1e'].map((n, i) => [`fg${i}`, 0x2000, [new RegExp(`^sfvid\\.${n}$`)]]),
      ['prom', 0x20, [/^82s123/]],
    ],
    assemble: (c) => ({
      main: cat(...[0, 1, 2, 3, 4, 5, 6].map((n) => c[`main${n}`])), sound: cat(c.sound0, c.sound1, c.sound2),
      bg: cat(c.bg0, c.bg1), fg: cat(c.fg0, c.fg1, c.fg2, c.fg3), prom: c.prom,
    }),
  },
  {
    Board: Wacko,
    chips: [
      ...['2d', '3d', '4d', '5d'].map((n, i) => [`main${i}`, 0x2000, [new RegExp(`^wackocpu\\.${n}$`)]]),
      ...['7a', '8a', '9a'].map((n, i) => [`sound${i}`, 0x1000, [new RegExp(`^wackosnd\\.${n}$`)]]),
      ['bg0', 0x2000, [/^wackocpu\.3g$/]],
      ['bg1', 0x2000, [/^wackocpu\.4g$/]],
      ...['1e', '1d', '1b', '1a'].map((n, i) => [`fg${i}`, 0x2000, [new RegExp(`^wackovid\\.${n}$`)]]),
      ['prom', 0x20, [/^82s123/]],
    ],
    assemble: (c) => ({
      main: cat(c.main0, c.main1, c.main2, c.main3), sound: cat(c.sound0, c.sound1, c.sound2),
      bg: cat(c.bg0, c.bg1), fg: cat(c.fg0, c.fg1, c.fg2, c.fg3), prom: c.prom,
    }),
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
    Board: AsteroidsDeluxe,
    chips: [['p0', 0x800, [/^036430\./]], ['p1', 0x800, [/^036431\./]], ['p2', 0x800, [/^036432\./]], ['p3', 0x800, [/^036433\./]],
      ['v0', 0x800, [/^036800\./]], ['v1', 0x800, [/^036799\./]]],
    assemble: (c) => ({ main: cat(c.p0, c.p1, c.p2, c.p3), vector: cat(c.v0, c.v1) }),
  },
  {
    Board: LunarLander,
    chips: [['p0', 0x800, [/^034572\./]], ['p1', 0x800, [/^034571\./]], ['p2', 0x800, [/^034570\./]], ['p3', 0x800, [/^034569\./]],
      ['v0', 0x800, [/^034599\./]], ['v1', 0x800, [/^034598\./]]],
    assemble: (c) => ({ main: cat(c.p0, c.p1, c.p2, c.p3), vector: cat(c.v0, c.v1) }),
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
    Board: RedBaron,
    chips: [['p0', 0x1000, [/^037587\./]], ['p1', 0x800, [/^037000\./]], ...['036998', '036997', '036996', '036995'].map((n) => [n, 0x800, [new RegExp(`^${n}\\.`)]]),
      ['v0', 0x800, [/^037006\./]], ['v1', 0x800, [/^037007\./]]],
    assemble: (c) => {
      const main = new Uint8Array(0x3800);                   // 4800-7FFF
      main.set(c.p0.subarray(0, 0x800), 0); main.set(c.p1, 0x800); main.set(c.p0.subarray(0x800), 0x1000);
      ['036998', '036997', '036996', '036995'].forEach((n, k) => main.set(c[n], 0x1800 + k * 0x800));
      return { main, vector: cat(c.v0, c.v1) };
    },
  },
  ...[
    // Atari color vector games: [Board, set prefix, [file, address]...] (the top ROM repeats up to FFFF).
    [BlackWidow, '136017', [['107', 0x2800], ['108', 0x3000], ['109', 0x4000], ['110', 0x5000], ['101', 0x9000], ['102', 0xA000], ['103', 0xB000], ['104', 0xC000], ['105', 0xD000], ['106', 0xE000]]],
    [Gravitar, '136010', [['210', 0x2800], ['207', 0x3000], ['208', 0x4000], ['309', 0x5000], ['301', 0x9000], ['302', 0xA000], ['303', 0xB000], ['304', 0xC000], ['305', 0xD000], ['306', 0xE000]]],
    [SpaceDuel, '136006', [['106', 0x2800], ['107', 0x3000], ['201', 0x4000], ['102', 0x5000], ['103', 0x6000], ['104', 0x7000], ['105', 0x8000]]],
  ].map(([Board, prefix, parts]) => ({
    Board,
    chips: parts.map(([n]) => [n, null, [new RegExp(`^${prefix}\\.${n}$`)]]),
    assemble: (c) => {
      const mem = new Uint8Array(0x10000);
      for (const [n, at] of parts) mem.set(c[n], at);
      const last = parts[parts.length - 1];
      for (let a = last[1] + 0x1000; a < 0x10000; a += 0x1000) mem.set(c[last[0]], a);
      return { mem };
    },
  })),
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
  // Cinematronics: [Board, [even, odd] ROM pairs per bank]
  ...[
    [StarCastle, [['starcas3\\.t7', 'starcas3\\.p7'], ['starcas3\\.u7', 'starcas3\\.r7']]],
    [RipOff, [['ripoff\\.t7', 'ripoff\\.p7'], ['ripoff\\.u7', 'ripoff\\.r7']]],
    [ArmorAttack, [['ar414le\\.t6', 'ar414lo\\.p6'], ['ar414ue\\.u6', 'ar414uo\\.r6']]],
    [SolarQuest, [['solar\\.6t', 'solar\\.6p'], ['solar\\.6u', 'solar\\.6r']]],
  ].map(([Board, banks]) => ({
    Board,
    chips: banks.flatMap(([e, o], i) => [[`e${i}`, null, [new RegExp(`^${e}$`)]], [`o${i}`, null, [new RegExp(`^${o}$`)]]]),
    assemble: (c) => ({ main: cat(...banks.map((_, i) => interleave(c[`e${i}`], c[`o${i}`]))) }),
  })),
  {
    Board: Ajax,
    chips: [
      ['n11', 0x10000, [/^770_[mlk]01\.n11$/]], ['n12', 0x10000, [/^770_[lk]02\.n12$/]],
      ['i16', 0x8000, [/^770_[lk]05\.i16$/]], ['g16', 0x10000, [/^770_f04\.g16$/]], ['sound', 0x8000, [/^770_h03\.f16$/]],
      ['c13', 0x40000, [/^770c13/]], ['c12', 0x40000, [/^770c12/]], ['c09', 0x80000, [/^770c09/]], ['c08', 0x80000, [/^770c08/]],
      ['c06', 0x40000, [/^770c06/]], ['c07', 0x40000, [/^770c07/]], ['c10', 0x40000, [/^770c10/]], ['c11', 0x80000, [/^770c11/]],
    ],
    assemble: (c) => {
      const main = new Uint8Array(0x28000);
      main.set(c.n11.subarray(0, 0x8000), 0x10000); main.set(c.n11.subarray(0x8000), 0x8000); main.set(c.n12, 0x18000);
      const sub = new Uint8Array(0x22000);
      sub.set(c.i16.subarray(0, 0x2000), 0x20000); sub.set(c.i16.subarray(0x2000), 0xA000); sub.set(c.g16, 0x10000);
      return { main, sub, sound: c.sound, tiles: cat(c.c13, c.c12), sprites: cat(c.c09, c.c08), zoom: cat(c.c06, c.c07),
        samples1: c.c10, samples2: c.c11 };
    },
  },
  {
    Board: CrimeFighters,
    chips: [
      ['f24', 0x20000, [/^821l02\.f24$/]], ['sound', 0x8000, [/^821l01\.h4$/]],
      ['t0', 0x40000, [/^821k06\.k13$/]], ['t1', 0x40000, [/^821k07\.k19$/]], ['s0', 0x80000, [/^821k04\.k2$/]], ['s1', 0x80000, [/^821k05\.k8$/]],
      ['samples', 0x40000, [/^821k03\.e5$/]],
    ],
    assemble: (c) => {
      const main = new Uint8Array(0x28000);
      main.set(c.f24.subarray(0, 0x18000), 0x10000); main.set(c.f24.subarray(0x18000), 0x8000);
      return { main, sound: c.sound, tiles: cat(c.t0, c.t1), sprites: cat(c.s0, c.s1), samples: c.samples };
    },
  },
  {
    Board: SuperContra,
    chips: [
      ['k11', 0x10000, [/e02\.k11$/]], ['k13', 0x10000, [/e03\.k13$/]], ['sound', 0x8000, [/^775-c01\.bin$/]],
      ...['a07a', 'a07e', 'f07c', 'f07g', 'f07d', 'f07h', 'a08a', 'a08e', 'f08c', 'f08g', 'f08d', 'f08h',
        'a05a', 'a05e', 'a05b', 'a05f', 'f05c', 'f05g', 'f05d', 'f05h', 'a06a', 'a06e', 'a06b', 'a06f', 'f06c', 'f06g', 'f06d', 'f06h',
        'a04a', 'a04b', 'a04c', 'a04d', 'f04e', 'f04f', 'f04g', 'f04h'].map((n) => [n, null, [new RegExp(`^775-${n}\\.bin$`)]]),
    ],
    assemble: (c) => {
      const main = new Uint8Array(0x30800);
      main.set(c.k11.subarray(0, 0x8000), 0x10000); main.set(c.k11.subarray(0x8000), 0x8000); main.set(c.k13, 0x20000);
      // 16-bit ROM pairs: [even, odd, offset]
      const build = (size, pairs) => { const r = new Uint8Array(size); for (const [e, o, at] of pairs) { const ev = c[e], od = c[o]; for (let i = 0; i < ev.length; i++) { r[at + i * 2] = ev[i]; r[at + i * 2 + 1] = od[i]; } } return r; };
      const tiles = build(0x100000, [['a07a', 'a07e', 0], ['f07c', 'f07g', 0x40000], ['f07d', 'f07h', 0x60000],
        ['a08a', 'a08e', 0x80000], ['f08c', 'f08g', 0xC0000], ['f08d', 'f08h', 0xE0000]]);
      const sprites = build(0x100000, [['a05a', 'a05e', 0], ['a05b', 'a05f', 0x20000], ['f05c', 'f05g', 0x40000], ['f05d', 'f05h', 0x60000],
        ['a06a', 'a06e', 0x80000], ['a06b', 'a06f', 0xA0000], ['f06c', 'f06g', 0xC0000], ['f06d', 'f06h', 0xE0000]]);
      return { main, sound: c.sound, tiles, sprites, samples: cat(c.a04a, c.a04b, c.a04c, c.a04d, c.f04e, c.f04f, c.f04g, c.f04h) };
    },
  },
  {
    Board: GangBusters,
    chips: [
      ['k13', 0x10000, [/^878n02/]], ['k15', 0x10000, [/^878j03/]], ['sound', 0x8000, [/^878h01/]],
      ['t0', 0x40000, [/^878c07/]], ['t1', 0x40000, [/^878c08/]], ['s0', 0x40000, [/^878c05/]], ['s1', 0x40000, [/^878c06/]], ['samples', 0x40000, [/^878c04/]],
    ],
    assemble: (c) => {
      const main = new Uint8Array(0x30800);
      main.set(c.k13.subarray(0, 0x8000), 0x10000); main.set(c.k13.subarray(0, 0x8000), 0x18000);   // banked, and mirrored
      main.set(c.k13.subarray(0x8000), 0x8000); main.set(c.k15, 0x20000);
      return { main, sound: c.sound, tiles: cat(c.t0, c.t1), sprites: cat(c.s0, c.s1), samples: c.samples };
    },
  },
  {
    Board: BottomOfTheNinth,
    chips: [
      ['k17', 0x10000, [/^891n03\.k17$/]], ['k15', 0x10000, [/^891-t02\.k15$/]], ['sound', 0x8000, [/^891j01\.g8$/]],
      ...['10c', '10a', '10d', '10b', '09c', '09a', '09d', '09b', '06e', '06a', '06f', '06b', '06g', '06c', '06h', '06d',
        '05e', '05a', '05f', '05b', '05g', '05c', '05h', '05d', '07a', '07b', '08a', '08b', '08c', '08d', '04a', '04b', '04c', '04d']
        .map((n) => [`e${n}`, 0x10000, [new RegExp(`^891e${n}$`)]]),
    ],
    assemble: (c) => {
      const main = new Uint8Array(0x28000);
      main.set(c.k17, 0x10000); main.set(c.k15.subarray(0, 0x8000), 0x20000); main.set(c.k15.subarray(0x8000), 0x8000);
      const pairs = (names) => { const r = new Uint8Array(names.length * 0x10000); for (let k = 0; k < names.length; k += 2) { const ev = c[`e${names[k]}`], od = c[`e${names[k + 1]}`]; for (let i = 0; i < 0x10000; i++) { r[k * 0x10000 + i * 2] = ev[i]; r[k * 0x10000 + i * 2 + 1] = od[i]; } } return r; };
      return {
        main, sound: c.sound,
        tiles: pairs(['10c', '10a', '10d', '10b', '09c', '09a', '09d', '09b']),
        sprites: pairs(['06e', '06a', '06f', '06b', '06g', '06c', '06h', '06d', '05e', '05a', '05f', '05b', '05g', '05c', '05h', '05d']),
        zoom: cat(c.e07a, c.e07b), samples1: cat(c.e08a, c.e08b, c.e08c, c.e08d), samples2: cat(c.e04a, c.e04b, c.e04c, c.e04d),
      };
    },
  },
  {
    Board: TMNT,
    chips: [
      ['x23', 0x20000, [/^963-x23/]], ['x24', 0x20000, [/^963-x24/]], ['x21', 0x10000, [/^963-x21/]], ['x22', 0x10000, [/^963-x22/]],
      ['sound', 0x8000, [/^963-?e20/]], ['a28', 0x80000, [/^963-?a28/]], ['a29', 0x80000, [/^963-?a29/]],
      ['a17', 0x80000, [/^963-?a17/]], ['a18', 0x80000, [/^963-?a18/]], ['a15', 0x80000, [/^963-?a15/]], ['a16', 0x80000, [/^963-?a16/]],
      ['prom', 0x100, [/^963-?a30/]], ['a26', 0x20000, [/^963-?a26/]], ['a27', 0x20000, [/^963-?a27/]], ['a25', 0x80000, [/^963-?a25/]],
    ],
    assemble: (c) => ({
      main: cat(interleave(c.x23, c.x24), interleave(c.x21, c.x22)), sound: c.sound,
      tiles: cat(c.a28, c.a29), sprites: cat(c.a17, c.a18, c.a15, c.a16), prom: c.prom,
      samples: c.a26, speech: c.a27, title: c.a25,
    }),
  },
  {
    Board: MissingInAction,
    chips: [
      ['t20', 0x20000, [/^808t20/]], ['t21', 0x20000, [/^808t21/]], ['sound', 0x8000, [/^808e03/]],
      ['e12', 0x10000, [/^808e12/]], ['e13', 0x10000, [/^808e13/]], ['e22', 0x10000, [/^808e22/]], ['e23', 0x10000, [/^808e23/]],
      ['d17', 0x80000, [/^808d17/]], ['d15', 0x80000, [/^808d15/]], ['samples', 0x20000, [/^808d01/]],
    ],
    assemble: (c) => ({
      main: interleave(c.t20, c.t21), sound: c.sound,
      tiles: cat(interleave(c.e12, c.e13), interleave(c.e22, c.e23)), sprites: cat(c.d17, c.d15), samples: c.samples,
    }),
  },
  {
    Board: Aliens,
    chips: [
      ['e24', 0x10000, [/^e24_j02\.bin$/]], ['c24', 0x20000, [/^c24_j01\.bin$/]], ['sound', 0x8000, [/^g04_b03\.bin$/]],
      ['t0', 0x80000, [/^k13_b11\.bin$/]], ['t1', 0x40000, [/^j13_b07\.bin$/]], ['t2', 0x80000, [/^k19_b12\.bin$/]], ['t3', 0x40000, [/^j19_b08\.bin$/]],
      ['s0', 0x80000, [/^k08_b10\.bin$/]], ['s1', 0x40000, [/^j08_b06\.bin$/]], ['s2', 0x80000, [/^k02_b09\.bin$/]], ['s3', 0x40000, [/^j02_b05\.bin$/]],
      ['samples', 0x40000, [/^875b04\.bin$/]],
    ],
    assemble: (c) => {
      const main = new Uint8Array(0x38000);
      main.set(c.e24.subarray(0, 0x8000), 0x10000); main.set(c.e24.subarray(0x8000), 0x8000); main.set(c.c24, 0x18000);
      // Each graphics half: a 512K and a 256K ROM, the rest empty.
      const gfx = (a, b, c2, d) => { const r = new Uint8Array(0x200000); r.set(a, 0); r.set(b, 0x80000); r.set(c2, 0x100000); r.set(d, 0x180000); return r; };
      return { main, sound: c.sound, tiles: gfx(c.t0, c.t1, c.t2, c.t3), sprites: gfx(c.s0, c.s1, c.s2, c.s3), samples: c.samples };
    },
  },
  {
    Board: RoboCop,
    chips: [
      ['m05', 0x10000, [/^e[pm]05/]], ['m01', 0x10000, [/^e[pm]01/]], ['m04', 0x10000, [/^ep04/]], ['m00', 0x10000, [/^ep00/]],
      ['sound', 0x8000, [/^ep03/]],
      ['sub', 0x200, [/^en_24\.a2$/]],
      ...[23, 22, 20, 21, 18, 19, 14, 15, 16, 17, 7, 6, 11, 10, 9, 8, 13, 12, 2].map((n) => [`g${n}`, null, [new RegExp(`^ep${String(n).padStart(2, '0')}$`)]]),
    ],
    assemble: (c) => {
      const sub = new Uint8Array(0x10000); sub.set(c.sub, 0x1E00);
      // Sprites: a 64K and a 32K ROM per plane quarter, the 32K one followed by a gap.
      const sprites = new Uint8Array(0x80000);
      [[7, 0], [6, 0x10000], [11, 0x20000], [10, 0x30000], [9, 0x40000], [8, 0x50000], [13, 0x60000], [12, 0x70000]].forEach(([n, at]) => sprites.set(c[`g${n}`], at));
      return {
        main: cat(interleave(c.m05, c.m01), interleave(c.m04, c.m00)), sound: c.sound, sub,
        chars: cat(c.g23, c.g22), tiles2: cat(c.g20, c.g21, c.g18, c.g19), tiles3: cat(c.g14, c.g15, c.g16, c.g17),
        sprites, samples: c.g2,
      };
    },
  },
  {
    Board: Silkworm,
    chips: [...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((n) => [`s${n}`, null, [new RegExp(`^silkworm\\.${n}$`)]])],
    assemble: (c) => ({
      main: cat(c.s4, c.s5), sound: c.s3, chars: c.s2, sprites: cat(c.s6, c.s7, c.s8, c.s9),
      fg: cat(c.s10, c.s11, c.s12, c.s13), bg: cat(c.s14, c.s15, c.s16, c.s17), adpcm: c.s1,
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
  {
    Board: Shinobi,
    chips: [['a4', 0x10000, [/^shinobi\.a4$/]], ['a1', 0x10000, [/^shinobi\.a1$/]], ['p3', 0x10000, [/^epr11283/]], ['p4', 0x10000, [/^epr11281/]],
      ['b9', 0x10000, [/^shinobi\.b9$/]], ['b10', 0x10000, [/^shinobi\.b10$/]], ['b11', 0x10000, [/^shinobi\.b11$/]],
      ...[90, 91, 92, 93, 94, 95, 96, 97].map((n) => [`s${n}`, 0x10000, [new RegExp(`^epr112${n}`)]]),
      ['a7', 0x8000, [/^shinobi\.a7$/]], ['a8', 0x8000, [/^shinobi\.a8$/]], ['a9', 0x8000, [/^shinobi\.a9$/]]],
    assemble: (c) => {
      const main = new Uint8Array(0x40000);
      const pair = (dst, even, odd, at) => { for (let i = 0; i < even.length; i++) { dst[at + i * 2] = even[i]; dst[at + i * 2 + 1] = odd[i]; } };
      pair(main, c.a4, c.a1, 0); pair(main, c.p3, c.p4, 0x20000);
      const sprites = new Uint8Array(0x80000);
      [[94, 90], [95, 91], [96, 92], [97, 93]].forEach(([e, o], k) => pair(sprites, c[`s${e}`], c[`s${o}`], k * 0x20000));
      return { main, tiles: cat(c.b9, c.b10, c.b11), sprites, sound: c.a7, samples: [c.a8, c.a9] };
    },
  },
  ...[
    // Midway Y-unit: [Board, program [low, high] (byte-interleaved, ending at the top of 1MB), sound, samples, gfx [plane chunk 0, 1, 2]]
    [SmashTV, ['u105', 'u89'], ['u4', 'u19', 'u20'], null, [['u111', 'u112', 'u113'], ['u95', 'u96', 'u97'], ['u106', 'u107', 'u108']]],
    [TotalCarnage, ['tcu105', 'tcu89'], ['tcu3'], ['tcu12', 'tcu13'], [['tcu111', 'tcu112', 'tcu113', 'tcu114'], ['tcu95', 'tcu96', 'tcu97', 'tcu98'], ['tcu106', 'tcu107', 'tcu108', 'tcu109']]],
    [MortalKombat, ['mkg-u105', 'mkg-u89'], ['mks-u3'], ['mks-u12', 'mks-u13'], [['mkg-u111', 'mkg-u112', 'mkg-u113', 'mkg-u114'], ['mkg-u95', 'mkg-u96', 'mkg-u97', 'mkg-u98'], ['mkg-u106', 'mkg-u107', 'mkg-u108', 'mkg-u109']]],
  ].map(yunitEntry),
  ...[
    // Namco System 86. Each ROM is [name pattern, offset]; sizes come from the files.
    { Board: RollingThunder, main: 'rt3[-_]1b\\.9c', sub: [['rt3[-_]2b\\.12c', 0]], subBank: 'rt3[-_]3\\.12d', mcu: [['rt[13][-_]4\\.6b', 0x4000]],
      t1: ['rt1[-_]7\\.7r', 'rt1[-_]8\\.7s'], t2: ['rt1[-_]5\\.4r', 'rt1[-_]6\\.4s'], sprites: [0x80000, ...['9.12h', '10.12k', '11.12l', '12.12m', '13.12p', '14.12r', '15.12t', '16.12u'].map((n, k) => [`rt1[-_]${n.replace('.', '\\.')}`, k * 0x10000])],
      proms: ['(mb7124e|rt1-1)\\.3r', '(mb7116e|rt1-2)\\.3s', '(mb7138h|rt1-3)\\.4v', '(mb7138h\\.6v|rt1-4\\.5v)', '(mb7112e|rt1-5)\\.6u'],
      user: [['rt1[-_]17\\.f1', 0], ['rt1[-_]18\\.h1', 0x10000], ['rt[13][-_]19\\.k1', 0x20000], ['rt[13][-_]20\\.m1', 0x30000]], voice: [['rt1[-_]21\\.f3', 0], ['rt[12][-_]22\\.h3', 0x20000]] },
    { Board: WonderMomo, main: 'wm1[-_]1\\.9c', sub: [['wm1[-_]2\\.12c', 0]], mcu: [['wm1[-_]3\\.6b', 0x4000]],
      t1: ['wm1[-_]6\\.7r', 'wm1[-_]7\\.7s'], t2: ['wm1[-_]4\\.4r', 'wm1[-_]5\\.4s'], sprites: [0x80000, ...[8, 9, 10, 11, 12, 13, 14, 15].map((n, k) => [`wm1[-_]${n}\\.12[hklmprtu]`, k * 0x10000])],
      proms: ['wm1-1\\.3r', 'wm1-2\\.3s', 'wm1-3\\.4v', 'wm1-4\\.5v', 'wm1-5\\.6u'],
      user: [['wm1[-_]16\\.f1', 0]], voice: [['wm1[-_]17\\.f3', 0], ['wm1[-_]18\\.h3', 0x20000], ['wm1[-_]19\\.k3', 0x40000], ['wm1[-_]20\\.m3', 0x60000]] },
    { Board: Genpei, main: 'gt1[-_]1b\\.9c', sub: [['gt1[-_]2\\.12c', 0x4000]], mcu: [['gt1[-_]3\\.6b', 0x4000]],
      t1: ['gt1[-_]7\\.7r', 'gt1[-_]6\\.7s'], t2: ['gt1[-_]5\\.4r', 'gt1[-_]4\\.4s'],
      sprites: [0x100000, ['gt1[-_]11\\.12h', 0], ['gt1[-_]12\\.12k', 0x20000], ['gt1[-_]13\\.12l', 0x40000], ['gt1[-_]14\\.12m', 0x60000], ['gt1[-_]15\\.12p', 0x80000], ['gt1[-_]16\\.12r', 0xA0000], ['gt1[-_]8\\.12t', 0xC0000], ['gt1[-_]9\\.12u', 0xE0000]],
      proms: ['gt1-1\\.3r', 'gt1-2\\.3s', 'gt1-3\\.4v', 'gt1-4\\.5v', 'gt1-5\\.6u'],
      user: [['gt1[-_]10b\\.f1', 0]], voice: [['gt1[-_]17\\.f3', 0], ['gt1[-_]18\\.h3', 0x20000], ['gt1[-_]19\\.k3', 0x40000]] },
    { Board: ReturnOfIshtar, main: 'ri1[-_]1c\\.9c', bank9d: ['ri1[-_]2\\.9d', 0x4000], sub: [['ri1[-_]3\\.12c', 0]], mcu: [['ri1[-_]4\\.6b', 0, 0x8000]],
      t1: ['ri1[-_]14\\.7r', 'ri1[-_]15\\.7s'], t2: ['ri1[-_]12\\.4r', 'ri1[-_]13\\.4s'], sprites: [0x40000, ...[5, 6, 7, 8, 9, 10, 11].map((n, k) => [`ri1[-_]${n}\\.12[hklmprt]`, k * 0x8000])],
      proms: ['ri1-1\\.3r', 'ri1-2\\.3s', 'ri1-3\\.4v', 'ri1-4\\.5v', 'ri1-5\\.6u'] },
    { Board: HoppingMappy, main: '(hm1|hm1_1\\.9c)', sub: [['(hm2|hm1_2\\.12c)', 0x4000]], mcu: [['(hm3|hm1_3\\.6b)', 0x8000]], mcuInt: '(pl1|rt1|cus60).*',
      t1: ['(hm6|hm1_6\\.7r)', null], t2: ['(hm5|hm1_5\\.4r)', null], sprites: [0x40000, ['(hm4|hm1_4\\.12h)', 0]],
      proms: ['(hm11\\.bpr|hm1-1\\.3r)', '(hm12\\.bpr|hm1-2\\.3s)', '(hm13\\.bpr|hm1-3\\.4v)', '(hm14\\.bpr|hm1-4\\.5v)', '(hm15\\.bpr|hm1-5\\.6u)'] },
    { Board: SkyKidDeluxe, main: 'sk3[-_]1b\\.9c', bank9d: ['sk3[-_]2\\.9d', 0], sub: [['sk3[-_]3\\.12c', 0]], mcu: [['sk3[-_]4\\.6b', 0x8000]],
      t1: ['sk3[-_]9\\.7r', 'sk3[-_]10\\.7s'], t2: ['sk3[-_]7\\.4r', 'sk3[-_]8\\.4s'], sprites: [0x40000, ['sk3[-_]5\\.12h', 0], ['sk3[-_]6\\.12k', 0x8000]],
      proms: ['sk3-1\\.3r', 'sk3-2\\.3s', 'sk3-3\\.4v', 'sk3-4\\.5v', 'sk3-5\\.6u'] },
  ].map(s86Entry),
  {
    Board: LegendOfKage,
    chips: [['p1', 0x8000, [/^a54-01-1/]], ['p2', 0x8000, [/^a54-02-1/]], ['snd', 0x8000, [/^a54-04/]], ['mcu', 0x800, [/^a54-09/]], ['data', 0x4000, [/^a54-03/]],
      ['g5', 0x4000, [/^a54-05-1/]], ['g6', 0x4000, [/^a54-06-1/]], ['g7', 0x4000, [/^a54-07-1/]], ['g8', 0x4000, [/^a54-08-1/]]],
    assemble: (c) => ({ main: cat(c.p1, c.p2), sound: c.snd, mcu: c.mcu, data: c.data, gfx: cat(c.g5, c.g6, c.g7, c.g8) }),
  },
  ...[
    // Gottlieb: [Board, main [file, address]..., sound [file, address]..., tiles (null: RAM), sprites (fg3..fg0), ROM in RAM space]
    [MadPlanets, [['rom4', 0x6000], ['rom3', 0x8000], ['rom2', 0xA000], ['rom1', 0xC000], ['rom0', 0xE000]], [['snd1', 0xF000], ['snd2', 0xF800]], ['bg0', 'bg1'], ['fg3', 'fg2', 'fg1', 'fg0'], null],
    [Krull, [['rom4\\.bin', 0x6000], ['rom3\\.bin', 0x8000], ['rom2\\.bin', 0xA000], ['rom1\\.bin', 0xC000], ['rom0\\.bin', 0xE000]], [['snd1\\.bin', 0xE000], ['snd2\\.bin', 0xF000]], null,
      ['fg3\\.bin', 'fg2\\.bin', 'fg1\\.bin', 'fg0\\.bin'], ['ram2\\.bin', 'ram4\\.bin']],
    [QbertsQubes, [['qq-rom3\\.bin', 0x8000], ['qq-rom2\\.bin', 0xA000], ['qq-rom1\\.bin', 0xC000], ['qq-rom0\\.bin', 0xE000]], [['qb-snd1\\.bin', 0xF000], ['qb-snd2\\.bin', 0xF800]],
      ['qq-bg0\\.bin', 'qq-bg1\\.bin'], ['qq-fg3\\.bin', 'qq-fg2\\.bin', 'qq-fg1\\.bin', 'qq-fg0\\.bin'], null],
  ].map(([Board, main, sound, tiles, sprites, ramRom]) => {
    const re = (p) => [new RegExp(`^${p}(\\..*)?$`)];
    const all = [...main.map(([p]) => p), ...sound.map(([p]) => p), ...(tiles || []), ...sprites, ...(ramRom || [])];
    return {
      Board,
      chips: all.map((p) => [p, null, re(p)]),
      assemble: (c) => {
        const m = new Uint8Array(0x10000).fill(0xFF), snd = new Uint8Array(0x10000).fill(0xFF);
        for (const [p, at] of main) m.set(c[p], at);
        for (const [p, at] of sound) snd.set(c[p], at);
        return { main: m, sound: snd, tiles: tiles ? cat(...tiles.map((p) => c[p])) : null, sprites: cat(...sprites.map((p) => c[p])),
          ramRom: ramRom ? cat(...ramRom.map((p) => c[p])) : null };
      },
    };
  }),
  {
    Board: Qbert,
    chips: [['rom0', 0x2000, [/^qb-rom0/]], ['rom1', 0x2000, [/^qb-rom1/]], ['rom2', 0x2000, [/^qb-rom2/]], ['snd1', 0x800, [/^qb-snd1/]], ['snd2', 0x800, [/^qb-snd2/]],
      ['bg0', 0x1000, [/^qb-bg0/]], ['bg1', 0x1000, [/^qb-bg1/]], ['fg0', 0x2000, [/^qb-fg0/]], ['fg1', 0x2000, [/^qb-fg1/]], ['fg2', 0x2000, [/^qb-fg2/]], ['fg3', 0x2000, [/^qb-fg3/]]],
    assemble: (c) => {
      const main = new Uint8Array(0x10000).fill(0xFF), sound = new Uint8Array(0x10000).fill(0xFF);
      main.set(c.rom2, 0xA000); main.set(c.rom1, 0xC000); main.set(c.rom0, 0xE000);
      sound.set(c.snd1, 0xF000); sound.set(c.snd2, 0xF800);
      return { main, sound, tiles: cat(c.bg0, c.bg1), sprites: cat(c.fg3, c.fg2, c.fg1, c.fg0) };
    },
  },
  ...[
    // Irem M72 family: [Board, program [file, offset, 'even'|'odd', reload offset?], sound, sprites, tiles1, tiles2, samples, sprites2]
    [RType, [['rt_r-l0-', 0, 'even'], ['rt_r-h0-', 0, 'odd'], ['rt_r-l1-', 0x20000, 'even', 0xE0000], ['rt_r-h1-', 0x20000, 'odd', 0xE0000]], null,
      ['cpu-00', 'cpu-01', 'cpu-10', 'cpu-11', 'cpu-20', 'cpu-21', 'cpu-30', 'cpu-31'], ['cpu-a0', 'cpu-a1', 'cpu-a2', 'cpu-a3'], ['cpu-b0', 'cpu-b1', 'cpu-b2', 'cpu-b3'], null],
    [RType2, [['ic60.9d', 0, 'even'], ['ic54.8d', 0, 'odd'], ['ic59.9b', 0x40000, 'even', 0xC0000], ['ic53.8b', 0x40000, 'odd', 0xC0000]], 'ic17.4f',
      ['ic31.6l', 'ic21.4l', 'ic32.6m', 'ic22.4m'], ['ic50.7s', 'ic51.7u', 'ic56.8s', 'ic57.8u', 'ic65.9r', 'ic66.9u', 'ic63.9m', 'ic64.9p'], null, 'ic14.4c'],
    [HammerinHarry, [['a-l0-v', 0, 'even'], ['a-h0-v', 0, 'odd'], ['a-l1-0', 0x60000, 'even', 0xE0000], ['a-h1-0', 0x60000, 'odd', 0xE0000]], 'a-sp-0',
      ['hh_00', 'hh_10', 'hh_20', 'hh_30'], ['hh_a0', 'hh_a1', 'hh_a2', 'hh_a3'], null, 'a-v0-0'],
    [MajorTitle, [['mt_l0', 0, 'even'], ['mt_m0', 0, 'odd'], ['mt_l1', 0x40000, 'even', 0xC0000], ['mt_m1', 0x40000, 'odd', 0xC0000]], 'mt_sp',
      ['mt_n0', 'mt_n1', 'mt_n2', 'mt_n3'], ['mt_c0', 'mt_c1', 'mt_c2', 'mt_c3'], null, 'mt_vo', ['mt_f0', 'mt_f1', 'mt_f2', 'mt_f3']],
    [BattleChopper, [['c-l0-b', 0, 'even'], ['c-h0-b', 0, 'odd'], ['c-l1-b', 0x20000, 'even'], ['c-h1-b', 0x20000, 'odd'], ['c-l3-b', 0x60000, 'even', 0xE0000], ['c-h3-b', 0x60000, 'odd', 0xE0000]], null,
      ['c-00-a', 'c-01-b', 'c-10-a', 'c-11-b', 'c-20-a', 'c-21-b', 'c-30-a', 'c-31-b'], ['b-a0-b', 'b-a1-b', 'b-a2-b', 'b-a3-b'], ['b-b0-', 'b-b1-', 'b-b2-', 'b-b3-'], 'c-v0-b'],
    [NinjaSpirit, [0, 1, 2, 3].flatMap((k) => [[`nin-c-l${k}`, k * 0x20000, 'even', k === 3 ? 0xE0000 : undefined], [`nin-c-h${k}`, k * 0x20000, 'odd', k === 3 ? 0xE0000 : undefined]]), null,
      ['nin-r00', 'nin-r10', 'nin-r20', 'nin-r30'], ['nin-b-a0', 'nin-b-a1', 'nin-b-a2', 'nin-b-a3'], ['nin-b0', 'nin-b1', 'nin-b2', 'nin-b3'], 'nin-v0'],
    [ImageFight, [['if-c-l0', 0, 'even'], ['if-c-h0', 0, 'odd'], ['if-c-l3', 0x40000, 'even', 0xC0000], ['if-c-h3', 0x40000, 'odd', 0xC0000]], null,
      ['if-c-00', 'if-c-10', 'if-c-20', 'if-c-30'], ['if-a-a0', 'if-a-a1', 'if-a-a2', 'if-a-a3'], ['if-a-b0', 'if-a-b1', 'if-a-b2', 'if-a-b3'], ['if-c-v0', 'if-c-v1']],
    [HeroTonma, [['tom_c-l0', 0, 'even'], ['tom_c-h0', 0, 'odd'], ['tom_c-l3', 0x40000, 'even', 0xC0000], ['tom_c-h3', 0x40000, 'odd', 0xC0000]], null,
      ['tom_m53', 'tom_m51', 'tom_m49', 'tom_m47'], ['tom_m21', 'tom_m22', 'tom_m20', 'tom_m23'], ['tom_m26', 'tom_m27', 'tom_m25', 'tom_m24'], 'tom_m44'],
    [XMultiply, [['cl3.l3', 0, 'even'], ['ch3.h3', 0, 'odd'], ['cl0.l0', 0x40000, 'even', 0xE0000], ['ch0.h0', 0x40000, 'odd', 0xE0000]], null,
      ['t44.00', 't45.01', 't46.10', 't47.11', 't48.20', 't49.21', 't50.30', 't51.31'], ['t53.a0', 't54.a1', 't55.a2', 't56.a3'], ['t57.b0', 't58.b1', 't59.b2', 't60.b3'], 't52.v0'],
    [DragonBreed, [['db_c-l3', 0, 'even'], ['db_c-h3', 0, 'odd'], ['db_c-l0', 0x60000, 'even', 0xE0000], ['db_c-h0', 0x60000, 'odd', 0xE0000]], null,
      ['db_k800m', 'db_k801m', 'db_k802m', 'db_k803m'], ['db_a0m', 'db_a1m', 'db_a2m', 'db_a3m'], ['db_b0m', 'db_b1m', 'db_b2m', 'db_b3m'], 'db_c-v0'],
    [AirDuel, [['ad-c-l0', 0, 'even'], ['ad-c-h0', 0, 'odd'], ['ad-c-l3', 0x40000, 'even', 0xC0000], ['ad-c-h3', 0x40000, 'odd', 0xC0000]], null,
      ['ad-00', 'ad-10', 'ad-20', 'ad-30'], ['ad-a0', 'ad-a1', 'ad-a2', 'ad-a3'], ['ad-b0', 'ad-b1', 'ad-b2', 'ad-b3'], 'ad-v0'],
    [Gallop, [['cc-c-l0', 0, 'even'], ['cc-c-h0', 0, 'odd'], ['cc-c-l3', 0x40000, 'even', 0xC0000], ['cc-c-h3', 0x40000, 'odd', 0xC0000]], null,
      ['cc-c-00', 'cc-c-10', 'cc-c-20', 'cc-c-30'], ['cc-b-a0', 'cc-b-a1', 'cc-b-a2', 'cc-b-a3'], ['cc-b-b0', 'cc-b-b1', 'cc-b-b2', 'cc-b-b3'], 'cc-c-v0'],
  ].map(m72Entry),
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

// An Irem M72-family registry entry (see the table above).
function m72Entry([Board, prog, sound, sprites, tiles1, tiles2, samples, sprites2]) {
  const sampleList = samples ? [].concat(samples) : [];
  const names = [...prog.map((p) => p[0]), ...(sound ? [sound] : []), ...sprites, ...tiles1, ...(tiles2 || []), ...sampleList, ...(sprites2 || [])];
  const esc = (n) => n.replace(/[.]/g, '\\.');
  return {
    Board,
    chips: names.map((n) => [n, null, [new RegExp(`^${esc(n)}(\\.(bin|rom))?$`)]]),
    assemble: (c) => {
      const main = new Uint8Array(0x100000).fill(0xFF);
      for (const [n, at, half, reload] of prog) {
        const r = c[n], k = half === 'odd' ? 1 : 0;
        for (const base of reload === undefined ? [at] : [at, reload]) for (let i = 0; i < r.length; i++) main[base + i * 2 + k] = r[i];
      }
      const join = (list) => (list ? cat(...list.map((n) => c[n])) : null);
      return { main, sound: sound ? c[sound] : null, sprites: join(sprites), tiles1: join(tiles1), tiles2: join(tiles2), samples: sampleList.length ? join(sampleList) : null, sprites2: join(sprites2) };
    },
  };
}

// Namco System 86 sets (see the table above): pieces placed into each CPU's space and the graphics regions.
function s86Entry(g) {
  const re = (p) => [new RegExp(`^${p}$`)];
  const chips = [['main', 0x8000, re(g.main)], ['mcuInt', 0x1000, re(g.mcuInt || '(rt1-mcu\\.bin|cus60.*)')]];
  const add = (role, p) => chips.push([role, null, re(p)]);
  if (g.bank9d) add('bank9d', g.bank9d[0]);
  g.sub.forEach(([p], i) => add(`sub${i}`, p));
  if (g.subBank) add('subBank', g.subBank);
  g.mcu.forEach(([p], i) => add(`mcu${i}`, p));
  add('t1a', g.t1[0]); if (g.t1[1]) add('t1b', g.t1[1]);
  add('t2a', g.t2[0]); if (g.t2[1]) add('t2b', g.t2[1]);
  g.sprites.slice(1).forEach(([p], i) => add(`spr${i}`, p));
  g.proms.forEach((p, i) => add(`prom${i}`, p));
  (g.user || []).forEach(([p], i) => add(`user${i}`, p));
  (g.voice || []).forEach(([p], i) => add(`voice${i}`, p));
  return {
    Board: g.Board, chips,
    assemble: (c) => {
      const sub = new Uint8Array(0x8000).fill(0xFF);
      g.sub.forEach(([, at], i) => sub.set(c[`sub${i}`], at));
      const mcu = new Uint8Array(0x10000).fill(0xFF);
      g.mcu.forEach(([, at, split], i) => {
        const r = c[`mcu${i}`];
        if (split) { mcu.set(r.subarray(0, 0x4000), at); mcu.set(r.subarray(0x4000), split); } else mcu.set(r, at);
      });
      mcu.set(c.mcuInt, 0xF000);
      // Tiles: planes 1-2 then plane 3 (missing plane 3 reads as 0s, inverted to 1s like the others).
      const tiles = (a, b) => cat(c[a], b ? c[b] : new Uint8Array(c[a].length / 2));
      const sprites = new Uint8Array(g.sprites[0]);
      g.sprites.slice(1).forEach(([, at], i) => sprites.set(c[`spr${i}`], at));
      let user = null;
      if (g.user) { user = new Uint8Array(0x40000); g.user.forEach(([, at], i) => user.set(c[`user${i}`], at)); }
      else if (g.bank9d) { user = new Uint8Array(0x8000); user.set(c.bank9d, g.bank9d[1]); }
      const voice = new Uint8Array(0x80000).fill(0xFF);
      (g.voice || []).forEach(([, at], i) => voice.set(c[`voice${i}`], at));
      return {
        main: c.main, sub, subBank: c.subBank || null, mcu, user: user || new Uint8Array(0x8000), voice,
        tiles1: tiles('t1a', g.t1[1] && 't1b'), tiles2: tiles('t2a', g.t2[1] && 't2b'), sprites,
        rg: c.prom0, b: c.prom1, tileCt: c.prom2, spriteCt: c.prom3, decoder: c.prom4,
      };
    },
  };
}

// Midway Y-unit sets: ROMs are matched by name prefix (the extensions vary between dumps).
function yunitEntry([Board, program, sound, samples, gfx]) {
  const re = (n) => [new RegExp(`^${n.replace('-', '[-_]')}\\.`)];
  const names = [...program, ...sound, ...(samples || []), ...gfx.flat()];
  return {
    Board,
    chips: names.map((n) => [n, null, re(n)]),
    assemble: (c) => {
      const lo = c[program[0]], hi = c[program[1]], prog = new Uint8Array(0x100000);
      const base = 0x100000 - lo.length * 2;
      for (let i = 0; i < lo.length; i++) { prog[base + i * 2] = lo[i]; prog[base + i * 2 + 1] = hi[i]; }
      let snd;
      if (sound.length === 3) {                    // CVSD board: three 64K ROMs, each twice, 128K apart
        snd = new Uint8Array(0x80000);
        sound.forEach((n, k) => { snd.set(c[n], k * 0x20000); snd.set(c[n], k * 0x20000 + 0x10000); });
      } else {
        snd = new Uint8Array(0x40000);
        for (let o = 0; o < 0x40000; o += c[sound[0]].length) snd.set(c[sound[0]], o);
      }
      let smp = null;
      if (samples) {
        smp = new Uint8Array(0x200000);
        samples.forEach((n, k) => { smp.set(c[n], k * 0x80000); smp.set(c[n], k * 0x80000 + 0x40000); });
      }
      const g = new Uint8Array(0x800000);
      gfx.forEach((list, chunk) => { let o = chunk * 0x200000; for (const n of list) { g.set(c[n], o); o += c[n].length; } });
      return { program: prog, sound: snd, samples: smp, gfx: g };
    },
  };
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
