# Codex Desktop Sync Investigation (PocketDex)

Date: 2026-02-07  
Workspace: `/Users/valence/PocketDex`

## Implementation status (latest)

A production implementation of live desktop sync is now integrated in:

- `/Users/valence/PocketDex/server/src/desktopLiveSync.ts`
- `/Users/valence/PocketDex/server/src/index.ts`

Documentation for runtime behavior and tuning is in:

- `/Users/valence/PocketDex/docs/codex_desktop_live_sync.md`

## Goal

Trouver une stratégie de synchronisation temps réel entre PocketDex et Codex Desktop sans relancer l'app, tout en gardant:

- apparition immédiate des nouveaux messages
- remontée automatique du thread
- point bleu non lu
- conversation toujours éditable dans Codex Desktop

## Reverse engineering summary

### Binary and bundle inspected

- App: `/Applications/Codex.app`
- Bundle payload: `/Applications/Codex.app/Contents/Resources/app.asar`
- Webview runtime (minifié): `/tmp/codex-asar-20260207/webview/assets/index-3Lu2GYf3.js`

### IPC transport identified

- Socket IPC local:
  - `/var/folders/.../T/codex-ipc/ipc-501.sock`
- Frame format:
  - `uint32 little-endian length` + `json payload`
- Handshake:
  - request `initialize` obligatoire

### Broadcast versions confirmed

- `thread-stream-state-changed` => version `4`
- `thread-archived` => version `1`
- `thread-unarchived` => version `0` (default path)

Codex Desktop ignore le broadcast si la version ne match pas (confirmé via logs).

## Internal behavior discovered in Codex Desktop

## 1) `thread-stream-state-changed` forces follower mode

Dans le store local de conversation:

- réception d'un `snapshot` via `thread-stream-state-changed`:
  - met le thread en `streamRoles[threadId] = { role: "follower", ownerClientId: ... }`
- en `follower`, le composer est désactivé

Symptôme UI:

- message tooltip:
  - `To continue, return to the window where this conversation started.`
- erreur interne correspondante:
  - `Please continue this conversation on the window where it was started.`

Conclusion:

- Injecter des snapshots est efficace pour “forcer” la refresh visuelle,
- mais casse la reprise normale de conversation côté desktop.

## 2) Pourquoi les messages user “disparaissent”

Le rendu des tours se base sur `turn.params.input` pour reconstruire les `user-message`.

Chemin trouvé:

- reconstruction dans `tht(...)`:
  - prend `a.items[0]` si `type==="userMessage"`
  - et remplit `params.input` avec ce contenu

Problème observé pendant les tests:

- certains snapshots synthétiques avaient des `turn.params.input: []`
- résultat:
  - backend OK (les `userMessage` existent dans les items)
  - UI desktop n'affiche plus correctement les messages user

## 3) Unread / point bleu

Le point bleu est lié à l'état conversation local `hasUnreadTurn` + cycle des turns.

Important:

- Ce n'est pas juste “un flag SQL unique” côté PocketDex.
- C'est dérivé/maintenu par la logique conversation + événements turn dans Desktop.

## 4) Reorder (remontée en haut)

La liste récente utilise `updatedAt` + refresh récents.

`thread-unarchived` peut servir de “nudge” de refresh (sans forcer follower), mais ne remplace pas un cycle turn natif complet.

## Why the “perfect test” worked but was unsafe

La séquence qui avait donné:

- spinner visible
- point bleu
- thread remonté

utilisait:

- snapshot in-progress
- snapshot completed (`hasUnreadTurn=true`)
- `thread-unarchived`

=> visuellement très bon, mais techniquement risqué car `follower` + risque de corruption d'affichage user.

## Safe strategy going forward (recommended)

Ne plus utiliser `thread-stream-state-changed` depuis PocketDex.

Utiliser uniquement des chemins “natifs”:

1. envoyer les messages via app-server (turn lifecycle réel)
2. optionnel: `thread-unarchived` comme léger nudge de liste
3. jamais pousser de snapshot synthétique dans Desktop

Expected outcome:

- spinner et completion pilotés par le vrai cycle turn
- unread/point bleu gérés par la logique standard Desktop
- pas de passage forcé en `follower`
- composer reste utilisable dans Codex Desktop

## Key test artifacts

- Thread de validation principal:
  - `019c3925-a07e-7733-a930-4497433146b3` (`Corrige scroll auto iOS`)
- Thread demandé ensuite:
  - `019c38eb-e36c-7bc0-9f79-700ba5812d4e` (`Ajouter réorganisation projets`)

## Important safety rules

- Do not broadcast `thread-stream-state-changed` from companion.
- Do not synthesize partial turns with empty `params.input`.
- Avoid title/source rewriting in injected states.
- If a UI nudge is needed, prefer `thread-unarchived` only.

## Current status

Investigation confirms:

- Real-time sync is possible,
- but snapshot injection is the root cause of:
  - follower lock
  - hidden user messages
  - occasional spinner/thread inconsistencies.

Recommended production path is native turn flow + minimal nudge events.

## Advanced workaround tested: snapshot + immediate ownership reclaim

Une variante a ete testee pour garder l'effet visuel live sans laisser le thread en follower:

1. `thread-unarchived`
2. `thread-stream-state-changed` (snapshot inProgress)
3. `thread-stream-claim-ownership` immediat
4. envoi du vrai message backend
5. `thread-stream-state-changed` (snapshot completed + `hasUnreadTurn=true`)
6. `thread-stream-claim-ownership` immediat
7. `thread-unarchived`

Observation backend sur `019c38eb-e36c-7bc0-9f79-700ba5812d4e`:

- nouveau turn cree et complete
- `userMessage` et `agentMessage` presents
- pas de perte de message user

Pourquoi ca peut aider:

- `thread-stream-state-changed` donne le refresh visuel immediat
- `thread-stream-claim-ownership` retire l'etat follower juste apres

Limite:

- c'est encore un contournement IPC (pas un flux officiel documente)
- validation UI finale indispensable (spinner, point bleu, absence de lock composer)

## New blocker observed during latest tests (2026-02-07)

Sur les threads de test, les turns envoyes via PocketDex peuvent finir en:

- `turn/started`
- `item/started` + `item/completed` pour `userMessage`
- event `error` avec message quota:
  - `You've hit your usage limit ...`
- `turn/completed` avec status `failed`

Impact direct:

- turn visible avec `userMessage` seul (pas de `agentMessage`)
- pas de spinner de reponse long ni point bleu "nouvelle reponse agent" attendu
- faux negatif possible pendant l'investigation sync (on peut croire que la sync est cassee alors que le run modele echoue)

Conclusion pratique:

- tant que le quota est bloque, les tests "spinner + unread bleu en fin de reponse agent" ne sont pas fiables
- les tests de trigger IPC/resync restent valides, mais seulement pour la partie rafraichissement de liste/snapshot

## New findings (2026-02-07, late session)

### A) Mismatch de version critique entre PocketDex et Desktop

Constat runtime:

- PocketDex lance `codex` via PATH:
  - `/opt/homebrew/bin/codex`
  - version `0.98.0`
- Codex Desktop utilise son binaire embarque:
  - `/Applications/Codex.app/Contents/Resources/codex`
  - version `0.99.0-alpha.5`

Preuve:

- `which codex` + `codex --version` + `/Applications/Codex.app/Contents/Resources/codex --version`

Impact:

- Les turns ecrits par PocketDex portent `cliVersion: 0.98.0` dans les rollouts.
- Le Desktop lit ces rollouts, mais ne les transforme pas en stream UI live (spinner/point bleu) sans son propre cycle local.
- Ce mismatch augmente le risque de comportements divergents (etat, parsing, events attendus).

### B) Chemin live UI confirme: uniquement cycle local turn/item

Dans le webview desktop (`/tmp/codex-asar-20260207/webview/assets/index-3Lu2GYf3.js`):

- Les effets visuels live (spinner, unread) proviennent de notifications:
  - `turn/started`
  - `item/started`
  - `item/completed`
  - `turn/completed` (set `hasUnreadTurn=true`)

Sans ces notifications traitees localement, l'UI n'affiche pas le cycle live complet.

### C) Limite IPC externe actuelle: impossible d'invoquer le flux overlay/startTurn

Dans le main desktop (`/tmp/codex-asar-20260207/.vite/build/main-B6C8fi5S.js`):

- Les broadcasts externes sont encapsules vers le renderer en `type: "ipc-broadcast"`.
- Cote renderer, `ipc-broadcast` ne traite effectivement que:
  - `thread-archived`
  - `thread-unarchived`
  (invalidation liste/tasks).
- Les actions utiles (`thread-overlay-proxy-start-turn-request`, `thread-stream-claim-ownership`) sont des messages window internes, pas des `ipc-broadcast`.

Test probe confirme:

- requete IPC externe `thread-overlay-proxy-start-turn-request` => `no-client-found`.

Conclusion:

- on ne peut pas declencher proprement `startTurn(...allowOverlayDirect)` depuis companion via IPC public actuel.

### D) Le binaire Desktop supporte websocket app-server (piste architecture)

Le code main contient un transport websocket configurable:

- `CODEX_APP_SERVER_WS_URL`
- `hostConfig.websocket_url`
- fallback CLI local sinon.

Interpretation:

- Une architecture "app-server partage" (Desktop + companion sur meme backend websocket) est probablement la voie la plus propre pour recuperer spinner/point bleu natifs sans snapshots followers.
- Ce n'est pas active dans la configuration actuelle.

### E) Test direct avec binaire Desktop 0.99 depuis companion

Test realise:

- message envoye via `/Applications/Codex.app/Contents/Resources/codex app-server` (0.99)
- notifications riches observees dans ce process:
  - `turn/started`, `item/started`, `item/agentMessage/delta`, `turn/completed`

Mais:

- aucun nouveau broadcast desktop utile detecte cote socket IPC public (hors snapshots emis lors connexion probe).

Conclusion:

- le vrai probleme est l'absence de canal partage live entre process companion et process Desktop UI,
- plus que la simple capacite de generer des turns.

## Patch applique (PocketDex) - alignement de version Codex

Date: 2026-02-07

Fichier:

- `/Users/valence/PocketDex/server/src/appServerBridge.ts`

Changement:

- Resolution du binaire app-server:
  1. `process.env.CODEX_BIN` si defini
  2. sinon `/Applications/Codex.app/Contents/Resources/codex` si present
  3. sinon fallback `codex` (PATH)

Validation locale:

- Build TypeScript serveur OK (`npm run build`)
- Log runtime observe:
  - `[AppServerBridge] starting codex app-server with binary: /Applications/Codex.app/Contents/Resources/codex`

## New findings (2026-02-07, latest) - "Pourquoi on ne reproduit pas exactement le flow natif"

### 1) Le flow natif spinner/point bleu n'utilise pas `ipc-broadcast`

Dans le webview (`/tmp/codex-asar-20260207/webview/assets/index-3Lu2GYf3.js`):

- le rendu live vient du traitement des notifications de turn/item:
  - `turn/started`
  - `item/started`
  - `item/completed`
  - `turn/completed`
- ce cycle passe par le store conversation interne (pas par simple invalidation de liste).

### 2) `thread-stream-state-changed` force follower (snapshot ET patches)

Toujours dans le webview, methode `handleThreadStreamStateChanged(...)`:

- `change.type === "snapshot"`:
  - applique l'etat
  - puis `streamRoles.set(..., { role: "follower", ownerClientId: sourceClientId })`
- `change.type === "patches"`:
  - met aussi `role: "follower"` avant application des patches

Implication:

- toute strategie basee sur `thread-stream-state-changed` casse potentiellement la reprise d'ecriture dans le thread.

### 3) Le `ipc-broadcast` externe est limite cote renderer

Dans le switch principal de messages renderer:

- `case "ipc-broadcast"` n'est exploite que pour invalider `tasks` sur:
  - `thread-archived`
  - `thread-unarchived`

Il ne reenclenche pas le cycle complet turn/item natif.

### 4) Cote main process, le client IPC "desktop" ne traite pas de requests applicatives

Dans le main (`/tmp/codex-asar-20260207/.vite/build/main-B6C8fi5S.js`):

- le router IPC route les `request` vers un client capable via discovery.
- le client desktop (`new d9("desktop", ...)`) enregistre `addAnyBroadcastHandler(...)` mais pas de `addRequestHandler(...)` applicatif.
- consequence pratique observee:
  - requests sans target => `no-client-found`
  - requests ciblees sur `sourceClientId` desktop => timeout (requete routee mais sans reponse)

### 5) Tests runtime confirms

Tests probe sur socket IPC:

- `thread-stream-snapshot-request`, `thread-overlay-proxy-start-turn-request`, `ipc-request`, `ide-context`, etc. => `no-client-found`
- requests ciblees vers `sourceClientId` desktop (`1593de6c-...`) => `timeout`

Conclusion:

- on ne peut pas, via le canal IPC public actuel, reproduire exactement le flux natif "spinner + unread + reorder + thread editable" sans effets de bord.
- le chemin exact reste interne a la connexion app-server locale de l'app Desktop vers son renderer.

## Follower unlock - methode practicale sans restart app (testee en laboratoire)

Objectif:

- sortir un thread de l'etat follower sans relancer Codex Desktop.

Constat code:

- `handleThreadStreamStateChanged` met `streamRoles[threadId] = follower`.
- `handleThreadArchived` appelle `removeConversationFromCache(threadId)` qui supprime aussi `streamRoles`.
- `upsertConversationFromThread` appelle `markConversationStreaming(threadId)` qui remet `role: owner` si le role follower n'existe plus.

Sequence recommandee:

1. (optionnel) reproduire follower avec un `thread-stream-state-changed` minimal (`change.type = "patches", patches = []`) pour eviter un snapshot destructif.
2. envoyer `thread-archived` (version 1) sur le thread.
3. envoyer `thread-unarchived` (version 0) sur le thread.
4. laisser le desktop rehydrater la conversation (`refreshRecentConversations`) puis verifier que le composer est de nouveau actif.

Test pratique execute:

- thread test: `019c39a5-2b46-7580-9017-efb3279926b6` (`probe unlock follower test`)
- sequence envoyee:
  - follower no-op patches
  - `thread-archived`
  - `thread-unarchived`

Notes de securite:

- ne pas utiliser de snapshot synthétique vide pour forcer follower (risque de masquer des messages user en UI).
- la methode agit sur le cache/etat live de l'app, pas sur les données source des rollouts.
