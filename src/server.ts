import { McpServer, type ToolAnnotations, type ToolCallback } from "@modelcontextprotocol/server";
import { z, type ZodRawShape } from "zod";

import {
  CARD_MIME,
  CARD_URI,
  buildFilesCard,
  buildGameCard,
  buildGamesCard,
  buildHypeCard,
  buildNewsCard,
  buildPlacesCard,
  buildSearchCard,
  buildTeamCard,
  buildVenueCard,
  withoutImages,
} from "./cards.js";

export interface CreateMCPServerOptions {
  /**
   * The caller's API key. null = anonymous (the HTTP transport's no-key path):
   * only the read-only catalog tools are registered and no Authorization
   * header is sent. Tools that change account data need a key.
   */
  apiKey: string | null;
  apiBaseUrl?: string;
  /**
   * Optional fetch replacement. The HTTP transport injects an in-process
   * dispatcher here so tool calls skip the network; the stdio bin omits it
   * and uses global fetch. Same (url, init) contract as fetch.
   */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /**
   * Optional best-image lookup (raw game UUID in). The HTTP transport injects
   * one backed by the private image inventory; get_game_details and
   * get_random_game then add `best_image` to the game. The stdio bin omits it
   * and its answers carry no best_image.
   */
  bestGameImage?: (gameId: string) => Promise<BestGameImage | null>;
  /**
   * Optional cards (MCP Apps). The HTTP transport passes the card page's
   * HTML; the server then serves it as a ui:// resource, the read tools that
   * have a card point at it, and their results carry the card's data in
   * `structuredContent.card` (src/cards.ts). The written answer is unchanged.
   * The stdio bin omits it.
   */
  cards?: { html: string; csp?: { resourceDomains?: string[]; connectDomains?: string[] } };
}

export interface BestGameImage {
  url: string;
  kind: string;
  width: number | null;
  height: number | null;
}

const DEFAULT_API_BASE_URL = "https://www.kineticist.com";

/** The API answered 404: the game, person or file asked for doesn't exist. */
class NotFoundError extends Error {
  /** The endpoint's `error` object, when it sent one (message without the hint, plus any extra fields). */
  readonly apiError: { message?: string; [key: string]: unknown } | null;
  constructor(message: string, apiError: NotFoundError["apiError"] = null) {
    super(message);
    this.apiError = apiError;
  }
}

// Public API returns game ids like "gm_<uuid>". /me/* endpoints expect the raw
// UUID. Strip the prefix so agents can paste the id they got from
// get_game_details without a second step.
function stripGamePrefix(id: string): string {
  return id.startsWith("gm_") ? id.slice(3) : id;
}

const GAME_ID_SCHEMA = z.string().min(1).describe(
  "Game UUID. Accepts both the raw UUID and the 'gm_'-prefixed form that get_game_details returns (prefix stripped automatically).",
);

interface GameFileItem {
  id: string;
  name: string;
  description?: string | null;
  file_type?: string | null;
  format?: string | null;
  size_bytes?: number | null;
  language?: string | null;
  machines?: {
    id: string;
    slug: string;
    name: string;
    manufacturer?: { name: string } | null;
    relationship: "edition" | "also_made_as";
  }[];
}

/** Tools registered for anonymous callers: catalog reads only, nothing under /me. */
export const ANONYMOUS_TOOL_NAMES = [
  "search_pinball_games",
  "get_game_details",
  "get_random_game",
  "get_pinball_stats",
  "get_game_credits",
  "list_game_files",
  // Read over /api/v1/{where-to-play,search,page,whats-new}, like the tools above.
  "where_to_play",
  "search",
  "get",
  "whats_new",
] as const;

/** Canonical site origin for reader-facing page links. Always production,
 *  whatever apiBaseUrl the factory was given: answers should send readers to
 *  the public site, not to a staging or localhost API host. */
const SITE_URL = "https://www.kineticist.com";

export function gamePageUrl(slug: string): string {
  return `${SITE_URL}/games/pinball/${slug}`;
}

export function locationPageUrl(slug: string): string {
  return `${SITE_URL}/locations/${slug}`;
}

export function personPageUrl(slug: string): string {
  return `${SITE_URL}/people/${slug}`;
}

/** True when `id` is a game slug rather than a UUID, gm_ id or OPDB id, so
 *  it can be dropped into a page URL as is. */
function looksLikeSlug(id: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)
    && !/^[0-9a-f]{8}-?[0-9a-f]{4}/.test(id);
}

/** What a reader sees about downloading, shared by list_game_files. Site
 *  downloads are sign-in gated (src/lib/actions/file-download.ts). */
export function filesDownloadNote(slug: string | null): string {
  // The URL ends the line with nothing after it: chat clients that autolink
  // would otherwise fold a trailing period into the anchor.
  const note = "Downloading a file needs a free Kineticist account: sign in on the site, then use the game page's Documentation section.";
  return slug ? `${note}\n${gamePageUrl(slug)}#documentation` : `${note} The game page is on www.kineticist.com.`;
}

type ToolMeta = { title: string } & Omit<ToolAnnotations, "title">;

const READ: Omit<ToolAnnotations, "title"> = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE: Omit<ToolAnnotations, "title"> = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/**
 * Display title + MCP tool annotations for every tool. Clients use these to
 * group tools (Claude files read-only tools apart from ones that change
 * data) and to decide when to ask before a call. destructiveHint is true only
 * where a call removes the user's data; toggles and upserts are reversible.
 */
export const TOOL_META: Record<string, ToolMeta> = {
  search_pinball_games: { title: "Search pinball games", ...READ },
  get_game_details: { title: "Get game details", ...READ },
  where_to_play: { title: "Find where to play", ...READ },
  search: { title: "Search Kineticist", ...READ },
  get: { title: "Read a Kineticist page", ...READ },
  whats_new: { title: "What's new in pinball", ...READ },
  get_random_game: { title: "Get a random game", ...READ, idempotentHint: false },
  get_pinball_stats: { title: "Get database stats", ...READ },
  get_game_credits: { title: "Get a game's design team", ...READ },
  list_game_files: { title: "List a game's files", ...READ },
  kineticist_log_play: { title: "Log a play", ...WRITE },
  kineticist_toggle_ownership: { title: "Mark a game owned or not owned", ...WRITE },
  kineticist_toggle_want: { title: "Toggle want to play or own", ...WRITE },
  kineticist_set_fun_score: { title: "Set your fun score", ...WRITE, idempotentHint: true },
  kineticist_undo_last_play: { title: "Undo your last play", ...WRITE, destructiveHint: true },
  kineticist_toggle_favorite: { title: "Favorite a game or follow a creator", ...WRITE },
  kineticist_delete_fun_score: { title: "Delete your fun score", ...WRITE, destructiveHint: true, idempotentHint: true },
  kineticist_update_play_log: { title: "Edit a play", ...WRITE, idempotentHint: true },
  kineticist_delete_play_log: { title: "Delete a play", ...WRITE, destructiveHint: true, idempotentHint: true },
  kineticist_update_ownership_details: { title: "Edit ownership details", ...WRITE, idempotentHint: true },
  kineticist_submit_review: { title: "Save your review", ...WRITE, idempotentHint: true },
  kineticist_delete_review: { title: "Delete your review", ...WRITE, destructiveHint: true, idempotentHint: true },
  kineticist_get_my_state: { title: "Get your status for a game", ...READ },
};

type Json = Record<string, unknown>;

/** is_lead marks the first chair only where several people share a role (a
 *  handful of games), so `false` reads as "not the lead" when it means "no
 *  ranking". Answers keep it only when true. */
export function dropFalseLead(credits: unknown): void {
  if (!Array.isArray(credits)) return;
  for (const c of credits as Json[]) if (c && c.is_lead === false) delete c.is_lead;
}

/** The API's last_manufacture_year is the newest edition's year, not the
 *  year production stopped, so next to in_production: true it read as a
 *  contradiction (Godzilla in production, "last made 2024"). Answers carry it
 *  as newest_edition_year. Mutates `game`. */
export function renameEndYear(game: unknown): void {
  const g = game as Json | null;
  if (!g || !("last_manufacture_year" in g)) return;
  g.newest_edition_year = g.last_manufacture_year;
  delete g.last_manufacture_year;
}

export const YEAR_FIELDS_NOTE =
  "`newest_edition_year` is the year the newest edition came out, not the year production ended; `in_production` says whether the game is still made.";

export const COMBINED_TITLES_NOTE =
  "This game's name joins several titles built on one playfield and sold under different themes; each title is listed among its editions. Kineticist groups them this way on purpose, so describe them as one design with several themes, not as a mistake.";

export const REMAKE_EDITIONS_NOTE =
  "Some editions filed on this game belong to its remakes and are listed under each remake's `editions`, not here. This game's in_production and newest_edition_year include those remake editions.";

/**
 * Game detail data as answers show it. Editions the API marks with a
 * remake_game_id (a remake's editions filed on the original, which the game
 * page hides) move onto that remake, so the original lists only its own
 * machines. Mutates and returns `data`.
 */
export function shapeGameData(data: Json): Json {
  // The API supplies url and newest_edition_year; last_manufacture_year stays
  // there for app makers, but beside in_production it reads as "production
  // stopped", so answers leave it out.
  delete data.last_manufacture_year;
  const remakes = Array.isArray(data.remakes) ? (data.remakes as Json[]) : [];

  if (Array.isArray(data.editions)) {
    const own: Json[] = [];
    const moved: Json[] = [];
    for (const e of data.editions as Json[]) {
      const remakeId = e?.remake_game_id;
      if (typeof remakeId !== "string") {
        own.push(e);
        continue;
      }
      const home = remakes.find((rm) => rm.id === remakeId);
      if (home) {
        const list = Array.isArray(home.editions) ? (home.editions as Json[]) : [];
        list.push(e);
        home.editions = list;
      } else {
        moved.push(e);
      }
    }
    if (own.length !== data.editions.length) {
      data.editions = own;
      data.editions_count = own.length;
      if (moved.length > 0) data.remake_editions = moved;
      data.remake_editions_note = REMAKE_EDITIONS_NOTE;
    }
  }

  // "Family Guy / Shrek": Claude read the joined name as a merge error (2026-10-18).
  if (typeof data.name === "string" && data.name.includes(" / ")) data.combined_titles_note = COMBINED_TITLES_NOTE;

  dropEmptyFields(data.editions);
  dropEmptyFields(data.remake_editions);
  for (const rm of remakes) dropEmptyFields(rm.editions);

  dropFalseLead(data.credits);
  return data;
}

/**
 * Leaves out edition fields with no value. Shown as null beside a sibling
 * that has one (the 70th Anniversary Godzilla's MPU), Claude called it a data
 * gap in its answer (2026-10-18). Mutates each edition in place.
 */
function dropEmptyFields(list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const e of list as Json[]) {
    if (!e || typeof e !== "object") continue;
    for (const key of Object.keys(e)) {
      if (e[key] === null || e[key] === undefined) delete e[key];
    }
  }
}

/**
 * What the client hands the model at connect time: when to reach for these
 * tools. Without it ChatGPT answered pinball questions from web search and
 * used the connector only when told to (2026-10-16).
 */
export function serverInstructions(keyed: boolean): string {
  const lines = [
    "Kineticist (kineticist.com) is a pinball publication and database. These tools cover pinball machines and their editions, list prices (MSRP) and production status; design credits; places to play near a postal code or city, and which venues have a given machine; manufacturers, designers and other people; recent pinball news and creator videos; and Kineticist's Hype Index of pinball themes.",
    "Which tool: where_to_play for places to play; whats_new for recent pinball news, new videos and podcasts from pinball creators, and Hype Index moves; search_pinball_games and get_game_details for machines, their editions, prices and production status; get_game_credits for who designed a game; list_game_files for manuals and schematics; search for anything else on the site, then get to read a result's page.",
    "Answers include kineticist.com page links (url); cite them when using Kineticist's data. News results are summaries, and the full story is at the article link.",
    "A creator video or news tag can name a homebrew, another manufacturer's game or an unreleased one, so a game named there may not have its own entry in the database.",
    "A game named with slashes, like \"Family Guy / Shrek\", is one playfield sold under several themes, grouped on purpose.",
  ];
  if (keyed) lines.push("Tools starting with kineticist_ act on the API key owner's own Kineticist library (plays, ownership, wishlist, fun scores, reviews).");
  return lines.join("\n\n");
}

const NOTE_WRITE_TIER ="Acts on the API key owner's own library. Available on every tier, but agents that make many calls per task burn through a free-tier daily quota quickly. Email colin@kineticist.com for a higher ceiling.";

/**
 * Build a Kineticist MCP server bound to a specific API key. Stateless: each
 * call returns a fresh McpServer with its own API client closure. No
 * module-level mutable state, no process.env reads at construction.
 *
 * The stdio bin (src/index.ts) and the HTTP transport route handler
 * (src/app/api/mcp/route.ts) both call this factory.
 */
export function createKineticistMCPServer(
  options: CreateMCPServerOptions,
): McpServer {
  const { apiKey, apiBaseUrl = DEFAULT_API_BASE_URL, fetchImpl, bestGameImage, cards } = options;

  /**
   * Shape a game resource ({ id: "gm_…", data }) for an assistant: page links,
   * remake editions moved onto their remake, no false is_lead flags, and
   * `best_image` when a lookup was injected.
   */
  async function shapeGameAnswer(resource: unknown): Promise<unknown> {
    const r = resource as { id?: unknown; data?: Record<string, unknown> } | null;
    if (!r?.data) return resource;
    shapeGameData(r.data);
    if (bestGameImage && typeof r.id === "string") {
      r.data.best_image = await bestGameImage(stripGamePrefix(r.id));
    }
    return resource;
  }

  async function api(path: string, init?: RequestInit): Promise<unknown> {
    const url = `${apiBaseUrl}${path}`;
    const headers = {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    };
    const res = await (fetchImpl ?? fetch)(url, { ...init, headers });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string; hint?: string; [key: string]: unknown };
      } | null;
      const msg = body?.error?.message ?? `API error ${res.status}`;
      const hint = body?.error?.hint ?? "";
      const text = `${msg}${hint ? ` (${hint})` : ""}`;
      throw res.status === 404 ? new NotFoundError(text, body?.error ?? null) : new Error(text);
    }

    return res.json();
  }

  async function postAction(body: Record<string, unknown>): Promise<unknown> {
    const res = (await api("/api/v1/me/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })) as { success?: boolean; error?: string };
    if (res && res.success === false) {
      throw new Error(res.error ?? "Action failed");
    }
    return res;
  }

  const server = new McpServer(
    {
      name: "kineticist",
      title: "Kineticist",
      version: "1.5.0",
      description: "Pinball machines, places to play, designers, news and the Hype Index from Kineticist.",
      websiteUrl: SITE_URL,
    },
    { instructions: serverInstructions(apiKey !== null) },
  );

  // Every tool goes through here so none ships without a title and
  // annotations (TOOL_META throws on a name it doesn't know).
  function tool<Shape extends ZodRawShape>(
    name: string,
    description: string,
    inputSchema: Shape,
    cb: ToolCallback<z.ZodObject<Shape>>,
    _meta?: Record<string, unknown>,
  ) {
    const meta = TOOL_META[name];
    if (!meta) throw new Error(`No TOOL_META entry for MCP tool "${name}"`);
    const { title, ...hints } = meta;
    // A slug or id that doesn't exist is an ordinary answer, not a failure:
    // hand it back as a tool error so it isn't reported as an exception.
    const handler = (async (args, ctx) => {
      try {
        return await cb(args, ctx);
      } catch (err) {
        if (err instanceof NotFoundError) {
          return { isError: true, content: [{ type: "text" as const, text: err.message }] };
        }
        throw err;
      }
    }) as ToolCallback<z.ZodObject<Shape>>;
    return server.registerTool(
      name,
      { title, description, inputSchema: z.object(inputSchema), annotations: { title, ...hints }, ...(_meta ? { _meta } : {}) },
      handler,
    );
  }

  // --- cards (MCP Apps), hosted server only ---
  const cardMeta = cards ? { ui: { resourceUri: CARD_URI }, "openai/outputTemplate": CARD_URI } : undefined;
  if (cards) {
    server.registerResource(
      "kineticist-card",
      CARD_URI,
      {
        title: "Kineticist card",
        description: "Pinball machines, places to play, the week's news and design teams, drawn from Kineticist's answers.",
        mimeType: CARD_MIME,
      },
      async () => ({
        contents: [
          {
            uri: CARD_URI,
            mimeType: CARD_MIME,
            text: cards.html,
            _meta: { ui: { csp: cards.csp ?? {}, prefersBorder: false } },
          },
        ],
      }),
    );
  }

  /** An answer as text, plus a card's data when cards are on and there's one to draw. */
  function withCard(answer: unknown, card: () => unknown) {
    const text = { content: [{ type: "text" as const, text: JSON.stringify(answer, null, 2) }] };
    if (!cards) return text;
    const data = card();
    return data ? { ...text, structuredContent: { card: data } } : text;
  }

  /** A game answer as text, plus the game card. */
  function gameResult(answer: unknown, card: unknown) {
    const data = (card as { data?: Record<string, unknown> } | null)?.data;
    return withCard(answer, () => (data ? buildGameCard(data) : null));
  }

  // --- search_pinball_games ---
  tool(
    "search_pinball_games",
    "Find pinball machines: \"what Stern machines are in production right now?\", \"what pinball games has Stern made?\", \"pinball games from 1992\". `in_production` filters to machines Kineticist lists as currently made. Searches and filters the Kineticist pinball game database. Supports text search, manufacturer filtering, year ranges, production status, and sorting. Returns game names, slugs, manufacturers, fun scores, edition counts, and each game's page URL on kineticist.com (link it when citing a game). " + YEAR_FIELDS_NOTE,
    {
      q: z.string().optional().describe("Text search by game name (fuzzy, 2+ chars). Natural language works — 'that stern game with dinosaurs' will find Godzilla."),
      manufacturer: z.string().optional().describe("Filter by manufacturer name or slug (fuzzy match — 'stern' works)"),
      in_production: z.boolean().optional().describe("Filter to only games currently in production (true) or out of production (false)"),
      year_from: z.number().optional().describe("Minimum manufacture year"),
      year_to: z.number().optional().describe("Maximum manufacture year"),
      sort: z.string().optional().describe("Sort field. Prefix with - for descending. Options: name, first_manufacture_year, average_fun_score, ratings_count"),
      limit: z.number().optional().describe("Results per page (1-100, default 25)"),
    },
    async (args) => {
      const params = new URLSearchParams();
      if (args.q) params.set("q", args.q);
      if (args.manufacturer) params.set("manufacturer", args.manufacturer);
      if (args.in_production !== undefined) params.set("in_production", String(args.in_production));
      if (args.year_from) params.set("year_from", String(args.year_from));
      if (args.year_to) params.set("year_to", String(args.year_to));
      if (args.sort) params.set("sort", args.sort);
      if (args.limit) params.set("limit", String(args.limit));

      const qs = params.toString();
      const data = (await api(`/api/v1/games${qs ? `?${qs}` : ""}`)) as {
        data?: { slug?: string }[];
      };
      for (const g of Array.isArray(data.data) ? data.data : []) {
        if (g.slug) Object.assign(g, { url: gamePageUrl(g.slug) });
        renameEndYear(g);
      }
      return withCard(data, () => buildGamesCard(data as Json, args));
    },
    cardMeta,
  );

  // --- get_game_details ---
  tool(
    "get_game_details",
    "Price, production status and details of a pinball machine: \"how much is the Godzilla Premium, and is it still made?\", \"how much is the Jurassic Park Premium?\", \"what is Godzilla pinball?\". Includes each edition's list price (MSRP) and whether the machine is in production. Full details for one game including editions (Pro/Premium/LE with pricing), images, tags, description, and rules links. `url` is the game's page on kineticist.com (link it when citing); remakes carry their own `url`. Editions that belong to a remake are listed under that remake. `best_image` (when present) is the one picture to show for the game: its URL, what it shows (backglass, photo, cabinet, flyer or playfield) and its size. Accepts slug (godzilla-2021), OPDB group ID (weeP), or OPDB machine ID (GweeP-MW95j). Use ?include=credits to also get the design team. " + YEAR_FIELDS_NOTE,
    {
      id: z.string().describe("Game slug, OPDB ID, or Kineticist game ID"),
      include_credits: z.boolean().optional().describe("Include design team credits (designer, artist, programmer, etc.)"),
    },
    async (args) => {
      // The card always shows the lead credits, so fetch them when it's on;
      // the written answer carries them only when they were asked for.
      const include = args.include_credits || cards ? "?include=credits" : "";
      const data = (await shapeGameAnswer(await api(`/api/v1/games/${encodeURIComponent(args.id)}${include}`))) as {
        data?: Record<string, unknown>;
      } | null;
      if (!args.include_credits && data?.data && "credits" in data.data) {
        const { credits: _credits, ...rest } = data.data;
        return gameResult({ ...data, data: rest }, data);
      }
      return gameResult(data, data);
    },
    cardMeta,
  );

  // --- get_random_game ---
  tool(
    "get_random_game",
    "Suggest a pinball machine: \"surprise me\", \"pinball game of the day\". A random pinball game with full details, including `best_image` (the one picture to show) when there is one. Different game every time.",
    {},
    async () => {
      const data = await shapeGameAnswer(await api("/api/v1/games/random"));
      return gameResult(data, data);
    },
    cardMeta,
  );

  // --- get_pinball_stats ---
  tool(
    "get_pinball_stats",
    "How big is the pinball world: \"how many pinball machines are in production?\", \"how many pinball manufacturers are there?\". Kineticist database statistics: total games, games in production, total manufacturers, total designers, average fun score, most rated game, and newest game.",
    {},
    async () => {
      const data = await api("/api/v1/stats");
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- get_game_credits ---
  tool(
    "get_game_credits",
    "Who designed a pinball machine: \"who designed Medieval Madness?\", \"who designed Attack from Mars?\", \"who did the art for Twilight Zone?\". Returns the full credited team, not just the lead designer. The design team for a pinball game — designer, artist, programmer, mechanical engineer, sound designer, animator, etc. Each credit includes the person's name and role. Every row carries `role` (slug, e.g. \"design\"), `role_name` (display name, e.g. \"Design\"), and, only where several people share a role on the game, `is_lead: true` on the first chair (no is_lead means no ranking, not \"not the lead\"). Read `role_name` for human display; `role` is the stable slug for filtering. Each person carries `url`, their page on kineticist.com, and `game_url` is the game's page (link them when citing).",
    {
      id: z.string().describe("Game slug or ID"),
    },
    async (args) => {
      const data = (await api(`/api/v1/games/${encodeURIComponent(args.id)}/credits`)) as {
        data?: { person?: { slug?: string } }[];
        links?: { game?: string };
        game_url?: string;
      };
      for (const c of Array.isArray(data.data) ? data.data : []) {
        if (c.person?.slug) Object.assign(c.person, { url: personPageUrl(c.person.slug) });
      }
      dropFalseLead(data.data);
      const gameSlug = data.links?.game?.split("/").pop();
      if (gameSlug) data.game_url = gamePageUrl(gameSlug);
      // The team card names the game, its manufacturer and year, which the
      // credits answer doesn't carry; a failed lookup just leaves them off.
      let game: Json | null = null;
      if (cards && gameSlug) {
        const g = (await api(`/api/v1/games/${encodeURIComponent(gameSlug)}`).catch(() => null)) as { data?: Json } | null;
        game = g?.data ? { ...g.data, url: gamePageUrl(gameSlug) } : null;
      }
      return withCard(data, () => buildTeamCard(data as Json, game));
    },
    cardMeta,
  );

  // --- list_game_files ---
  tool(
    "list_game_files",
    "Find a pinball manual or schematic: \"where's the Firepower manual?\", \"schematics for Fish Tales\". Lists a pinball game's downloadable files (manuals, ROMs, schematics, parts lists, bulletins) grouped by the machine each file is for. Each file line ends with a one-line description of what sets it apart (edition, print, language, format) when the title alone doesn't say. Use it to answer 'which file is for which machine' — e.g. Firepower's page also carries Taito's Fire Action files, and this tool tells them apart. Pass `machine` (trm_ id, slug, UUID or OPDB machine id) to narrow to one machine. Lists metadata only and ends with the game page's Documentation link; downloading a file needs a free Kineticist account on that page.",
    {
      id: z.string().describe("Game slug or ID"),
      machine: z.string().min(1).optional().describe("Optional machine filter: trm_ id, slug, UUID or OPDB machine id"),
    },
    async (args) => {
      const qs = `limit=100${args.machine ? `&machine=${encodeURIComponent(args.machine)}` : ""}`;
      const slug = encodeURIComponent(args.id);
      let body: {
        data?: GameFileItem[];
        pagination?: { total?: number; has_more?: boolean };
      };
      try {
        body = (await api(`/api/v1/games/${slug}/files?${qs}`)) as typeof body;
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
        };
      }
      const files = body.data ?? [];
      const groups = new Map<string, string[]>();
      const add = (label: string, line: string) => {
        const lines = groups.get(label) ?? [];
        lines.push(line);
        groups.set(label, lines);
      };
      for (const f of files) {
        const parts = [f.file_type, f.format, f.language, typeof f.size_bytes === "number" ? `${f.size_bytes} bytes` : null]
          .filter(Boolean)
          .join(", ");
        const line = `- ${f.name} [${f.id}] (${parts})${f.description ? `: ${f.description}` : ""}`;
        if (!f.machines || f.machines.length === 0) {
          add("Unattributed", line);
          continue;
        }
        for (const m of f.machines) {
          const maker = m.relationship === "also_made_as" && m.manufacturer?.name ? ` (${m.manufacturer.name})` : "";
          add(`${m.name}${maker} [${m.slug}]`, line);
        }
      }
      const out: string[] = [];
      if (files.length === 0) out.push("No files found.");
      for (const [label, lines] of groups) out.push(`${label}\n${lines.join("\n")}`);
      if (body.pagination?.has_more) {
        out.push(`Showing ${files.length} of ${body.pagination.total ?? "more"} files.`);
      }
      out.push(filesDownloadNote(looksLikeSlug(args.id) ? args.id : null));
      // Keyed callers (stdio bin, API-key connectors) can still fetch a
      // signed URL themselves; an anonymous caller has no key to do it with.
      if (apiKey) {
        out.push(`With your API key: GET /api/v1/games/${slug}/files/{fileId} returns a signed download URL (rate-limited).`);
      }
      const text = { content: [{ type: "text" as const, text: out.join("\n\n") }] };
      if (!cards || files.length === 0) return text;
      // The card names the game; a failed lookup just leaves the name off.
      const g = (await api(`/api/v1/games/${slug}`).catch(() => null)) as { data?: Json } | null;
      const gameSlug = typeof g?.data?.slug === "string" ? g.data.slug : looksLikeSlug(args.id) ? args.id : null;
      const card = buildFilesCard(body as Json, g?.data ?? null, gameSlug ? gamePageUrl(gameSlug) : null);
      return card ? { ...text, structuredContent: { card } } : text;
    },
    cardMeta,
  );

  // --- where_to_play, search, get, whats_new: read over /api/v1/{where-to-play,search,page,whats-new} ---
  const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

  /** A query string from the arguments that were given. */
  function query(params: Record<string, string | number | undefined>): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    return qs.toString();
  }

  /** The `data` of an endpoint's `{ object, data }` answer. */
  const dataOf = (answer: unknown): Json => (answer as { data: Json }).data;

  tool(
    "where_to_play",
    "Where to play pinball, or a specific machine: \"where can I play Godzilla near 97214?\", \"where can I play pinball in Chicago?\", \"pinball bars in Portland\". Finds pinball venues near a place: a postal code (\"60601\", \"SW1A 1AA\" with country gb) or a city (\"Chicago\", \"Portland, OR\"). Pass `game` (name or slug) to find venues that have that machine. Returns up to 10 venues, nearest first, with city, distance in miles, machine count, venue kind (bar, arcade…) and `url`, the venue's page on kineticist.com (link it; it has the address and full machine list). `searched` says which place distances are measured from (\"central Chicago, IL\" is the city centre; \"(middle of our venues there)\" means a smaller city placed by its venues); `note` says when these are the nearest anywhere rather than nearby. Machine lists come from Pinball Map and can lag.",
    {
      place: z.string().min(1).max(80).describe("Postal code or city, e.g. \"60601\", \"Chicago\", \"Portland, OR\""),
      country: z.string().length(2).optional().describe("Two-letter country code for postal codes outside the US (gb, ca, de…). Default us."),
      game: z.string().min(1).max(80).optional().describe("Only venues that have this game: a name (\"Godzilla\") or slug (godzilla-2021)"),
    },
    async (args) => {
      // Each venue already carries its `url`. A place or game that can't be
      // found is a 404 carrying the place searched; it stays a normal answer
      // ({ searched, venues: [], error }), as it was before the endpoint.
      let data: Json;
      try {
        data = dataOf(await api(`/api/v1/where-to-play?${query({ place: args.place, country: args.country, game: args.game })}`));
      } catch (err) {
        if (!(err instanceof NotFoundError) || !err.apiError) throw err;
        data = { searched: err.apiError.searched ?? "", venues: [], error: err.apiError.message };
      }
      return withCard(data, () => buildPlacesCard(data));
    },
    cardMeta,
  );

  tool(
    "search",
    "Look up anything pinball on Kineticist: \"who is Steve Ritchie?\", \"tell me about Spooky Pinball\", \"Kineticist articles about Pinburgh\". Searches everything on Kineticist: games, news articles, places to play, manufacturers, people, mods, Hype Index entries and creators. Returns up to 10 matches, best first, each with its type, title, a short subtitle and `url` (its page on kineticist.com). Pass `type` to look in one kind only. For game details use get_game_details; for any other result, pass its url to `get`.",
    {
      query: z.string().min(2).max(120).describe("What to look for, e.g. \"Steve Ritchie\", \"Stern\", \"Pinburgh\""),
      type: z.enum(["game", "article", "location", "manufacturer", "person", "mod", "hype", "promoter"]).optional().describe("Only this kind of result"),
    },
    async (args) => {
      // A query that trims below 2 characters was always an empty answer, not
      // an error; the endpoint would 400 it.
      const q = args.query.trim();
      if (q.length < 2) {
        const empty = { query: q, results: [] };
        return withCard(empty, () => buildSearchCard(empty));
      }
      // The REST answer's `id` and `slug` stay out of the written answer.
      const raw = dataOf(await api(`/api/v1/search?${query({ q: args.query, type: args.type })}`));
      const data = Array.isArray(raw.results)
        ? { ...raw, results: (raw.results as Json[]).map(({ id: _id, slug: _slug, ...hit }) => hit) }
        : raw;
      return withCard(data, () => buildSearchCard(data));
    },
    cardMeta,
  );

  tool(
    "get",
    "Read what Kineticist says about something: \"what does Kineticist say about Logan Arcade?\", or any www.kineticist.com link. Reads a Kineticist page by its link, as markdown: a game, Hype Index entry, place to play, manufacturer, person, mod or creator. News articles come back as headline, date, summary and link only; the full article is at the link. Use the `url` from search or another tool.",
    {
      url: z.string().min(1).max(300).describe("A www.kineticist.com page link, e.g. https://www.kineticist.com/people/steve-ritchie"),
    },
    async (args) => {
      let data: { markdown?: string; error?: string; url?: string; card?: Json; members_section?: boolean };
      try {
        data = dataOf(await api(`/api/v1/page?${query({ url: args.url })}`)) as typeof data;
      } catch (err) {
        // Not a Kineticist link, no such article, nothing at the link, a page
        // kind not served: a 404 carrying the link read. Still a normal answer.
        if (!(err instanceof NotFoundError) || !err.apiError) throw err;
        data = { url: typeof err.apiError.url === "string" ? err.apiError.url : args.url, error: err.apiError.message };
      }
      if (data.markdown) {
        // News answers already end with the article link; don't repeat it.
        const text = data.url && !data.markdown.includes(data.url) ? `${data.markdown}\n\nPage: ${data.url}` : data.markdown;
        const answer = { content: [{ type: "text" as const, text }] };
        // Places and Hype Index themes get a card; the card data never
        // reaches the written answer.
        const card = cards && data.card ? (data.card.kind === "venue" ? buildVenueCard(data.card) : data.card.kind === "hype" ? buildHypeCard(data.card) : null) : null;
        return card ? { ...answer, structuredContent: { card } } : answer;
      }
      const { card: _card, members_section: _members, ...rest } = data;
      return json(rest);
    },
    cardMeta,
  );

  tool(
    "whats_new",
    "What's new in pinball: \"what's new in pinball this week?\", \"latest pinball news\", \"what's climbing the Hype Index?\". The latest Kineticist news articles (headline, date, summary and link; `members_section` means part of the article is for members; `games` lists the machines an article covers, get_game_details with a game's slug returns its editions, prices and design team; a release announced in the last few days may not have its new editions in the database yet, so check the edition dates against the article before quoting prices), new videos, podcasts and posts from the pinball creators Kineticist follows (`from_creators`: title, creator, format, date, summary, link), and Kineticist's Hype Index ranking (the current top 10 and this week's biggest climbers; `change_this_week` and `up` are places moved on the index since a week ago, positive is up, and a missing change means there's no rank from a week ago). This covers the week in pinball; each article and creator item carries its link.",
    {
      days: z.number().int().min(1).max(30).optional().describe("How far back to look for news, in days (default 7)"),
      creators: z.number().int().min(1).max(40).optional().describe("How many creator items to list (default 8). Ask for more, up to 40, for a full roundup of the window"),
    },
    async (args) => {
      // Pictures (news and creator thumbnails) are for the card; the
      // written answer leaves them out.
      const data = dataOf(await api(`/api/v1/whats-new?${query({ days: args.days, creators: args.creators })}`));
      return withCard(withoutImages(data), () => buildNewsCard(data));
    },
    cardMeta,
  );

  // Anonymous callers get the catalog reads above and nothing else.
  if (apiKey === null) return server;

  // -------------------------------------------------------------------------
  // Write tools — act on the API key owner's own library (plays, ownership,
  // wishlist, fun score). Available on every tier; heavy agent traffic burns
  // through a free-tier daily quota quickly.
  // -------------------------------------------------------------------------

  // --- kineticist_log_play ---
  tool(
    "kineticist_log_play",
    `Log a play of a pinball game for the authenticated user. Use get_game_details first if you only have a slug — this tool needs the id from that response. playedAt must be today or earlier; at most 20 plays per game per day are accepted. Set dateKnown=false when the user has played the game but doesn't remember when or where; the diary will render "at some point". ${NOTE_WRITE_TIER}`,
    {
      gameId: GAME_ID_SCHEMA,
      playedAt: z.string().describe("Play date, YYYY-MM-DD. Must be today or earlier. Still required when dateKnown is false — send today's date as a placeholder."),
      dateKnown: z.boolean().optional().describe("Defaults to true. Set to false when the play is a vague 'I played this at some point' claim with no real date."),
      locationId: z.string().uuid().optional().describe("Optional location UUID if known"),
      locationText: z.string().max(200).optional().describe("Freeform location name if locationId is unknown"),
      note: z.string().max(500).optional(),
      score: z.number().int().min(0).optional().describe("Score on the machine, not a fun rating"),
      isReplay: z.boolean().optional().describe("Flag as a replay rather than first-time play"),
    },
    async (args) => {
      const data = await postAction({ handler: "logPlay", ...args, gameId: stripGamePrefix(args.gameId) });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- kineticist_toggle_ownership ---
  tool(
    "kineticist_toggle_ownership",
    `Mark a game as owned ("own") or no longer owned ("disown") for the authenticated user. The website treats this as toggle-like — calling "own" twice will error on the second call because the first ownership record is still open. ${NOTE_WRITE_TIER}`,
    {
      gameId: GAME_ID_SCHEMA,
      action: z.enum(["own", "disown"]),
      removalReason: z.enum(["sold", "traded", "other"]).optional().describe("Only meaningful when action is 'disown'"),
      removedAt: z.string().optional().describe("ISO date, YYYY-MM-DD. Only meaningful when action is 'disown'. Must be today or earlier."),
    },
    async (args) => {
      const data = await postAction({ handler: "toggleOwnership", ...args, gameId: stripGamePrefix(args.gameId) });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- kineticist_toggle_want ---
  tool(
    "kineticist_toggle_want",
    `Toggle the authenticated user's want-to-play or want-to-own flag for a game. Calling twice turns the flag back off. Logging a play or marking the game owned will auto-clear the matching want flag server-side. ${NOTE_WRITE_TIER}`,
    {
      gameId: GAME_ID_SCHEMA,
      wantType: z.enum(["play", "own"]).describe("'play' toggles the want-to-play list; 'own' toggles the wishlist"),
    },
    async (args) => {
      const data = await postAction({ handler: "toggleWant", ...args, gameId: stripGamePrefix(args.gameId) });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- kineticist_set_fun_score ---
  tool(
    "kineticist_set_fun_score",
    `Set the authenticated user's fun score (1-100) for a game. Upserts — calling again overwrites. Also updates the score attached to any existing written review. ${NOTE_WRITE_TIER}`,
    {
      gameId: GAME_ID_SCHEMA,
      score: z.number().int().min(1).max(100),
    },
    async (args) => {
      const data = await postAction({ handler: "updateFunScore", ...args, gameId: stripGamePrefix(args.gameId) });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- kineticist_undo_last_play ---
  tool(
    "kineticist_undo_last_play",
    `Delete the authenticated user's most recent play log for a game. Walks played_at then created_at descending. Errors if there is no play to undo. ${NOTE_WRITE_TIER}`,
    {
      gameId: GAME_ID_SCHEMA,
    },
    async (args) => {
      const data = await postAction({ handler: "undoLastPlay", gameId: stripGamePrefix(args.gameId) });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- kineticist_toggle_favorite ---
  tool(
    "kineticist_toggle_favorite",
    `Toggle the authenticated user's favorite/follow. Provide gameId to favorite a game, or promoterId or promoterSlug to follow a creator (the same Following list the /promoters Following tab reads). promoterSlug is the last part of a creator's page url (https://www.kineticist.com/promoters/{slug}). Calling twice removes it. Returns { success, favorited }. ${NOTE_WRITE_TIER}`,
    {
      gameId: GAME_ID_SCHEMA.optional(),
      promoterId: z
        .string()
        .uuid()
        .optional()
        .describe("Kineticist promoter (creator) UUID to follow/unfollow. Provide one of gameId, promoterId or promoterSlug."),
      promoterSlug: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Creator slug, the last part of its page url. Used when you have the creator's page but not its UUID."),
    },
    async (args) => {
      if (!args.gameId && !args.promoterId && !args.promoterSlug) {
        throw new Error("Provide gameId (to favorite a game), or promoterId or promoterSlug (to follow a creator).");
      }
      let promoterId = args.promoterId;
      if (!promoterId && args.promoterSlug) {
        // Same lookup as the CLI's `pinball follow`: search creators, take the exact slug.
        const slug = args.promoterSlug.trim();
        const raw = dataOf(await api(`/api/v1/search?${query({ q: slug, type: "promoter" })}`));
        const hits = Array.isArray(raw.results) ? (raw.results as { id?: unknown; slug?: unknown }[]) : [];
        const hit = hits.find((r) => r.slug === slug && typeof r.id === "string");
        if (!hit) throw new NotFoundError(`No creator with the slug "${slug}".`);
        promoterId = hit.id as string;
      }
      const body = promoterId
        ? { handler: "toggleFavorite", entityType: "promoter", entityId: promoterId }
        : { handler: "toggleFavorite", gameId: stripGamePrefix(args.gameId as string) };
      const data = await postAction(body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- kineticist_delete_fun_score ---
  tool(
    "kineticist_delete_fun_score",
    `Delete the authenticated user's fun score for a game. Errors if no score exists. The fun score recorded inside a written review is NOT removed by this — call kineticist_delete_review for that. ${NOTE_WRITE_TIER}`,
    {
      gameId: GAME_ID_SCHEMA,
    },
    async (args) => {
      const data = await postAction({ handler: "deleteFunScore", gameId: stripGamePrefix(args.gameId) });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- kineticist_update_play_log ---
  tool(
    "kineticist_update_play_log",
    `Update an existing play log row owned by the authenticated user. Use the play log id from a prior list — these are NOT game ids. playedAt must be today or earlier. Pass any subset of fields to update; omitted fields are left untouched. ${NOTE_WRITE_TIER}`,
    {
      playLogId: z.string().uuid().describe("Play log row UUID to update — not a game id."),
      playedAt: z.string().describe("Play date, YYYY-MM-DD. Must be today or earlier."),
      dateKnown: z.boolean().optional(),
      locationId: z.string().uuid().nullable().optional(),
      locationText: z.string().max(200).nullable().optional(),
      note: z.string().max(500).nullable().optional(),
      score: z.number().int().min(0).nullable().optional().describe("Score on the machine, not a fun rating."),
      isReplay: z.boolean().optional(),
    },
    async (args) => {
      const data = await postAction({ handler: "updatePlayLog", ...args });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- kineticist_delete_play_log ---
  tool(
    "kineticist_delete_play_log",
    `Delete an existing play log row owned by the authenticated user. Use the play log id from a prior list — these are NOT game ids. Decrements the game's plays_count via the same DB trigger that powers undo_last_play. ${NOTE_WRITE_TIER}`,
    {
      playLogId: z.string().uuid().describe("Play log row UUID to delete — not a game id."),
    },
    async (args) => {
      const data = await postAction({ handler: "deletePlayLog", playLogId: args.playLogId });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- kineticist_update_ownership_details ---
  tool(
    "kineticist_update_ownership_details",
    `Update the rich detail on the authenticated user's most-recent open ownership record for a game (purchase price, source, trade detail, trim, sale price). The user must currently own the game. Pass any subset of fields; omitted fields are left untouched. ${NOTE_WRITE_TIER}`,
    {
      gameId: GAME_ID_SCHEMA,
      purchasePrice: z.number().min(0).optional().describe("USD."),
      purchaseSource: z.string().max(200).optional(),
      tradeDetail: z.string().max(500).optional(),
      trimId: z.string().uuid().optional().describe("Optional trim/edition UUID."),
      salePrice: z.number().min(0).optional().describe("USD. Only meaningful for previously-owned (closed) records."),
    },
    async (args) => {
      const data = await postAction({ handler: "updateOwnershipDetails", ...args, gameId: stripGamePrefix(args.gameId) });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- kineticist_submit_review ---
  tool(
    "kineticist_submit_review",
    `Save the authenticated user's review (fun score 1-100 + optional written body) for a game. Upserts on (game, user). The score is the same one kineticist_set_fun_score touches; submitting a review with score keeps both surfaces aligned. ${NOTE_WRITE_TIER}`,
    {
      gameId: GAME_ID_SCHEMA,
      score: z.number().int().min(1).max(100),
      body: z.string().max(5000).optional().describe("Optional written review. Omit or empty string for score-only."),
    },
    async (args) => {
      const data = await postAction({ handler: "submitReview", ...args, gameId: stripGamePrefix(args.gameId) });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- kineticist_delete_review ---
  tool(
    "kineticist_delete_review",
    `Delete the authenticated user's review for a game. Errors if the user has no review on this game. The fun score recorded via kineticist_set_fun_score is NOT removed by this — call kineticist_delete_fun_score for that. ${NOTE_WRITE_TIER}`,
    {
      gameId: GAME_ID_SCHEMA,
    },
    async (args) => {
      const data = await postAction({ handler: "deleteReview", gameId: stripGamePrefix(args.gameId) });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  // --- kineticist_get_my_state ---
  tool(
    "kineticist_get_my_state",
    "Get the authenticated user's engagement state for a game: owned, wishlist flags, play count, latest play, fun score, ownership details (trim, purchase price, acquired/removed dates). Read-only. Use after a write tool to verify.",
    {
      gameId: GAME_ID_SCHEMA,
    },
    async (args) => {
      const gameId = stripGamePrefix(args.gameId);
      const data = await api(`/api/v1/me/state?gameId=${encodeURIComponent(gameId)}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  return server;
}
