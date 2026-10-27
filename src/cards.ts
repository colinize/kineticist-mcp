// The data behind the cards Claude and ChatGPT draw next to the hosted
// server's answers (MCP Apps): a game, places to play, what's new, a game
// search, a site search and a design team. One page draws them all
// (src/lib/api/mcp-cards.ts) and picks the layout by `kind`. Each builder
// keeps only what its card shows, so the data stays small.

export const CARD_URI = "ui://kineticist/card.html";
export const CARD_MIME = "text/html;profile=mcp-app";

export interface GameCardEdition {
  label: string;
  /** List price in whole dollars, or null when there's none on file. */
  price: number | null;
  /** Units made, when known. */
  run: number | null;
  /** Year it came out, only when it differs from the game's first year. */
  year: number | null;
}

export interface GameCardRemake {
  name: string;
  manufacturer: string | null;
  first_year: number | null;
  url: string | null;
  /** Set on the newest remake when the game's in-production flag comes from it. */
  in_production: boolean;
  editions: GameCardEdition[];
}

export interface GameCardCredit {
  role: string;
  names: string[];
}

export interface GameCard {
  kind: "game";
  name: string;
  url: string | null;
  image: { url: string; width: number | null; height: number | null } | null;
  manufacturer: string | null;
  year: number | null;
  display: string | null;
  players: number | null;
  fun_score: number | null;
  ratings_count: number | null;
  in_production: boolean;
  tags: string[];
  editions: GameCardEdition[];
  remakes: GameCardRemake[];
  credits: GameCardCredit[];
  /** People on the team not named in `credits`. */
  more_credits: number;
  tutorial_url: string | null;
}

type Json = Record<string, unknown>;

const LEAD_ROLES = ["Design", "Art", "Software"];
const MAX_TAGS = 3;
const MAX_NAMES_PER_ROLE = 2;
// Tags the meta line already says (decades, the technology).
const SKIPPED_TAG = /^(\d{4}s|solid state|electro-?mechanical|em)$/i;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function yearOf(date: unknown): number | null {
  const s = str(date);
  const y = s ? Number(s.slice(0, 4)) : NaN;
  return Number.isInteger(y) && y > 1900 ? y : null;
}

/**
 * "Godzilla (Pro)" → "Pro"; "Medieval Madness (Remake Royal Edition)" under a
 * remake → "Royal Edition"; a bare remake edition → "Standard".
 */
export function editionLabel(edition: Json, inRemake: boolean): string {
  const name = str(edition.name) ?? "";
  const inner = /\(([^)]+)\)\s*$/.exec(name)?.[1]?.trim();
  let label = str(edition.trim_level) ?? inner ?? name;
  if (inRemake) label = label.replace(/^remake\b\s*/i, "").trim() || "Standard";
  return label || "Standard";
}

function editionsOf(list: unknown, firstYear: number | null, inRemake: boolean): GameCardEdition[] {
  if (!Array.isArray(list)) return [];
  return (list as Json[]).map((e) => {
    const year = yearOf(e.manufacture_date);
    return {
      label: editionLabel(e, inRemake),
      price: num(e.msrp),
      run: num(e.production_run),
      year: year !== null && year !== firstYear ? year : null,
    };
  });
}

function creditsOf(list: unknown): { credits: GameCardCredit[]; more: number } {
  if (!Array.isArray(list)) return { credits: [], more: 0 };
  const byRole = new Map<string, string[]>();
  const everyone = new Set<string>();
  for (const c of list as Json[]) {
    const role = str(c.role_name);
    const name = str((c.person as Json | undefined)?.name);
    if (!role || !name) continue;
    everyone.add(name);
    const names = byRole.get(role) ?? [];
    if (!names.includes(name)) names.push(name);
    byRole.set(role, names);
  }
  const credits = LEAD_ROLES.filter((r) => byRole.has(r)).map((role) => ({ role, names: byRole.get(role)!.slice(0, MAX_NAMES_PER_ROLE) }));
  const named = new Set(credits.flatMap((c) => c.names));
  return { credits, more: [...everyone].filter((n) => !named.has(n)).length };
}

/** Build the card from a shaped game answer's `data` (after shapeGameData). */
export function buildGameCard(data: Json): GameCard {
  const firstYear = num(data.first_manufacture_year);
  const image = data.best_image as Json | null | undefined;
  const { credits, more } = creditsOf(data.credits);
  const tags = Array.isArray(data.tags)
    ? (data.tags as Json[]).map((t) => str(t.name)).filter((t): t is string => t !== null && !SKIPPED_TAG.test(t))
    : [];

  const remakes = Array.isArray(data.remakes)
    ? (data.remakes as Json[]).map((r) => {
        const years = Array.isArray(r.editions)
          ? (r.editions as Json[]).map((e) => yearOf(e.manufacture_date)).filter((y): y is number => y !== null)
          : [];
        const first = years.length ? Math.min(...years) : null;
        return {
          name: str(r.name) ?? "Remake",
          manufacturer: str(r.manufacturer),
          first_year: first,
          url: str(r.url),
          in_production: false,
          editions: editionsOf(r.editions, first, true),
        };
      })
    : [];

  // A game's in_production and last year include its remakes' editions
  // (remake_editions_note), so with a remake the flag belongs on the newest one.
  const inProduction = data.in_production === true;
  if (inProduction && remakes.length > 0) {
    const newest = remakes.reduce((a, b) => ((b.first_year ?? 0) > (a.first_year ?? 0) ? b : a));
    newest.in_production = true;
  }

  return {
    kind: "game",
    name: str(data.name) ?? "",
    url: str(data.url),
    image: image && str(image.url) ? { url: image.url as string, width: num(image.width), height: num(image.height) } : null,
    manufacturer: str((data.manufacturer as Json | undefined)?.name),
    year: firstYear,
    display: str(data.display_type),
    players: num(data.player_count),
    fun_score: num(data.average_fun_score),
    ratings_count: num(data.ratings_count),
    in_production: inProduction && remakes.length === 0,
    tags: tags.slice(0, MAX_TAGS),
    editions: editionsOf(data.editions, firstYear, false),
    remakes,
    credits,
    more_credits: more,
    tutorial_url: str(data.full_tutorial_link),
  };
}

// ---------------------------------------------------------------------------
// Places to play (where_to_play)
// ---------------------------------------------------------------------------

export interface PlacesCard {
  kind: "places";
  searched: string;
  game: string | null;
  note: string | null;
  venues: { name: string; url: string | null; city: string | null; kind: string | null; miles: number | null; machines: number | null }[];
}

// Same labels and order as the site's result rows (rowKindLabel in
// src/lib/location-kinds.ts; a test keeps the two in step).
export const PLACE_KIND_LABEL: Record<string, string> = {
  arcades: "Arcade",
  bars: "Bar or brewery",
  family: "Family spot",
  museums: "Museum",
};
const PLACE_KIND_PRIORITY = ["museums", "bars", "family", "arcades"];

export function placeKindLabel(kinds: unknown): string | null {
  const list = Array.isArray(kinds) ? kinds : [];
  const key = PLACE_KIND_PRIORITY.find((k) => list.includes(k));
  return key ? PLACE_KIND_LABEL[key] : null;
}

/** null when the search found nothing to show (an error or no venues). */
export function buildPlacesCard(data: Json): PlacesCard | null {
  const venues = Array.isArray(data.venues) ? (data.venues as Json[]) : [];
  if (venues.length === 0) return null;
  return {
    kind: "places",
    searched: str(data.searched) ?? "",
    game: str((data.game as Json | undefined)?.name),
    note: str(data.note),
    venues: venues.map((v) => ({
      name: str(v.name) ?? "",
      url: str(v.url),
      city: str(v.city),
      kind: placeKindLabel(v.kinds),
      miles: num(v.distance_miles),
      machines: num(v.machines_count),
    })),
  };
}

// ---------------------------------------------------------------------------
// What's new (whats_new)
// ---------------------------------------------------------------------------

export interface NewsCard {
  kind: "news";
  since: string | null;
  /** The window was quiet and the news is the latest articles, not this week's. */
  latest: boolean;
  news: { title: string; date: string | null; url: string | null; image: string | null }[];
  creators: { title: string; creator: string | null; format: string | null; date: string | null; url: string | null; image: string | null }[];
  hype_top: { rank: number; name: string; url: string | null; change: number }[];
  hype_climbers: { rank: number; name: string; url: string | null; up: number }[];
}

const NEWS_CARD_HYPE = 5;

export function buildNewsCard(data: Json): NewsCard {
  const list = (v: unknown) => (Array.isArray(v) ? (v as Json[]) : []);
  const hype = (data.hype_index ?? {}) as Json;
  return {
    kind: "news",
    since: str(data.since),
    latest: Boolean(str(data.news_note)),
    news: list(data.news).map((a) => ({ title: str(a.title) ?? "", date: str(a.date), url: str(a.url), image: str(a.image) })),
    creators: list(data.from_creators).map((c) => ({
      title: str(c.title) ?? "",
      creator: str(c.creator),
      format: str(c.format),
      date: str(c.date),
      url: str(c.url),
      image: str(c.image),
    })),
    hype_top: list(hype.top)
      .slice(0, NEWS_CARD_HYPE)
      .map((h) => ({ rank: num(h.rank) ?? 0, name: str(h.name) ?? "", url: str(h.url), change: num(h.change_this_week) ?? 0 })),
    hype_climbers: list(hype.climbers)
      .slice(0, NEWS_CARD_HYPE)
      .map((h) => ({ rank: num(h.rank) ?? 0, name: str(h.name) ?? "", url: str(h.url), up: num(h.up) ?? 0 })),
  };
}

/** The answer's text without the pictures (they're for the card only). */
export function withoutImages(data: Json): Json {
  const strip = (v: unknown) => (Array.isArray(v) ? (v as Json[]).map(({ image: _image, ...rest }) => rest) : v);
  return { ...data, news: strip(data.news), from_creators: strip(data.from_creators) };
}

// ---------------------------------------------------------------------------
// Game search (search_pinball_games)
// ---------------------------------------------------------------------------

export interface GamesCard {
  kind: "games";
  title: string;
  filters: string[];
  total: number;
  games: { name: string; url: string | null; image: string | null; year: number | null; editions: number | null; fun_score: number | null }[];
}

/** A fun score from fewer readers than this says little; the grid leaves it off. */
export const MIN_RATINGS_FOR_SCORE = 5;
const GAMES_CARD_MAX = 12;

export function buildGamesCard(
  data: Json,
  args: { q?: string; manufacturer?: string; in_production?: boolean; year_from?: number; year_to?: number },
): GamesCard | null {
  const games = Array.isArray(data.data) ? (data.data as Json[]) : [];
  if (games.length === 0) return null;
  // Name the manufacturer as the results do ("stern" → "Stern Pinball Inc.")
  // when every game shares it.
  const makers = new Set(games.map((g) => str((g.manufacturer as Json | undefined)?.name)));
  const maker = args.manufacturer ? (makers.size === 1 ? [...makers][0] : args.manufacturer) : null;
  // "Stern Pinball Inc. games in production"; the year range and count go on the line below.
  const status = args.in_production === true ? " in production" : args.in_production === false ? " out of production" : "";
  const title = args.q ? `“${args.q}”` : maker ? `${maker} games${status}` : `Pinball machines${status}`;
  const filters: string[] = [];
  if (args.q && maker) filters.push(maker);
  if (args.q && status) filters.push(status.trim().replace(/^./, (c) => c.toUpperCase()));
  if (args.year_from && args.year_to) filters.push(args.year_from === args.year_to ? String(args.year_from) : `${args.year_from}–${args.year_to}`);
  else if (args.year_from) filters.push(`${args.year_from} and later`);
  else if (args.year_to) filters.push(`${args.year_to} and earlier`);
  const pagination = (data.pagination ?? {}) as Json;
  return {
    kind: "games",
    title,
    filters,
    total: num(pagination.total) ?? games.length,
    // The card draws a few tiles; the rest are counted, not sent.
    games: games.slice(0, GAMES_CARD_MAX).map((g) => {
      const ratings = num(g.ratings_count) ?? 0;
      return {
        name: str(g.name) ?? "",
        url: str(g.url),
        image: str(g.featured_image),
        year: num(g.first_manufacture_year),
        editions: num(g.editions_count),
        fun_score: ratings >= MIN_RATINGS_FOR_SCORE ? num(g.average_fun_score) : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Site search (search)
// ---------------------------------------------------------------------------

export interface SearchCard {
  kind: "search";
  query: string;
  results: { type: string; title: string; subtitle: string | null; url: string | null }[];
}

export function buildSearchCard(data: Json): SearchCard | null {
  const results = Array.isArray(data.results) ? (data.results as Json[]) : [];
  if (results.length === 0) return null;
  return {
    kind: "search",
    query: str(data.query) ?? "",
    results: results.map((r) => ({ type: str(r.type) ?? "", title: str(r.title) ?? "", subtitle: str(r.subtitle), url: str(r.url) })),
  };
}

// ---------------------------------------------------------------------------
// Design team (get_game_credits)
// ---------------------------------------------------------------------------

export interface TeamCard {
  kind: "team";
  game: { name: string; url: string | null; manufacturer: string | null; year: number | null };
  people: number;
  roles: { role: string; people: { name: string; url: string | null }[] }[];
}

// The site's role order; any other role follows in the order it first appears.
const ROLE_ORDER = ["Design", "Art", "Software", "Mechanics", "Animation", "Music", "Sound", "Callouts"];

/** `game` is the game answer's `data` (name, manufacturer, year, url). */
export function buildTeamCard(credits: Json, game: Json | null): TeamCard | null {
  const rows = Array.isArray(credits.data) ? (credits.data as Json[]) : [];
  if (rows.length === 0) return null;
  const byRole = new Map<string, { name: string; url: string | null }[]>();
  const everyone = new Set<string>();
  for (const c of rows) {
    const role = str(c.role_name);
    const person = (c.person ?? {}) as Json;
    const name = str(person.name);
    if (!role || !name) continue;
    everyone.add(name);
    const people = byRole.get(role) ?? [];
    if (!people.some((p) => p.name === name)) people.push({ name, url: str(person.url) });
    byRole.set(role, people);
  }
  const rank = (r: string) => (ROLE_ORDER.indexOf(r) === -1 ? ROLE_ORDER.length : ROLE_ORDER.indexOf(r));
  const roles = [...byRole.entries()]
    .map(([role, people], i) => ({ role, people, i }))
    .sort((a, b) => rank(a.role) - rank(b.role) || a.i - b.i)
    .map(({ role, people }) => ({ role, people }));
  return {
    kind: "team",
    game: {
      name: str(game?.name) ?? "",
      url: str(game?.url) ?? str(credits.game_url),
      manufacturer: str((game?.manufacturer as Json | undefined)?.name),
      year: num(game?.first_manufacture_year),
    },
    people: everyone.size,
    roles,
  };
}

// ---------------------------------------------------------------------------
// Manuals and other files (list_game_files)
// ---------------------------------------------------------------------------

export interface FilesCard {
  kind: "files";
  game: { name: string; url: string | null };
  /** The game page's Documentation section, where a signed-in reader downloads. */
  download_url: string | null;
  total: number;
  groups: { machine: string; files: { name: string; type: string | null; details: string | null }[] }[];
}

const FILE_TYPE_LABEL: Record<string, string> = {
  manual: "Manual",
  schematic: "Schematic",
  schematics: "Schematics",
  rom: "ROM",
  parts_list: "Parts list",
  bulletin: "Bulletin",
  flyer: "Flyer",
};

// The files API gives ISO 639-1 codes; English is the default and goes unsaid.
const LANGUAGE: Record<string, string | null> = {
  en: null,
  es: "Spanish",
  pt: "Portuguese",
  de: "German",
  fr: "French",
  it: "Italian",
  nl: "Dutch",
  ja: "Japanese",
};

function language(code: string | null): string | null {
  if (!code) return null;
  const key = code.toLowerCase();
  return key in LANGUAGE ? LANGUAGE[key] : code;
}

function fileSize(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) return null;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/** `game` is the game answer's `data` (name, url); `slug` the game's slug when known. */
export function buildFilesCard(body: Json, game: Json | null, pageUrl: string | null): FilesCard | null {
  const files = Array.isArray(body.data) ? (body.data as Json[]) : [];
  if (files.length === 0) return null;
  const groups = new Map<string, FilesCard["groups"][number]["files"]>();
  // The game's own machines first, then files filed under a sister game.
  const own = new Set<string>();
  for (const f of files) {
    const type = str(f.file_type);
    const details = [str(f.format)?.toUpperCase() ?? null, language(str(f.language)), fileSize(num(f.size_bytes)), str(f.description)]
      .filter(Boolean)
      .join(" · ");
    const row = { name: str(f.name) ?? "", type: type ? (FILE_TYPE_LABEL[type] ?? type.replace(/_/g, " ")) : null, details: details || null };
    const machines = Array.isArray(f.machines) ? (f.machines as Json[]) : [];
    const labels = machines.length
      ? machines.map((m) => {
          const maker = m.relationship === "also_made_as" ? str((m.manufacturer as Json | undefined)?.name) : null;
          const label = `${str(m.name) ?? ""}${maker ? ` (${maker})` : ""}`;
          if (m.relationship !== "also_made_as") own.add(label);
          return label;
        })
      : ["Other files"];
    for (const label of labels) {
      const list = groups.get(label) ?? [];
      list.push(row);
      groups.set(label, list);
    }
  }
  const pagination = (body.pagination ?? {}) as Json;
  return {
    kind: "files",
    game: { name: str(game?.name) ?? "", url: pageUrl },
    download_url: pageUrl ? `${pageUrl}#documentation` : null,
    total: num(pagination.total) ?? files.length,
    groups: [...groups.entries()]
      .map(([machine, list], i) => ({ machine, files: list, rank: own.has(machine) ? 0 : machine === "Other files" ? 2 : 1, i }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map(({ machine, files: list }) => ({ machine, files: list })),
  };
}

// ---------------------------------------------------------------------------
// A place (get on a /locations page)
// ---------------------------------------------------------------------------

export interface VenueCard {
  kind: "venue";
  name: string;
  url: string | null;
  address: string | null;
  machines_count: number;
  machines: { name: string; url: string | null; year: number | null; image: string | null }[];
}

export function buildVenueCard(data: Json): VenueCard | null {
  const name = str(data.name);
  if (!name) return null;
  const machines = Array.isArray(data.machines) ? (data.machines as Json[]) : [];
  return {
    kind: "venue",
    name,
    url: str(data.url),
    address: [str(data.street), str(data.city), str(data.state)].filter(Boolean).join(", ") || null,
    machines_count: num(data.machines_count) ?? machines.length,
    machines: machines.map((m) => ({ name: str(m.name) ?? "", url: str(m.url), year: num(m.year), image: str(m.image) })),
  };
}

// ---------------------------------------------------------------------------
// A Hype Index theme (get on a /hype page)
// ---------------------------------------------------------------------------

export interface HypeCard {
  kind: "hype";
  name: string;
  url: string | null;
  image: string | null;
  /** Null for a graduated theme, which has no rank on its page either. */
  rank: number | null;
  change: number | null;
  history: { date: string; rank: number }[];
}

export function buildHypeCard(data: Json): HypeCard | null {
  const name = str(data.name);
  if (!name) return null;
  const history = Array.isArray(data.history) ? (data.history as Json[]) : [];
  return {
    kind: "hype",
    name,
    url: str(data.url),
    image: str(data.image),
    rank: num(data.rank),
    change: num(data.change),
    history: history
      .map((p) => ({ date: str(p.date) ?? "", rank: num(p.rank) ?? 0 }))
      .filter((p) => p.date && p.rank > 0),
  };
}
