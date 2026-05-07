# CS2RichPresence

a vencord plugin that shows your live cs2 game info in discord. works on valve servers, faceit, and community servers.

made by **k1ng_op**

---

## what it shows

**in a match:**
```
Counter-Strike 2
Mirage  —  CT 8 : 5 T  —  Round 14
Competitive  —  Buy Phase  —  12 / 3 / 2
[map image]  ⏱ 23:41
```

**in lobby:**
```
Counter-Strike 2
Competitive  —  In Lobby
In a Party
👥 3 of 5
```

**on faceit:**
```
Counter-Strike 2
FACEIT  —  Mirage  —  8 : 5  —  Round 14
Level 9 (2847 ELO)  —  12 / 3 / 2
[View Match button]
```

**community server:**
```
Counter-Strike 2
Dust II  —  Community Server  —  Round 5
Community Server  —  Round Live  —  4 / 1 / 0
```

---

## features

- map thumbnails for all active duty maps (community maps use cs2 logo as fallback)
- live score, round number and round phase
- k/d/a stats (hidden automatically when spectating)
- hp in the map image tooltip
- party size and lobby status via steam api
- faceit elo + rank level when playing on faceit servers
- auto clears after 15s when you close cs2
- no external process needed, runs inside discord

---

## setup

### 1. install the plugin

put the `CS2RichPresence` folder in your vencord userplugins directory:

```
vencord/src/userplugins/CS2RichPresence/
```

use `userplugins` not `plugins` — it wont get wiped when you update vencord.

### 2. copy the gsi config

copy `gamestate_integration_cs2rpc.cfg` to your cs2 cfg folder:

**windows**
```
C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\
```

**linux / steam deck**
```
~/.steam/steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg/
```

fully restart cs2 after this, just alt+f4 and relaunch from steam.

### 3. build vencord

```bash
pnpm install
pnpm build
```

### 4. enable the plugin

discord → settings → vencord → plugins → search `CS2RichPresence` → enable

---

## settings

| setting | default | what it does |
|---|---|---|
| Port | 3500 | gsi server port, change if something else is using 3500 (restart discord after) |
| Steam API Key | — | needed for party size + lobby detection |
| FACEIT API Key | — | needed for elo/rank on faceit servers |
| Show K/D/A | on | your kills/deaths/assists, auto-hides when spectating |
| Show Health | on | hp shown in map image tooltip |
| Show Score | on | ct vs t score, only shows in modes that have teams |
| Show Round | on | current round number |
| Clear on Menu | off | hide presence entirely when in menu instead of showing idle |

---

## steam api setup (for party size)

1. go to [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) and get a free key
2. paste it in plugin settings → Steam API Key
3. go to steam → your profile → edit profile → privacy settings → set **game details** to **public**

your friends also need public profiles for the friend count to work. if their profiles are private, party size will show as 1 even when you're with friends.

---

## faceit setup

1. go to [developers.faceit.com](https://developers.faceit.com), create an account and register an app
2. grab the Data API key
3. paste it in plugin settings → FACEIT API Key

detection is automatic — when you're on a faceit server (uses `scrimcomp5` game mode in gsi) it switches to the faceit display.

---

## how it works

cs2 has a built-in feature called game state integration (gsi) that posts a json snapshot of the game to any local http server you configure. this plugin runs a small http server inside discord (using vencord's native.ts electron main process support), receives those payloads, and updates your discord presence.

steam + faceit api calls go through `native.ts` too because the renderer has content security policy restrictions that block external requests.

```
cs2 → POST every 0.5s → localhost:3500 (native.ts)
                              ↓ IPC
                         index.ts (renderer)
                              ↓
                    steam api (every 12s)  +  faceit api (every 15s)
                              ↓
                    FluxDispatcher → discord presence
```

gsi is an official valve feature, not a mod. it won't get you VAC banned.

---

## troubleshooting

**nothing is showing**
- check the cfg file is in the right folder and cs2 was fully restarted
- open discord devtools (ctrl+shift+i) → console → filter by `CS2RPC` to see what's happening
- run `netstat -an | findstr 3500` in powershell, should see LISTENING and TIME_WAIT entries

**party shows as 1 even with friends**
- steam profile must be public, specifically game details
- check by pasting this in browser: `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=YOURKEY&steamids=YOURSTEAMID64`
- look for `lobbysteamid` in the response when you're in a lobby. if it's not there, steam isn't exposing it

**faceit not showing**
- make sure your faceit api key is in settings
- faceit detection is automatic based on game mode string — you shouldn't need to do anything

**port already in use**
- change the port in plugin settings AND in the cfg file (the `"uri"` line), then restart both discord and cs2

---

## license

GPL-3.0-or-later

---

*if this was useful, a star would be sick*
