// CS2 Rich Presence plugin for Vencord
// shows live game info in your discord status
// made by k1ng_op - took way too long lol
//
// works on valve, faceit and community servers
// needs GSI config in cs2 cfg folder to actually get data

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Logger } from "@utils/Logger";
import { ApplicationAssetUtils, FluxDispatcher } from "@webpack/common";
import { PluginNative } from "@utils/types";

const Native = VencordNative.pluginHelpers.CS2RichPresence as PluginNative<typeof import("./native")>;
const logger = new Logger("CS2RichPresence", "#f5a623");

// my discord app id - change this if you fork
const APP_ID = "1041396601907855372";
const CS2_STEAM_ID = "730";
const DEFAULT_PORT = 3500;

// polling intervals
const GSI_POLL = 500;        // how fast we check for new game data
const STEAM_POLL = 12000;    // steam api for lobby info, dont go too fast or you'll get rate limited
const FACEIT_POLL = 15000;   // faceit api, same deal
const TIMEOUT = 15000;       // clear presence if cs2 goes quiet for this long

// gsi data shape - only what we actually use
interface CS2State {
    provider?: {
        steamid: string;
    };
    map?: {
        mode: string;
        name: string;
        phase: "warmup" | "live" | "intermission" | "gameover";
        round: number;
        team_ct?: { score: number };
        team_t?: { score: number };
        // premier sets this to 1, competitive leaves it undefined/0
        num_matches_to_win_series?: number;
    };
    round?: {
        phase: "freezetime" | "live" | "over" | "bomb";
        bomb?: "planted" | "defused" | "exploded";
    };
    player?: {
        steamid: string;
        activity: "playing" | "menu" | "textinput";
        state?: { health: number };
        match_stats?: {
            kills: number;
            assists: number;
            deaths: number;
        };
    };
    allplayers?: Record<string, unknown>;
}

// faceit api responses
interface FaceitPlayer {
    player_id: string;
    nickname: string;
    games?: {
        cs2?: {
            faceit_elo: number;
            skill_level: number;
        };
    };
}

interface FaceitMatchTeam {
    faction_id: string;
    name: string;
    roster: Array<{ player_id: string; nickname: string }>;
}

interface FaceitMatch {
    match_id: string;
    status: string;
    voting?: { map?: { pick: string[] } };
    teams: { faction1: FaceitMatchTeam; faction2: FaceitMatchTeam };
    results?: { score: { faction1: number; faction2: number } };
    faceit_url: string;
}

// discord activity object
interface Activity {
    application_id: string;
    name: string;
    details?: string;
    state?: string;
    type: number;
    flags: number;
    instance: boolean;
    timestamps?: { start?: number };
    assets?: {
        large_image?: string;
        large_text?: string;
        small_image?: string;
        small_text?: string;
    };
    party?: { id: string; size: [number, number] };
    secrets?: { join: string };
    buttons?: Array<{ label: string; url: string }>;
}

interface SteamLobby {
    lobbyId: string | null;
    partySize: number;
}

// figure out what kind of server we're on
// faceit uses scrimcomp5 for 5v5, scrimcomp2 for 2v2
// anything else thats not a valve mode = community server
type ServerType = "valve" | "faceit" | "community";

// active duty maps — only premier plays all of these via veto
// competitive lets you pick specific maps so if we see a veto that used all of these, its premier
const PREMIER_MAPS = new Set([
    "de_dust2", "de_mirage", "de_inferno", "de_nuke",
    "de_ancient", "de_anubis", "de_vertigo", "de_overpass",
]);

// cs2 sends mode="competitive" for BOTH competitive and premier
// the only reliable gsi signal is num_matches_to_win_series:
//   premier = 1 (bo1 from veto)
//   competitive = 0 or undefined (you pick the map directly)
function isPremier(gs: CS2State): boolean {
    if (!gs.map) return false;
    // num_matches_to_win_series is 1 in premier, not set in competitive
    if (gs.map.num_matches_to_win_series === 1) return true;
    return false;
}

function getServerType(gs: CS2State): ServerType {
    const mode = gs.map?.mode ?? "";

    if (mode === "scrimcomp2" || mode === "scrimcomp5") return "faceit";

    const valveModes = new Set([
        "competitive", "premier", "casual", "deathmatch",
        "gungameprogressive", "gungametrbomb", "skirmish",
        "survival", "training", "cooperative", "coopmission", "retakes",
    ]);

    if (mode && !valveModes.has(mode)) return "community";
    return "valve";
}

// map display names + asset keys for discord
// if a map isnt in here it falls back to cs2_logo
const MAPS: Record<string, { name: string; asset: string }> = {
    de_dust2:       { name: "Dust II",      asset: "map_de_dust2"       },
    de_mirage:      { name: "Mirage",       asset: "map_de_mirage"      },
    de_inferno:     { name: "Inferno",      asset: "map_de_inferno"     },
    de_nuke:        { name: "Nuke",         asset: "map_de_nuke"        },
    de_overpass:    { name: "Overpass",     asset: "map_de_overpass"    },
    de_ancient:     { name: "Ancient",      asset: "map_de_ancient"     },
    de_anubis:      { name: "Anubis",       asset: "map_de_anubis"      },
    de_vertigo:     { name: "Vertigo",      asset: "map_de_vertigo"     },
    de_cache:       { name: "Cache",        asset: "map_de_cache"       },
    de_train:       { name: "Train",        asset: "map_de_train"       },
    de_cobblestone: { name: "Cobblestone",  asset: "map_de_cobblestone" },
    de_tuscan:      { name: "Tuscan",       asset: "map_de_tuscan"      },
    de_thera:       { name: "Thera",        asset: "map_de_thera"       },
    de_mills:       { name: "Mills",        asset: "map_de_mills"       },
    de_basalt:      { name: "Basalt",       asset: "map_de_basalt"      },
    cs_office:      { name: "Office",       asset: "map_cs_office"      },
    cs_italy:       { name: "Italy",        asset: "map_cs_italy"       },
    ar_shoots:      { name: "Shoots",       asset: "map_ar_shoots"      },
    ar_baggage:     { name: "Baggage",      asset: "map_ar_baggage"     },
    de_shortdust:   { name: "Short Dust",   asset: "map_de_shortdust"   },
};

const MODES: Record<string, { name: string; maxParty: number }> = {
    competitive:        { name: "Competitive",       maxParty: 5  },
    premier:            { name: "Premier",           maxParty: 5  },
    casual:             { name: "Casual",            maxParty: 10 },
    deathmatch:         { name: "Deathmatch",        maxParty: 6  },
    gungameprogressive: { name: "Arms Race",         maxParty: 6  },
    gungametrbomb:      { name: "Demolition",        maxParty: 5  },
    skirmish:           { name: "Skirmish",          maxParty: 5  },
    survival:           { name: "Danger Zone",       maxParty: 3  },
    training:           { name: "Training",          maxParty: 1  },
    cooperative:        { name: "Guardian",          maxParty: 2  },
    coopmission:        { name: "Co-op Mission",     maxParty: 2  },
    retakes:            { name: "Retakes",           maxParty: 5  },
    scrimcomp2:         { name: "FACEIT 2v2",        maxParty: 2  },
    scrimcomp5:         { name: "FACEIT 5v5",        maxParty: 5  },
    custom:             { name: "Custom / Workshop", maxParty: 10 },
};

// modes that have actual CT vs T teams (dont show score for DM etc)
const TEAM_MODES = new Set([
    "competitive", "premier", "casual", "gungametrbomb",
    "skirmish", "cooperative", "coopmission", "retakes",
    "scrimcomp2", "scrimcomp5", "custom",
]);

const FACEIT_LEVELS: Record<number, string> = {
    1: "Level 1", 2: "Level 2", 3: "Level 3", 4: "Level 4",  5: "Level 5",
    6: "Level 6", 7: "Level 7", 8: "Level 8", 9: "Level 9", 10: "Level 10",
};

function mapName(key?: string): string {
    if (!key) return "Unknown Map";
    return MAPS[key]?.name ?? key
        .replace(/^(de_|cs_|ar_|workshop\/)/, "")
        .replace(/_/g, " ")
        .replace(/\b\w/g, c => c.toUpperCase());
}

function modeName(key?: string): string {
    if (!key) return "Unknown Mode";
    return MODES[key]?.name ?? key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// returns cs2_logo for anything we dont have an image for
function mapAsset(key?: string): string {
    return key ? (MAPS[key]?.asset ?? "cs2_logo") : "cs2_logo";
}

function maxParty(mode?: string): number {
    return mode ? (MODES[mode]?.maxParty ?? 5) : 5;
}

function isTeamMode(mode?: string): boolean {
    return mode ? TEAM_MODES.has(mode) : false;
}

function roundPhaseLabel(phase?: string, roundPhase?: string, bomb?: string): string {
    if (phase === "warmup")         return "Warmup";
    if (phase === "intermission")   return "Halftime";
    if (phase === "gameover")       return "Game Over";
    if (bomb === "planted")         return "Bomb Planted";
    if (bomb === "defused")         return "Bomb Defused";
    if (bomb === "exploded")        return "Bomb Exploded";
    if (roundPhase === "freezetime") return "Buy Phase";
    if (roundPhase === "over")      return "Round Over";
    return "Round Live";
}

// cache asset ids so we dont spam the api every 500ms
const assetCache = new Map<string, string>();

async function resolveAsset(key: string): Promise<string> {
    if (assetCache.has(key)) return assetCache.get(key)!;

    try {
        const [id] = await ApplicationAssetUtils.fetchAssetIds(APP_ID, [key]);
        if (id) {
            assetCache.set(key, id);
            return id;
        }
    } catch {
        // fetchAssetIds can fail if the key doesnt exist, just return key as fallback
    }

    assetCache.set(key, key);
    return key;
}

// warm up all the assets on startup so first update shows images immediately
async function warmCache() {
    const keys = ["cs2_logo", "faceit_logo", ...Object.values(MAPS).map(m => m.asset)];
    try {
        const ids = await ApplicationAssetUtils.fetchAssetIds(APP_ID, keys);
        keys.forEach((k, i) => { if (ids[i]) assetCache.set(k, ids[i]); });
        logger.info(`cached ${assetCache.size} assets`);
    } catch (e) {
        logger.warn("asset warmup failed, will resolve on demand:", e);
    }
}

const settings = definePluginSettings({
    port: {
        type: OptionType.NUMBER,
        description: "GSI server port (must match gamestate_integration_cs2rpc.cfg)",
        default: DEFAULT_PORT,
        restartNeeded: true,
    },
    steamApiKey: {
        type: OptionType.STRING,
        description: "Steam Web API key — needed for party size + lobby status. Get one at steamcommunity.com/dev/apikey",
        default: "",
    },
    faceitApiKey: {
        type: OptionType.STRING,
        description: "FACEIT Data API key — needed for ELO and rank display. Get one at developers.faceit.com",
        default: "",
    },
    showKDA: {
        type: OptionType.BOOLEAN,
        description: "Show K/D/A during matches (hidden automatically when spectating)",
        default: true,
    },
    showHealth: {
        type: OptionType.BOOLEAN,
        description: "Show HP in the map image tooltip",
        default: true,
    },
    showScore: {
        type: OptionType.BOOLEAN,
        description: "Show CT vs T score (only in team modes, wont show in DM etc)",
        default: true,
    },
    showRound: {
        type: OptionType.BOOLEAN,
        description: "Show current round number",
        default: true,
    },
    clearOnMenu: {
        type: OptionType.BOOLEAN,
        description: "Clear presence when in main menu instead of showing idle",
        default: false,
    },
});

// runtime state
let gsiTimer: ReturnType<typeof setInterval> | null = null;
let steamTimer: ReturnType<typeof setInterval> | null = null;
let faceitTimer: ReturnType<typeof setInterval> | null = null;

let matchStart: number | null = null;
let lastMapName: string | null = null;
let lastPhase: string | null = null;
let lastPayloadAt = 0;
let lastGS: CS2State | null = null;
let knownSteamId: string | null = null;
let gameActive = false;
let activeMode: string | null = null;
let inMatch = false;

let steamLobby: SteamLobby = { lobbyId: null, partySize: 1 };

// premier rating — fetched from steam user stats api, cached here
// null = not fetched yet or player hasnt played premier
let premierRating: number | null = null;
let premierRatingFetched = false; // so we only try once per session

// faceit live match data
interface FaceitLive {
    matchId: string;
    mapName: string;
    score: { us: number; them: number };
    elo: number;
    level: number;
    matchUrl: string;
}

let faceitLive: FaceitLive | null = null;
let faceitPlayerId: string | null = null;

function setActivity(a: Activity | null) {
    FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity: a,
        socketId: "CS2RichPresence",
    });
}

function clearActivity() {
    setActivity(null);
}

// steam api stuff - runs through native.ts because the renderer has CSP issues with external fetches
interface SPSummary { steamid: string; gameid?: string; lobbysteamid?: string }
interface SPSResponse { response: { players: SPSummary[] } }
interface FriendList { friendslist?: { friends: { steamid: string }[] } }

async function steamGet<T>(path: string, params: Record<string, string>): Promise<T | null> {
    const key = settings.store.steamApiKey?.trim();
    if (!key) return null;
    try {
        const raw = await Native.steamRequest(path, { key, ...params });
        return raw ? JSON.parse(raw) as T : null;
    } catch {
        return null;
    }
}

async function fetchLobby(steamId: string): Promise<SteamLobby> {
    const res = await steamGet<SPSResponse>("/ISteamUser/GetPlayerSummaries/v2/", { steamids: steamId });
    const me = res?.response?.players?.[0];

    if (!me || me.gameid !== CS2_STEAM_ID) return { lobbyId: null, partySize: 1 };

    const lobbyId = me.lobbysteamid ?? null;
    if (!lobbyId) return { lobbyId: null, partySize: 1 };

    // count friends in same lobby
    const fl = await steamGet<FriendList>("/ISteamUser/GetFriendList/v1/", {
        steamid: steamId,
        relationship: "friend",
    });
    const friendIds = fl?.friendslist?.friends?.map(f => f.steamid) ?? [];

    let partySize = 1;
    for (let i = 0; i < friendIds.length; i += 100) {
        const batch = await steamGet<SPSResponse>("/ISteamUser/GetPlayerSummaries/v2/", {
            steamids: friendIds.slice(i, i + 100).join(","),
        });
        for (const p of batch?.response?.players ?? []) {
            if (p.lobbysteamid === lobbyId) partySize++;
        }
    }

    return { lobbyId, partySize };
}

function startSteamPolling(steamId: string) {
    if (steamTimer) return;
    knownSteamId = steamId;

    const tick = async () => {
        steamLobby = await fetchLobby(steamId);
        // also grab premier rating if we havent yet
        if (!premierRatingFetched) {
            await fetchPremierRating(steamId);
        }
        if (lastGS) buildAndSet(lastGS);
    };

    tick(); // run immediately dont wait 12s for first update
    steamTimer = setInterval(tick, STEAM_POLL);
}

// fetch premier cs rating from steam user stats
// the stat is called "game_type_ranking_premier" in cs2's steam stats
async function fetchPremierRating(steamId: string): Promise<void> {
    premierRatingFetched = true; // mark as attempted regardless of result
    try {
        const res = await steamGet<{
            playerstats?: {
                stats?: Array<{ name: string; value: number }>;
            };
        }>("/ISteamUserStats/GetUserStatsForGame/v2/", {
            steamid: steamId,
            appid: CS2_STEAM_ID,
        });

        const stats = res?.playerstats?.stats ?? [];
        const ratingEntry = stats.find(s => s.name === "game_type_ranking_premier");
        if (ratingEntry && ratingEntry.value > 0) {
            premierRating = ratingEntry.value;
            logger.info(`premier rating: ${premierRating}`);
        }
    } catch (e) {
        logger.warn("couldnt fetch premier rating:", e);
    }
}

function stopSteamPolling() {
    if (steamTimer) { clearInterval(steamTimer); steamTimer = null; }
    steamLobby = { lobbyId: null, partySize: 1 };
}

// faceit api
async function faceitGet<T>(path: string): Promise<T | null> {
    const key = settings.store.faceitApiKey?.trim();
    if (!key) return null;
    try {
        const raw = await Native.faceitRequest(path, key);
        return raw ? JSON.parse(raw) as T : null;
    } catch {
        return null;
    }
}

async function getFaceitPlayerId(steamId: string): Promise<string | null> {
    if (faceitPlayerId) return faceitPlayerId;

    const res = await faceitGet<{ items: FaceitPlayer[] }>(`/players?game=cs2&game_player_id=${steamId}`);
    const player = res?.items?.[0];
    if (player?.player_id) {
        faceitPlayerId = player.player_id;
        return player.player_id;
    }
    return null;
}

async function fetchFaceitMatch(steamId: string): Promise<FaceitLive | null> {
    const playerId = await getFaceitPlayerId(steamId);
    if (!playerId) return null;

    // try active match endpoint first
    const active = await faceitGet<FaceitMatch>(`/players/${playerId}/active-match`);
    if (active?.status === "ONGOING") return buildFaceitData(active, playerId);

    // fallback to history
    const history = await faceitGet<{ items: FaceitMatch[] }>(`/players/${playerId}/history?game=cs2&limit=1`);
    const match = history?.items?.[0];
    if (match?.status === "ONGOING") return buildFaceitData(match, playerId);

    return null;
}

async function buildFaceitData(match: FaceitMatch, playerId: string): Promise<FaceitLive | null> {
    const playerData = await faceitGet<FaceitPlayer>(`/players/${playerId}`);
    const elo = playerData?.games?.cs2?.faceit_elo ?? 0;
    const level = playerData?.games?.cs2?.skill_level ?? 0;

    const myTeam = Object.values(match.teams).find(t =>
        t.roster.some(r => r.player_id === playerId)
    );

    const mapName = match.voting?.map?.pick?.[0] ?? "Unknown Map";
    const score = match.results?.score ?? { faction1: 0, faction2: 0 };
    const myFaction = myTeam?.faction_id === "faction1" ? "faction1" : "faction2";
    const theirFaction = myFaction === "faction1" ? "faction2" : "faction1";

    return {
        matchId: match.match_id,
        mapName,
        score: { us: score[myFaction] ?? 0, them: score[theirFaction] ?? 0 },
        elo,
        level,
        matchUrl: match.faceit_url.replace("{lang}", "en"),
    };
}

function startFaceitPolling(steamId: string) {
    if (faceitTimer || !settings.store.faceitApiKey?.trim()) return;

    const tick = async () => {
        faceitLive = await fetchFaceitMatch(steamId);
        if (lastGS) buildAndSet(lastGS);
    };

    tick();
    faceitTimer = setInterval(tick, FACEIT_POLL);
}

function stopFaceitPolling() {
    if (faceitTimer) { clearInterval(faceitTimer); faceitTimer = null; }
    faceitLive = null;
}

// builds the discord activity object and dispatches it
async function buildAndSet(gs: CS2State) {
    const player = gs.player;
    const map = gs.map;
    const round = gs.round;
    const mySteamId = gs.provider?.steamid;
    const serverType = map ? getServerType(gs) : "valve";

    // track match state
    if (map) {
        inMatch = true;
        // store the real resolved mode — "premier" instead of "competitive" when applicable
        if (map.mode) activeMode = (map.mode === "competitive" && isPremier(gs)) ? "premier" : map.mode;

        if (map.name !== lastMapName) {
            lastMapName = map.name;
            matchStart = Date.now();
        }
        if (map.phase === "live" && lastPhase === "warmup") {
            matchStart = Date.now();
        }
        lastPhase = map.phase;
    } else {
        inMatch = false;
        lastPhase = null;
    }

    const spectating = !!(mySteamId && player?.steamid && player.steamid !== mySteamId);

    // faceit match
    if (inMatch && map && serverType === "faceit" && faceitLive) {
        const mn = mapName(faceitLive.mapName);
        const img = await resolveAsset(mapAsset(faceitLive.mapName));
        const faceitIcon = await resolveAsset("faceit_logo");

        let details = `FACEIT  —  ${mn}  —  ${faceitLive.score.us} : ${faceitLive.score.them}`;
        if (settings.store.showRound && map.round > 0) details += `  —  Round ${map.round}`;

        let state = `${FACEIT_LEVELS[faceitLive.level] ?? "Level ?"} (${faceitLive.elo} ELO)`;
        if (!spectating && settings.store.showKDA && player?.match_stats) {
            const { kills, deaths, assists } = player.match_stats;
            state += `  —  ${kills} / ${deaths} / ${assists}`;
        }

        let largeText = `FACEIT  —  ${mn}`;
        if (!spectating && settings.store.showHealth && player?.state?.health !== undefined) {
            largeText += `  —  ${player.state.health} HP`;
        }

        setActivity({
            application_id: APP_ID,
            name: "Counter-Strike 2",
            type: 0, flags: 1, instance: false,
            details, state,
            assets: {
                large_image: img,
                large_text: largeText,
                small_image: faceitIcon,
                small_text: "FACEIT",
            },
            timestamps: matchStart ? { start: matchStart } : undefined,
            buttons: faceitLive.matchUrl
                ? [{ label: "View Match", url: faceitLive.matchUrl }]
                : undefined,
        });
        return;
    }

    // valve or community match
    if (inMatch && map) {
        const mn = mapName(map.name);
        const phase = roundPhaseLabel(map.phase, round?.phase, round?.bomb);
        const ct = map.team_ct?.score ?? 0;
        const t = map.team_t?.score ?? 0;
        const rnd = map.round ?? 0;

        // figure out the real mode label
        // cs2 sends mode="competitive" for both premier and competitive
        // isPremier() uses num_matches_to_win_series to tell them apart
        const isActuallyPremier = map.mode === "competitive" && isPremier(gs);
        const resolvedMode = isActuallyPremier ? "premier" : map.mode;
        const modeLabel = serverType === "community" ? "Community Server" : modeName(resolvedMode);
        const max = maxParty(resolvedMode);

        let details = mn;
        if (serverType === "community") {
            details += "  —  Community Server";
        } else if (settings.store.showScore && isTeamMode(resolvedMode) &&
            (map.phase === "live" || map.phase === "intermission" || map.phase === "gameover")) {
            details += `  —  CT ${ct} : ${t} T`;
        }
        if (settings.store.showRound && rnd > 0) details += `  —  Round ${rnd}`;

        let state = `${modeLabel}  —  ${phase}`;

        // show premier rating in the state line if we have it
        if (isActuallyPremier && premierRating !== null) {
            state += `  —  ${premierRating.toLocaleString()} Rating`;
        }

        if (!spectating && settings.store.showKDA && player?.match_stats) {
            const { kills, deaths, assists } = player.match_stats;
            state += `  —  ${kills} / ${deaths} / ${assists}`;
        } else if (spectating) {
            state += "  —  Spectating";
        }

        const knownMap = !!MAPS[map.name];
        let largeText = knownMap ? `${mn}  —  ${modeLabel}` : `${mn}  —  Community Map`;
        // show premier rating in tooltip too if space allows
        if (isActuallyPremier && premierRating !== null) {
            largeText += `  —  ${premierRating.toLocaleString()} CS Rating`;
        }
        if (!spectating && settings.store.showHealth && player?.state?.health !== undefined) {
            largeText += `  —  ${player.state.health} HP`;
        }

        const img = await resolveAsset(mapAsset(map.name));

        let party: Activity["party"];
        let secrets: Activity["secrets"];
        if (steamLobby.lobbyId) {
            party = { id: steamLobby.lobbyId, size: [steamLobby.partySize, max] };
            secrets = { join: steamLobby.lobbyId };
        }

        setActivity({
            application_id: APP_ID,
            name: "Counter-Strike 2",
            type: 0, flags: 1, instance: false,
            details, state,
            assets: { large_image: img, large_text: largeText },
            timestamps: matchStart ? { start: matchStart } : undefined,
            party, secrets,
        });
        return;
    }

    // main menu / lobby
    if (settings.store.clearOnMenu) { clearActivity(); return; }

    const hasKey = !!settings.store.steamApiKey?.trim();
    const { lobbyId, partySize } = steamLobby;
    const modeStr = activeMode ? modeName(activeMode) : null;
    const mp = maxParty(activeMode ?? undefined);

    let details: string;
    let state: string;

    if (hasKey && lobbyId && partySize > 1) {
        details = modeStr ? `${modeStr}  —  In Lobby` : "In Lobby";
        state = "In a Party";
    } else if (hasKey && lobbyId) {
        details = modeStr ? `${modeStr}  —  In Lobby` : "In Lobby";
        state = "Awaiting Players";
    } else if (hasKey && !lobbyId && modeStr) {
        details = `${modeStr}  —  Searching`;
        state = "Looking for a Match";
    } else if (modeStr) {
        details = `${modeStr}  —  Main Menu`;
        state = "Browsing";
    } else {
        details = "Main Menu";
        state = "Browsing";
    }

    const logo = await resolveAsset("cs2_logo");
    const hasLobby = hasKey && !!lobbyId;

    setActivity({
        application_id: APP_ID,
        name: "Counter-Strike 2",
        type: 0, flags: 1, instance: false,
        details, state,
        assets: { large_image: logo, large_text: "Counter-Strike 2" },
        party: hasLobby ? { id: lobbyId!, size: [partySize, mp] } : undefined,
        secrets: hasLobby ? { join: lobbyId! } : undefined,
    });
}

async function handlePayload(body: string) {
    try {
        const gs: CS2State = JSON.parse(body);
        lastGS = gs;
        gameActive = true;

        const steamId = gs.provider?.steamid ?? null;
        if (steamId && steamId !== knownSteamId) {
            knownSteamId = steamId;
            startSteamPolling(steamId);
            startFaceitPolling(steamId);
        }

        await buildAndSet(gs);
    } catch (e) {
        logger.error("failed to parse gsi payload:", e);
    }
}

function startPolling() {
    stopPolling();
    gsiTimer = setInterval(async () => {
        try {
            const { payload, time } = await Native.getLastPayload();

            if (payload && time > lastPayloadAt) {
                lastPayloadAt = time;
                await handlePayload(payload);
                return;
            }

            // cs2 probably closed
            if (gameActive && lastPayloadAt > 0 && Date.now() - lastPayloadAt > TIMEOUT) {
                logger.info("cs2 went quiet, clearing presence");
                gameActive = false;
                inMatch = false;
                lastGS = null;
                knownSteamId = null;
                activeMode = null;
                stopSteamPolling();
                stopFaceitPolling();
                clearActivity();
            }
        } catch (e) {
            logger.error("gsi poll error:", e);
        }
    }, GSI_POLL);
}

function stopPolling() {
    if (gsiTimer) { clearInterval(gsiTimer); gsiTimer = null; }
}

export default definePlugin({
    name: "CS2RichPresence",
    description: "Live CS2 rich presence — supports Valve, FACEIT and community servers. Shows map, score, K/D/A, ELO, lobby size.",
    authors: [{ name: "k1ng_op", id: 641266820187160576n }],
    settings,

    async start() {
        // reset everything on start
        matchStart = null;
        lastMapName = null;
        lastPhase = null;
        lastPayloadAt = 0;
        lastGS = null;
        knownSteamId = null;
        activeMode = null;
        gameActive = false;
        inMatch = false;
        faceitPlayerId = null;
        faceitLive = null;
        premierRating = null;
        premierRatingFetched = false;
        steamLobby = { lobbyId: null, partySize: 1 };
        assetCache.clear();

        await warmCache();

        const result = await Native.startServer(settings.store.port ?? DEFAULT_PORT);
        if (result === "error") {
            logger.error("couldnt start gsi server");
            return;
        }

        logger.info("cs2richpresence started");
        startPolling();
    },

    async stop() {
        stopPolling();
        stopSteamPolling();
        stopFaceitPolling();
        await Native.stopServer();
        clearActivity();
    },
});
