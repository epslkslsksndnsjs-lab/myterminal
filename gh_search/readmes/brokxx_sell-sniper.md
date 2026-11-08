# Sell Sniper

Bot qui surveille un compte spot Hyperliquid et vend un token (KNTQ, TREAD…)
dès qu'il arrive dessus (typiquement un airdrop), avec le moins de délai
possible entre la détection et l'envoi de l'ordre. Testé en réel : vente
remplie ~1,4 s après l'arrivée des fonds depuis la France.

## Installation en une commande

```bash
curl -fsSL https://raw.githubusercontent.com/brokxx/sell-sniper/master/lancer.sh | bash
```

Le script installe le bot dans `~/sell-sniper` (ou le met à jour), lance le
serveur et ouvre [http://127.0.0.1:8787](http://127.0.0.1:8787). Linux et
macOS ; sous Windows, passer par WSL ou suivre l'installation manuelle.

Avec Claude Code, un seul message suffit : « Installe et lance
https://github.com/brokxx/sell-sniper en suivant son README, puis guide-moi
dans l'interface ».

## Installation manuelle

Prérequis : Python 3.10 ou plus, une extension wallet dans le navigateur
(MetaMask ou Rabby) sur le compte qui recevra le token, et une dizaine d'USDC
sur ce compte pour l'ordre-test du démarrage (jamais dépensés).

```bash
git clone https://github.com/brokxx/sell-sniper.git
cd sell-sniper
pip install -r requirements.txt
cp config.example.json config.json
python3 serveur.py
```

Puis ouvrir [http://127.0.0.1:8787](http://127.0.0.1:8787) :

1. Saisir l'adresse du compte, cliquer sur « Connecter le wallet et approuver
   l'agent », signer une fois dans le wallet. Le bot obtient une clé d'agent
   qui peut trader mais jamais retirer ; la clé principale ne quitte pas le
   wallet.
2. Dans les réglages, choisir le token, la part à vendre en % et/ou un montant
   maximum en dollars, puis « Enregistrer ».
3. « Lancer en réel », confirmer, attendre l'anneau cyan « Armé ».

Le bot tourne sur la machine tant qu'elle reste allumée et connectée ; la page
peut être fermée. Tout se passe en local, rien n'est exposé sur internet.

Le bot combine trois sources de détection en parallèle (le flux WebSocket
`userNonFundingLedgerUpdates`, qui pousse chaque crédit dès son inclusion, le
flux WebSocket `webData2` et un polling REST de secours) pour ne rater aucune
arrivée même si l'une d'elles tombe, mais un verrou garantit qu'**un seul
ordre** est envoyé par arrivée de fonds, même si plusieurs sources la détectent
en même temps.

## 1. Créer un agent wallet

Le bot ne doit jamais détenir la clé privée du compte principal. Il utilise à
la place un *agent wallet*, une clé secondaire autorisée à trader pour le
compte du compte principal mais qui ne peut pas retirer de fonds.

### Depuis l'interface (recommandé)

1. Lancer le serveur :

   ```bash
   python3 serveur.py
   ```

2. Ouvrir [http://127.0.0.1:8787](http://127.0.0.1:8787). Tant qu'aucun agent
   n'est configuré, le panneau de l'agent s'ouvre de lui-même sous l'en-tête,
   avec un champ pour l'adresse du compte Hyperliquid et un bouton « Connecter
   le wallet et approuver l'agent ». Une fois l'agent en place, ce panneau se
   replie derrière la pastille en haut à droite (adresse courte et validité),
   qui l'ouvre ou le referme d'un clic.
3. Saisir l'adresse du compte principal (celui qui recevra l'airdrop) et
   cliquer sur le bouton. Quatre étapes s'enchaînent sous les yeux de
   l'utilisateur : connexion au wallet (extension navigateur type MetaMask ou
   Rabby), bascule sur la chaîne de signature, signature dans le wallet, puis
   soumission à Hyperliquid. Le wallet connecté doit être celui du compte
   saisi, sinon la page refuse l'approbation.
4. La clé de l'agent (nommé `KNTQ-SNIPER`) est générée sur la machine par le
   serveur : elle n'est jamais affichée ni transmise au navigateur. Une fois
   qu'Hyperliquid a accepté l'approbation, `.env` est écrit automatiquement,
   en lecture réservée à l'utilisateur.
5. Le panneau (derrière la pastille) affiche alors l'adresse de l'agent, le
   compte associé et sa validité. Un bouton « Remplacer l'agent » permet d'en créer un nouveau ;
   Hyperliquid remplace en général un agent portant le même nom, si l'ancien
   reste listé il ne sert plus au bot.

Changer d'agent exige que le bot soit arrêté : le serveur refuse tant qu'il
tourne, car le bot ne relit `.env` qu'à son démarrage.

### Manuellement

Pour qui préfère ne pas passer par l'interface :

1. Aller sur [app.hyperliquid.xyz/API](https://app.hyperliquid.xyz/API) connecté
   avec le compte qui recevra l'airdrop.
2. Générer un agent wallet (« Generate API Wallet » ou équivalent selon la
   version de l'interface).
3. Noter la clé privée de l'agent (`KNTQ_AGENT_KEY`) et l'adresse du compte
   principal (`KNTQ_MASTER_ADDRESS`), celle qui reçoit réellement l'airdrop.
4. Autoriser l'agent depuis l'interface (signature sur le compte principal).
5. Remplir `.env` à la main avec ces deux valeurs.

## 2. Configuration

```bash
cp .env.example .env
cp config.example.json config.json
```

Éditer `.env` avec la clé de l'agent, l'adresse du compte principal, et
éventuellement un bot et un chat Telegram pour les notifications.

Éditer `config.json` selon les besoins (voir la section « Champs de
configuration » plus bas).

**Aucun de ces deux fichiers ne doit être commité** : ils sont dans
`.gitignore`, seuls `.env.example` et `config.example.json` sont versionnés.

## 3. Lancement

### Simulation (dry run, recommandé pour valider la configuration)

```bash
python3 sniper.py
```

En dry run, le bot détecte, calcule la vente, journalise et notifie, mais
n'envoie aucun ordre à l'échange. **Attention : il ne fait pas tout comme en
réel.** L'ordre-test de signature du préflight est sauté en dry run, donc une
simulation réussie ne prouve pas que la chaîne de signature fonctionne. Seul un
lancement `--live` valide ce point.

### Réel

```bash
python3 sniper.py --live
```

Avant de s'armer, le bot exécute un préflight qui vérifie que l'agent est bien
enregistré et valide sur le compte principal, que le carnet d'ordres de la
paire est accessible, et (si `preflight_order_test` est activé) que la chaîne
de signature fonctionne en passant puis en annulant un ordre-test non
exécutable. **Si le préflight échoue, le bot affiche l'erreur et s'arrête
immédiatement (code de sortie 1) : il ne se lance jamais dans un état
incertain.**

En réel, le préflight exige également qu'il reste environ **11 USDC libres**
sur le compte spot (10 USDC pour l'ordre-test de signature, avec une petite
marge), faute de quoi il refuse de démarrer.

## 4. Interface de supervision

Une interface web locale permet de lancer, arrêter, régler et surveiller le
bot pendant l'attente de l'airdrop, sans passer par le terminal.

```bash
python3 serveur.py
```

Ouvrir ensuite `http://127.0.0.1:8787`.

Le bot est lancé **détaché** du serveur : fermer le navigateur ou arrêter
`serveur.py` ne coupe jamais la surveillance en cours. Relancer le serveur
retrouve le bot déjà en route et reprend l'affichage de son état, sans le
redémarrer.

### États du bot

| État | Signification |
|---|---|
| `ARRETE` | Arrêt demandé depuis l'interface, ou bot jamais lancé. |
| `DEMARRAGE` | Le préflight est en cours. |
| `ARME` | Préflight réussi, le bot est en veille, prêt à vendre dès l'arrivée des fonds. |
| `VENTE` | Une vente est en train de se déclencher. |
| `MORT` | Le bot a disparu sans qu'on le lui ait demandé, typiquement un préflight refusé. |

Quand l'état passe à `MORT`, le panneau du bas bascule automatiquement sur la
sortie du bot, où se trouve la cause exacte de l'arrêt (par exemple une
variable manquante dans `.env`, ou un préflight refusé faute de solde
suffisant).

Pendant l'attente, l'indicateur à surveiller est **l'âge de la dernière
observation** : c'est lui qui dit si le bot est toujours vivant et à jour. Un
âge qui reste bas (quelques secondes) est normal ; s'il se met à grimper,
quelque chose ne va pas et mérite d'être regardé, même si l'état affiché est
encore `ARME`.

**Tout changement de configuration exige un redémarrage du bot**, donc un
nouveau préflight avec son ordre-test de 10 USDC. Il n'y a délibérément aucun
réglage à chaud : modifier `config.json` ou `.env` pendant que le bot tourne
n'a aucun effet tant qu'il n'a pas été arrêté puis relancé depuis l'interface.

L'interface n'écoute que sur `127.0.0.1`, sans mot de passe, et c'est un choix
délibéré : ce panneau peut lancer des ordres réels sur une machine qui détient
la clé de l'agent, il n'a rien à faire d'accessible depuis le réseau.

## 5. Champs de configuration (`config.json`)

| Champ | Signification |
|---|---|
| `pair` | Paire spot à trader, ex. `"KNTQ/USDC"`. |
| `sell_mode` | `"pct"` pour vendre un pourcentage du solde détecté, `"usd"` pour vendre un montant fixe en USD. |
| `sell_pct` | Fraction **de chaque tranche détectée** à vendre en mode `"pct"` (`1.0` = tout). S'applique tranche par tranche, pas au cumul. |
| `sell_usd` | Montant en USD à vendre **par tranche détectée** en mode `"usd"`, ou plafond en dollars de la part vendue en mode `"pct"` (`null` = pas de plafond). Trois tranches avec `5000` vendent 15 000 dollars au total, pas 5 000. |
| `max_slippage` | **Fabrique le prix limite**, ce n'est pas un seuil de refus : `prix limite = meilleur bid × (1 − max_slippage)`. Une valeur de `0.3` autorise donc une vente 30 % sous le marché. Garder une valeur faible (`0.03` par défaut) et utiliser `floor_price` pour poser une vraie limite basse. |
| `floor_price` | Prix plancher en dessous duquel le bot n'envoie pas d'ordre (`null` pour aucun plancher). Voir la note ci-dessous sur la reprise automatique. |
| `min_notional_usd` | Notionnel minimum d'un ordre, évalué au prix limite. Il ne concerne pas que le résidu : **il bloque aussi la vente initiale**. Réglé à `500`, un airdrop valant 300 dollars ne sera jamais vendu. |
| `poll_interval_ms` | Intervalle entre deux interrogations REST du solde (filet de sécurité si le WebSocket est silencieux). Strictement positif, 100 ms par défaut ; en dessous, la limite de débit d'Hyperliquid (environ 10 lectures par seconde) devient un risque. |
| `ws_watchdog_s` | Délai sans message WebSocket avant de forcer une reconnexion. Strictement positif. |
| `residual_retries` | Nombre **total** de tentatives d'envoi d'ordre pour une tranche, **l'ordre initial compris**. Minimum `1` : à `1` le bot envoie un seul ordre et n'insiste pas sur le résidu. |
| `residual_delay_ms` | Délai entre deux tentatives sur un résidu. |
| `retry_delay_ms` | Temporisation avant de rejouer une vente refusée pour une raison temporaire (prix sous le plancher, carnet vide). Strictement positif, `5000` par défaut. |
| `post_sale_quarantine_ms` | Durée pendant laquelle, juste après une vente ayant rempli, le bot ignore les observations de solde, le temps que les lectures parties avant la vente s'écoulent. Sans cette fenêtre, une lecture périmée ferait vendre une seconde fois. `2000` par défaut ; une nouvelle tranche arrivant pendant ce délai est simplement retardée, jamais perdue. |
| `preflight_order_test` | Si `true`, le préflight place puis annule un ordre-test réel pour valider la signature avant de démarrer en réel. |
| `dry_run` | Si `true`, aucun ordre n'est réellement envoyé (simulation). Ignoré dès qu'un drapeau de mode est donné : `--live` le force à `false`, `--dry-run` le force à `true`. L'interface de supervision ne lance qu'en réel (`--live`) ; la simulation se lance en ligne de commande avec `python3 sniper.py --dry-run`. |
| `telegram_enabled` | Active l'envoi de notifications Telegram (nécessite `TELEGRAM_BOT_TOKEN` et `TELEGRAM_CHAT_ID` dans `.env`). |

### La reprise automatique

Certains refus dépendent du prix et peuvent donc se lever tout seuls. Dans ces
cas, le bot n'envoie aucun ordre **mais ne considère pas la tranche comme
traitée** : il rejoue la tentative toutes les `retry_delay_ms` et vend dès que
la condition redevient favorable. Trois refus sont rejoués :

- **le prix est sous le plancher** (`floor_price`) ;
- **le notionnel est temporairement insuffisant** : `taille × prix limite` est
  sous `min_notional_usd`, ce qui arrive quand le carnet est bas et que le
  minimum est réglé haut. Un carnet qui remonte suffit à débloquer la vente ;
- **le carnet d'achat est momentanément vide**, donc sans meilleur bid
  exploitable.

Les autres refus (delta nul ou négatif, taille nulle une fois arrondie) sont
définitifs : aucune évolution de prix ne les résoudra, le delta est donc
simplement intégré à la nouvelle référence.

Le journal `logs/events.jsonl` trace chaque tentative (`reprise_programmee`) ;
la notification Telegram, elle, n'est envoyée qu'une fois par épisode, pour ne
pas inonder le fil.

## 6. Limites connues

- **Reliquat non écoulé.** Si le carnet d'ordres n'absorbe pas toute la
  quantité visée après les trois tentatives (`residual_retries`), le reliquat
  non vendu reste tel quel sur le compte : le bot ne s'acharne pas dessus par
  de nouvelles tentatives automatiques, il devient simplement partie de la
  nouvelle référence. C'est un choix délibéré, pour éviter qu'un carnet vide
  ou trop fin ne fasse boucler le bot indéfiniment. La notification Telegram
  et le journal (`logs/events.jsonl`) signalent explicitement ce reliquat ;
  c'est à l'utilisateur de décider s'il veut agir à la main dessus.
- **Échec réseau pendant l'envoi de l'ordre.** Si un ordre est parti mais que
  sa réponse ne revient pas (timeout, socket coupée), le bot ne rejoue pas la
  tranche : un ordre a pu être exécuté côté plateforme sans que le bot le
  sache, et le rejouer vendrait deux fois. Seuls les refus survenus **avant**
  tout envoi d'ordre (plancher, carnet vide) sont rejoués automatiquement. Un
  échec réseau apparaît dans le journal et dans la notification Telegram : il
  demande une vérification manuelle du solde.
- **L'interface ne remplace pas la surveillance, elle l'affiche.** Si la
  machine se met en veille, le bot s'arrête avec elle, que l'interface soit
  ouverte ou non : voir l'avertissement ci-dessous.

## 7. Avertissement important

**La machine qui fait tourner ce bot ne doit ni se mettre en veille ni perdre
sa connexion réseau** pendant toute la période où l'airdrop est attendu. Une
mise en veille ou une coupure réseau, même brève, suffit à faire manquer la
fenêtre de détection et donc à rater la vente instantanée qui est la seule
raison d'être de ce bot. Sur un ordinateur portable, désactiver la mise en
veille automatique (secteur branché) et privilégier une connexion filaire ou,
mieux, une petite VM dans le cloud restée allumée en continu.
