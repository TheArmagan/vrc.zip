# Parser pattern reference

Every shape the parser recognises, with a title for what it does.

There are no regular expressions in the parser. This is deliberate — see
`crates/vrclog-core/src/events.rs:4`:

> No regex is involved: the shapes are fixed, so prefix matching is both faster
> and easier to audit against real logs.

So "pattern" below means one of three things, and each table says which:

- **offset** — a byte compared at a fixed position in the line
- **prefix** — `starts_with` / `strip_prefix` on the message or body
- **scan** — a substring search, a split on a separator, or a delimiter hunt

Prefix tests are ordered by observed frequency so the common cases exit early,
and scans always run last within a group — every cheaper test has had its chance
first.

---

## 1. Line structure — `crates/vrclog-core/src/time.rs`

VRChat writes `YYYY.MM.DD HH:MM:SS <level padded to 10> -  <message>`, so the
message body always begins at byte 34 (`MSG_OFFSET`).

```
2026.08.18 23:09:05 Debug      -  [Behaviour] OnPlayerJoined Gandalf345 (usr_9c24...)
^0        ^10       ^20        ^31^34
```

| Kind | Pattern | What it does |
|---|---|---|
| offset | `.` at 4, `.` at 7, ` ` at 10, `:` at 13, `:` at 16, ` ` at 19 | **Shape gate.** Six cheap byte compares that reject virtually every continuation line before any digit parsing happens. |
| offset | two ASCII digits at 0, 2, 5, 8, 11, 14, 17 | **Timestamp fields** — year (two pairs), month, day, hour, minute, second. |
| offset | `-  ` at 31–33 | **Entry confirmation.** Checked after the digits: it stops world text that happens to open with a date from faking a log entry. |
| range | month 1–12, day 1–31, hour ≤ 23 | **Validity gate.** Rejects a shape-valid prefix carrying impossible values. |
| offset | first byte of the 10-wide field at 20 | **Level.** `D`→Debug, `W`→Warning, `Er`→Error, `E`→Exception, `A`→Assert, `I`→Info, `L`→Debug, anything else→Debug. |

Timestamps are kept naive and converted to epoch seconds only so ordering and
duration arithmetic are integer work. No timezone conversion is ever applied.

---

## 2. Scanner behaviour — `crates/vrclog-core/src/parser.rs`

One pass over the bytes. The prefix test above decides everything.

| Kind | Pattern | What it does |
|---|---|---|
| prefix | `EF BB BF` at byte 0 | **UTF-8 BOM strip.** Done once, before scanning. |
| scan | `\n`, with a trailing `\r` trimmed | **Line split.** CRLF costs no extra pass. |
| — | prefix matches | **Open a new entry.** Records epoch, byte range, line number, level, category. |
| — | prefix misses | **Continuation.** Extends the previous entry's end, so stack traces and the `Environment Info` block stay in one entry. Blank or junk lines before the first entry are dropped. |
| — | invalid UTF-8 | **Replace, don't reject.** Logs are frequently truncated mid-character by a crash; losing one glyph beats refusing the file. A warning is recorded. |
| — | zero entries but nonzero lines | **"Not a VRChat log" warning.** |

---

## 3. Tag dispatch — `crates/vrclog-core/src/events.rs`

| Kind | Pattern | What it does |
|---|---|---|
| scan | `[` at byte 0, then first `]` within 64 bytes | **Leading tag.** Bounded so a stray `[` in world text cannot scan the whole line. |
| lookup | tag not in `CLIENT_TAGS` | **SDK / world script output.** The fallback: anything bracketed the client does not emit itself is world or avatar script output — what users mean by "SDK logs". |

Tag to category:

| Tag | Category |
|---|---|
| `PortalManager` | Travel |
| `Video Playback`, `AVProVideo`, `VVMW` | Video |
| `String Download`, `Image Download`, `AssetBundleDownloadManager`, `TextureManagement` | Download |
| `API` | Api |
| `ApiCertificateVerifier` | Network — TLS verification failures are transport problems, not failed API requests; mixing them corrupts the API failure list |
| `UserInfoLogger`, `SteamManager`, `SettingsManager`, `VersionChecker` | Environment |
| `UdonBehaviour` | Sdk |
| `StickersManager`, `VRCProps`, `VRCItems` | Prop |
| `VRCX` + body starting `VideoPlay` | Video — the only place the real video *title* appears; the client logs URLs only |
| `VRCX` otherwise | Other — companion app, not a world script |
| `VRCTrackingOSC` | Osc |
| `NetworkProcessing`, `NetworkTransport`, `WebsocketPipeline`, `EOSManager` | Network — matched explicitly rather than through the linear `CLIENT_TAGS` scan, because these dominate real logs by volume |
| `Behaviour` | dispatched again on the body — section 4 |

The full `CLIENT_TAGS` list is in `events.rs`; membership is what separates
client output from world scripts.

---

## 4. `[Behaviour]` body — `events.rs::classify_behaviour`

The highest-volume tag in the log, so this list is ordered by frequency.

| Kind | Pattern | What it does |
|---|---|---|
| prefix | `OnPlayerJoined` | **Player join** |
| prefix | `OnPlayerLeft ` | **Player leave.** The trailing space is load-bearing: it excludes `OnPlayerLeftRoom`, which carries no name and would corrupt per-player session pairing. |
| prefix | `Joining `, `Joining or Creating Room:` | **Instance join** |
| prefix | `Entering Room:`, `Successfully joined room`, `Finished entering world` | **Instance ready** |
| prefix | `OnLeftRoom`, `OnDisconnected`, `OnPlayerLeftRoom` | **Instance leave** |
| prefix | `Destination ` | **Travel** |
| prefix | `Switching `, `Loading avatar for` | **Avatar switch** |
| prefix | `Using network server version:`, `Microphone device changing`, `Audio device changing` | **Environment** |
| prefix | `Avatar is Ready`, `CacheComponents`, `Initialize ThreePoint`, `Initialize Limb`, `Using default gesture mask`, `Using custom gesture mask`, `Using default fx mask`, `Measuring avatar`, `AvatarMeasure` | **Avatar load pipeline.** The single largest source of Behaviour lines; labelling it is what keeps the "other" bucket meaningful. |
| prefix | `OnPlayerEnteredRoom`, `OnMasterClientSwitched`, `Configuring remote player`, `Waiting for Properties`, `Initialized player`, `Initialized PlayerAPI`, `Restored player` | **Remote player setup** → Network |
| scan | contains `portal` or `Portal` | **Travel fallback.** The only non-prefix test here, so it runs last — this keeps the frequent avatar-pipeline lines from paying for a full-line search. |
| — | Error level, nothing matched | **Problem** |

---

## 5. Untagged messages — `events.rs::classify`

| Kind | Pattern | What it does |
|---|---|---|
| prefix | `User Authenticated:` | **Auth** |
| prefix / scan | `OSC::`, `OSCQuery`, or `Advertising Service` containing `type OSC` | **OSC** |
| prefix | `Received Notification:`, `FriendUpdated:` | **Notification** |
| prefix | `VRChat Build:`, `Using server environment:`, `Launching with args:`, `Arg: ` | **Environment** |
| — | Error/Exception level, nothing matched | **Problem** |
| — | anything else | **Other** |

---

## 6. Shared field extraction — `events.rs`

| Kind | Pattern | What it does |
|---|---|---|
| scan | rightmost ` (usr_`, line ends `)` | **Name-then-id split.** Searched right-to-left because display names may themselves contain parentheses. Falls back to the whole string when no id is present, which happens on `OnPlayerJoinComplete`. |
| scan | first ` (`, then `)` | **Id-then-name split.** Sticker lines invert the join-line order, so reusing the join parser here would swap the two fields. |
| scan | first `'` pair | **Quoted value.** Lifts the URL out of download and video lines. |
| scan | `<` … `>`, depth-counted | **Unity rich-text strip.** Scripts colour their own tags, so `[<color=#B5438F>Billiards</color>]` and `[Billiards]` must not become two groups. Borrows when there is nothing to strip, which is nearly every line. |
| replace | `․` `‚` `＆` `ǃ` `＃` `／` `：` | **Name de-sanitize.** VRChat substitutes lookalike Unicode for characters that would break its own log parsing; mapping them back to `. , & ! # / :` makes names searchable with a normal keyboard. |

---

## 7. Session building — `crates/vrclog-core/src/build.rs`

### Environment

| Kind | Pattern | What it does |
|---|---|---|
| prefix | `Using server environment:` | **Server environment** |
| prefix | `Arg: ` | **Launch argument** |
| prefix | `Using network server version:` | **Network server version** |
| prefix | `Microphone device changing to`, `Audio device changing to` | **Device change.** Recorded as an event, not a static setting, since people switch mid-session. Deduped against the last matching entry because VRChat re-logs the same mic on refresh. |
| prefix + scan | `[UserInfoLogger] Environment Info`, then `key: value` per continuation line | **Environment block.** Keys kept: VRChat Build, Unity Version, Platform, Store, Device Model, Processor Type, Graphics Device Name, System Memory Size, Operating System, XR Device. |

### Instance lifecycle

| Kind | Pattern | What it does |
|---|---|---|
| prefix | `Joining or Creating Room:` | **Pending world name.** Backfilled onto the open visit if it has none. |
| prefix | `Joining ` followed by `wrld_` or `local:` | **Instance join.** `local:error_...` is the offline Error World the client drops you into when a join fails — a real visit, often a very long one, so refusing it would report the whole session as "no instances visited". |
| prefix | `Entering Room:`, `Finished entering world` | **Instance ready** |
| prefix | `OnPlayerLeftRoom`, `OnDisconnected:` | **Instance leave**, with the disconnect reason kept |
| prefix | `OnPlayerJoined`, `OnPlayerJoinComplete` | **Player join** |
| prefix | `OnPlayerLeft ` | **Player leave**, paired against the open join |

### Travel and avatars

| Kind | Pattern | What it does |
|---|---|---|
| prefix | `Destination set:`, `Destination requested:`, `Destination fetching:` | **Travel destination**, parsed as an instance id |
| prefix | `[PortalManager]` | **Portal drop / destroy** |
| prefix | `Switching ` | **Avatar switch** — player and avatar both lifted |
| prefix | `Loading avatar for` | **Avatar load** |

### Media and downloads

| Kind | Pattern | What it does |
|---|---|---|
| prefix / scan | `Attempting`, `Starting download`, contains `resolved to`, or contains `ERROR` / `Error` / `failed` | **Interesting media line.** Everything else is queue noise and is dropped. |
| scan | `' resolved to '` | **Video URL resolution.** Split on the separator rather than hunting a quote pair: the separator consumes the source URL's closing quote, and pair-scanning here silently dropped every resolved video URL. |
| scan | first `{` in a `[VRCX]` body, parsed as JSON | **Video title.** Reads `videoName` and `displayName`; VRCX relays the world's video player state and is the only source of the actual title. |

Tag decides the kind: `Video Playback`/`AVProVideo`/`VVMW`→video,
`String Download`→string, `Image Download`→image, everything else→asset.

### API

| Kind | Pattern | What it does |
|---|---|---|
| scan | leading `[`…`]`, split on `,` | **Request fields** — request id, status, method, url |
| parse | field 1 as `u16` | **HTTP status.** Only the bracketed form carries one, and only it is a failure. |
| prefix | `Abandoning request`, `Request Finished with Error` | **Failure by wording.** Checked alongside the status so a malformed bracket cannot quietly demote a failure to ordinary traffic. |
| prefix | `Requesting `, `Sending `, `Piggy-backing ` | **API request** |
| prefix | `Attempted to authenticate` | **Auth call** |
| prefix / scan | `TryWriteConvert:`, `An error occurred filling the model`, contains `could not write` / `Could not write` | **Model-decode complaint.** The request succeeded and the client could not map part of the response — noisy, repetitive, and not a failed call, so it gets its own kind. |
| scan | ` - ` | **Failure reason**, taken from the tail |
| strip / split | drop `https://api.vrchat.cloud/api/1/`, cut at `?` or `#`, replace any path segment starting `usr_`, `wrld_`, `avtr_`, `grp_`, `file_`, `prop_`, `invt_`, `prod_` with `:id` | **Endpoint normalization.** `users/usr_a` and `users/usr_b` are one endpoint hit twice; keeping raw ids would produce a list of unique rows each with a count of 1. The untouched line stays in `detail`. |

### Notifications

| Kind | Pattern | What it does |
|---|---|---|
| prefix | `FriendUpdated:` | **Friend update** |
| prefix | `Received Notification:` | **Notification** |
| scan | `of type:`, `from username:`, `sender user id:` — each read to the next `,` | **Notification fields** |
| scan | `message: "` to the trailing `"` / `>` | **Notification message.** De-sanitized, because messages embed display names carrying the same lookalike-Unicode substitutions. |

### Spawns

| Kind | Pattern | What it does |
|---|---|---|
| prefix + scan | `User ` … ` spawned ` | **Sticker spawn** — `[StickersManager] User usr_x (Name) spawned sticker file_y`, id before name |
| prefix + scan | `Prop ` or `Item `, then ` spawned by ` | **Prop / item spawn.** Two spellings for one thing: newer clients log `[VRCItems] Item` where older ones logged `[VRCProps] Prop`, and a real archive spans the change. |
| prefix | content id starts `prop_` | **Kind from identifier.** Taken from the id rather than the client's wording, so the rename does not tally one feature under two names in the Spawns panel and the overview breakdown. |

### OSC

| Kind | Pattern | What it does |
|---|---|---|
| prefix + scan | `Advertising Service`, then ` of type OSC on ` and an all-digit tail | **OSC port.** The type must be matched exactly: the OSCQuery service is advertised first and on a *random* high port, so taking the last number on whichever line came first recorded the wrong port. |
| prefix + scan | `OSC::`, then the first 4–5 digit run | **OSC port fallback** |

Only the first port found is kept.

### Grouping

| Kind | Pattern | What it does |
|---|---|---|
| truncate | rich-text-stripped head, first 120 chars | **Problem signature.** Collapses repeated errors so one noisy subsystem does not drown out rarer, more interesting failures. Repeats dominate, so the hit path does a borrowed lookup and allocates nothing; only a first sighting builds owned strings. |
| tag | rich-text-stripped leading tag, or `untagged` | **Script group key** |

---

## 8. Instance identifiers — `crates/vrclog-core/src/instance.rs`

Shape: `wrld_<uuid>:<name>~<tag>(<value>)~...~region(<code>)`

Example: `wrld_0ae3..:EPAL4UZ~group(grp_0131..)~groupAccessType(public)~region(us)`

| Kind | Pattern | What it does |
|---|---|---|
| scan | first `:` | **World id / instance suffix split.** A bare `wrld_...` with no suffix is accepted; it happens on world-only log lines. |
| scan | up to the first `~` | **Instance name** — e.g. `EPAL4UZ` or `94836` |
| scan | `~`-separated segments, each `tag(value)` or a bare flag | **Tag split** |
| tag | `region(...)` | **Region** |
| tag | `hidden(...)` | **Friends+**, plus owner id |
| tag | `friends(...)` | **Friends**, plus owner id |
| tag | `private(...)` | **Invite**, plus owner id |
| tag | `group(...)` | **Group Public**, plus group id |
| tag | `groupAccessType(public\|plus\|members)` | **Group access override.** Applied after the loop, so tag order does not matter. |
| tag | `canRequestInvite` | **Invite → Invite+ upgrade.** Also applied after the loop, regardless of tag order. |
| tag | `ageGate` | **Age-gated flag** |
| — | no owner tag at all | **Public** — the default. `local:` is the offline Error World and has no access model, so it stays Unknown. |

---

## 9. The only real regexes in the project

None of these parse log content.

| Pattern | Location | What it does |
|---|---|---|
| `/^output_log_.*\.(txt\|log)$/i` | `web/logfiles.js` `VRCHAT_LOG` | **VRChat log filename.** The only files accepted in folder-sweep mode: the VRChat directory holds `config.txt`, `steam_appid.txt` and other unrelated text, and the user cannot see what a folder pick swept up. |
| `/\.(txt\|log)$/i` | `web/logfiles.js` `ANY_LOG` | **Any text-shaped file.** Used only when files were picked individually — a deliberate act, so a renamed or exported log is accepted. |
| `/\r?\n/` | `web/live.js` | **Line split for the live tail**, with the trailing partial line carried to the next chunk. |
| `/[&<>"']/g` | `web/app.js` | **HTML escaping** |
| `/^https:\/\/api\.vrchat\.cloud\/api\/1\//` | `web/app.js` | **Strip API base for display** |
| `/([A-Z])/g` | `web/app.js` | **camelCase to spaced label** for travel kinds |
