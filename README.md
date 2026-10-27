> Read-only mirror of the Kineticist MCP server. Changes are made in
> the Kineticist repo; issues and questions go to contact@kineticist.com.

# @kineticist/mcp-server

Model Context Protocol server for the Kineticist pinball game database. Lets
AI agents like Claude, Cursor, and ChatGPT search the catalog, read game
details, and act on your own library: log plays, toggle ownership and
wishlist, set fun scores, write reviews.

**Just want to read Kineticist? You don't need this package or a key.** Add
the hosted server, `https://www.kineticist.com/api/mcp`, to your app. In Claude,
it's in the connector directory: <https://claude.ai/directory/kineticist>.
Setup for ChatGPT, Cursor and Codex: <https://www.kineticist.com/mcp>.

This package runs locally and needs a Kineticist API key. It has every tool the
hosted server has, plus tools that change your own library.

## Install

### Claude Desktop

Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kineticist": {
      "command": "npx",
      "args": ["@kineticist/mcp-server"],
      "env": {
        "KINETICIST_API_KEY": "ki_live_..."
      }
    }
  }
}
```

### Cursor

Edit `.cursor/mcp.json` in your project (same shape as above).

### Claude Code

```bash
claude mcp add kineticist \
  --env KINETICIST_API_KEY=ki_live_... \
  -- npx @kineticist/mcp-server
```

Create an API key at <https://www.kineticist.com/settings>.

## Tools

The server exposes 23 tools: 10 for reading Kineticist and 13 for acting on
the key owner's own library. All of them call Kineticist's REST API with your
key.

### Read tools

| Tool | Description |
| --- | --- |
| `search_pinball_games` | Search and filter games with natural language |
| `get_game_details` | Full game info with editions, images, and description |
| `get_game_credits` | Design team for a game |
| `list_game_files` | Game files grouped by machine, optional machine filter |
| `get_random_game` | Random game for discovery |
| `get_pinball_stats` | Database statistics |
| `where_to_play` | Venues near a postal code or city, optionally only those with a given game |
| `search` | Search games, news, places to play, people, manufacturers, mods, Hype Index entries and creators |
| `get` | Read any Kineticist page by its link; news as headline, summary and link |
| `whats_new` | Latest news, new videos and podcasts from creators, and Hype Index moves |

Read tools return each game's and person's page on www.kineticist.com, so
answers can link back. Files download from the game page with a free
Kineticist account. Every tool carries a `title` and MCP annotations
(`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).

### Your library tools

Wrap `POST /api/v1/me/actions` and `GET /api/v1/me/state`. All act on the
data belonging to the API key owner.

| Tool | Description |
| --- | --- |
| `kineticist_get_my_state` | Read your state for a game: ownership, wishlist, plays, fun score, favorite |
| `kineticist_log_play` | Log a play with optional date, location, note, score, replay flag |
| `kineticist_toggle_ownership` | Mark as owned or no longer owned |
| `kineticist_toggle_want` | Toggle want-to-play or want-to-own |
| `kineticist_set_fun_score` | Set your fun score (0–100) |
| `kineticist_undo_last_play` | Remove the most recent play for a game |
| `kineticist_update_play_log` | Edit a logged play |
| `kineticist_delete_play_log` | Delete a logged play |
| `kineticist_toggle_favorite` | Add or remove a game from your favorites, or follow or unfollow a creator (by `promoterId` or its page slug, `promoterSlug`) |
| `kineticist_delete_fun_score` | Remove your fun score |
| `kineticist_update_ownership_details` | Edit ownership details for a game you own |
| `kineticist_submit_review` | Write or update your review of a game |
| `kineticist_delete_review` | Delete your review |

## Example conversations

Once the server is configured, your agent can answer things like:

- *"What Stern games are currently in production?"*
- *"Who designed Medieval Madness?"*
- *"Give me a random pinball machine I've never heard of."*
- *"Log that I played Godzilla at Pin Museum last night and give it an 87."*
- *"What's my state on The Addams Family?"*
- *"Undo my last play of Stranger Things."*

## Tiers

Every account has one of three tiers, and its limits are shared by all of the
account's keys (a second key doesn't add quota). **All tiers are free during
early access**; the tier just sets the ceiling.

| Tier | Burst (per second) | Per minute | Per day |
| --- | --- | --- | --- |
| `free` | 10 | 60 | 1,000 |
| `builder` | 20 | 120 | 5,000 |
| `partner` | 30 | 200 | 25,000 |

New accounts start on `free`. Agents that make dozens of calls per task burn
through a free account quickly. Email <colin@kineticist.com> with a short
note about what you're building if you need a higher ceiling.

## Full reference

- Web docs: <https://www.kineticist.com/docs/api>
- Interactive REST reference: <https://www.kineticist.com/docs/api/reference>
- OpenAPI spec: <https://www.kineticist.com/openapi.json>
- CLI: [`@kineticist/cli`](https://www.npmjs.com/package/@kineticist/cli)

## License

MIT
