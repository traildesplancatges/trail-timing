# 🏔 Trail Timing

Système de chronométrage pour le **Trail des Plancatges** — 350 coureurs, 3 courses (5km / 10km / 18km).

Basé sur **Cloudflare Workers + D1** (SQLite serverless). Entièrement gratuit sur le plan Free de Cloudflare.

---

## Fonctionnalités

| Interface | URL | Usage |
|---|---|---|
| Portail d'accueil | `/` | Liens vers toutes les interfaces |
| Classement public | `/classement.html` | Affichage temps réel (rafraîchissement 15s) |
| Interface bénévole | `/benevole.html` | Saisie dossard + scan QR code |
| Administration | `/admin.html` | Gestion complète |

### Interface bénévole
- Saisie numérique grande taille (optimisée mobile)
- Scan QR code via caméra (lib jsQR, pas d'installation)
- Détection automatique des **doublons** (même dossard = alerte orange)
- Historique des 20 dernières arrivées
- Vibration mobile au scan et à la validation
- Token partagé simple (pas de compte individuel)

### Interface admin
- Dashboard avec progression en temps réel
- Démarrage / clôture des courses (heure en direct ou heure décalée)
- Import coureurs par **CSV drag & drop**
- Ajout / suppression de coureurs manuellement
- Correction des arrivées (suppression, ajout avec heure forcée)
- Export CSV du classement complet
- Générateur de **QR codes imprimables** par plage de dossards

### Gestion de la concurrence
La contrainte `UNIQUE (dossard, course_id)` sur la table `arrivees` garantit qu'un même dossard
ne peut être enregistré qu'une seule fois par course, même si deux bénévoles le saisissent simultanément.
Le second appel reçoit un `409 Conflict` avec l'heure déjà enregistrée.

---

## Prérequis

- Un compte [Cloudflare](https://dash.cloudflare.com) (gratuit)
- Node.js ≥ 18
- `npm` ≥ 9

---

## Déploiement — étape par étape

### 1. Installer les dépendances

```bash
cd trail-timing
npm install
```

### 2. Se connecter à Cloudflare

```bash
npx wrangler login
```

Un navigateur s'ouvre pour l'authentification. Une seule fois.

### 3. Créer la base de données D1

```bash
npx wrangler d1 create trail-timing-db
```

La commande affiche un bloc comme celui-ci :

```
✅ Successfully created DB 'trail-timing-db'

[[d1_databases]]
binding = "DB"
database_name = "trail-timing-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"   ← COPIEZ cet ID
```

Ouvrez `wrangler.json` et remplacez `REMPLACER_PAR_VOTRE_DATABASE_ID` par cet ID :

```json
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "trail-timing-db",
    "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
]
```

### 4. Initialiser le schéma (tables + 3 courses)

```bash
# En production (remote) :
npm run db:init:remote

# En développement local :
npm run db:init
```

### 5. Configurer les secrets

Ne jamais mettre les secrets dans `wrangler.json`. Utilisez la commande `secret` :

```bash
npx wrangler secret put ADMIN_PASSWORD
# → saisir le mot de passe admin (ex: MonTrail2024!)

npx wrangler secret put JWT_SECRET
# → saisir une chaîne aléatoire longue (ex: générez avec : openssl rand -hex 32)

npx wrangler secret put BENEVOLAT_TOKEN
# → saisir le code que vous donnerez aux bénévoles (ex: benevole2024)
```

> **Astuce** : Pour le développement local, ces valeurs sont déjà dans `.dev.vars`.
> Ce fichier est dans `.gitignore` et ne sera jamais commité.

### 6. Déployer

```bash
npm run deploy
```

L'URL de déploiement s'affiche à la fin :
```
✅ Deployed trail-timing to https://trail-timing.<votre-sous-domaine>.workers.dev
```

---

## Développement local

```bash
npm run dev
```

Ouvre un serveur local sur `http://localhost:8787` avec hot-reload.
La base de données locale est dans `.wrangler/state/`.

---

## Utilisation le jour J

### Avant la course (J-1 ou matin)

1. **Importer les coureurs** pour chaque course via `admin.html` → onglet "Coureurs" → "Import CSV"

   Format du CSV :
   ```
   dossard,nom,prenom,sexe,categorie,club
   101,DUPONT,Jean,M,SE,Trail Club 34
   102,MARTIN,Sophie,F,V1,Les Pieds Agiles
   ```

2. **Générer et imprimer les QR codes** via `admin.html` → onglet "Export" → "Générer les QR codes"
   - Entrez la plage de dossards (ex: de 1 à 120 pour le 5km)
   - Cliquez "Générer" → page imprimable s'ouvre → Ctrl+P
   - Découpez et collez un QR code sur chaque dossard

3. **Distribuer aux bénévoles** :
   - L'URL de l'interface bénévole : `https://trail-timing.xxx.workers.dev/benevole.html`
   - Le code d'accès bénévole (votre `BENEVOLAT_TOKEN`)

### Pendant la course

1. **Démarrer la course** : `admin.html` → onglet "Courses" → bouton "▶ Démarrer"
   - Si le départ est donné à une heure fixe (ex: 9h00), utilisez "Démarrage avec heure décalée"

2. Les **bénévoles à l'arrivée** saisissent les dossards sur leur téléphone :
   - Scan du QR code du dossard → validation automatique
   - Ou saisie manuelle du numéro → touche Entrée ou bouton Valider
   - Feedback immédiat : ✅ succès | ⚠️ doublon avec l'heure déjà enregistrée

3. Le **classement public** se rafraîchit toutes les 15 secondes :
   - À projeter sur un écran ou partager via QR code de l'URL

4. **Corrections** : `admin.html` → onglet "Arrivées" → choisir la course → bouton 🗑 pour supprimer

### Après la course

1. **Clôturer la course** : `admin.html` → onglet "Courses" → "⏹ Clôturer"

2. **Exporter le classement** : `admin.html` → onglet "Export" → "⬇ CSV"

---

## Architecture technique

```
trail-timing/
├── src/
│   ├── worker.ts          ← API Cloudflare Worker (TypeScript)
│   ├── d1.d.ts            ← Déclarations types D1
│   └── public/
│       ├── index.html     ← Portail d'accueil
│       ├── benevole.html  ← Interface bénévole (mobile-first)
│       ├── classement.html← Classement public temps réel
│       └── admin.html     ← Administration complète
├── schema.sql             ← Schéma base de données D1
├── wrangler.json          ← Config Cloudflare (sans secrets)
├── .dev.vars              ← Secrets locaux (gitignored)
├── tsconfig.json
└── package.json
```

### API endpoints

| Méthode | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/courses` | — | Liste des courses + nb arrivées |
| GET | `/api/classement/:id` | — | Classement complet d'une course |
| POST | `/api/arrivee` | Token bénévole | Enregistrer une arrivée |
| GET | `/api/arrivee/:courseId/:dossard` | — | Vérifier si dossard enregistré |
| POST | `/api/admin/login` | — | Obtenir un JWT admin |
| POST | `/api/admin/course/:id/start` | JWT admin | Démarrer une course |
| POST | `/api/admin/course/:id/stop` | JWT admin | Clôturer une course |
| POST | `/api/admin/course/:id/reset` | JWT admin | Remettre à zéro |
| POST | `/api/admin/coureurs/import` | JWT admin | Import CSV coureurs |
| GET | `/api/admin/coureurs/:courseId` | JWT admin | Liste des coureurs |
| DELETE | `/api/admin/arrivee/:id` | JWT admin | Supprimer une arrivée |
| POST | `/api/admin/arrivee-manuelle` | JWT admin | Saisie admin avec heure libre |
| GET | `/api/admin/export/:courseId` | JWT admin | Export CSV classement |
| GET | `/api/admin/stats` | JWT admin | Statistiques globales |

### Gestion concurrence (détail technique)

```sql
-- Contrainte UNIQUE garantit l'unicité au niveau base de données
CREATE TABLE arrivees (
  ...
  UNIQUE (dossard, course_id)   -- ← un seul INSERT gagne, les autres → 409
);
```

Le Worker intercepte l'erreur SQLite `UNIQUE constraint failed` et retourne :
```json
{
  "error": "Dossard déjà enregistré",
  "dossard": 42,
  "heure_arrivee": "2024-09-15T09:23:41.000Z",
  "saisie_par": "Marie"
}
```

---

## Coût

Tout tient dans le **plan gratuit Cloudflare** :

| Ressource | Limite gratuite | Usage estimé |
|---|---|---|
| Worker requests | 100 000/jour | ~5 000 pour 350 coureurs |
| D1 reads | 5 millions/jour | ~50 000 pour 350 coureurs |
| D1 writes | 100 000/jour | ~350 (une par arrivée) |
| D1 storage | 5 GB | < 1 MB |

**Coût total : 0 €**

---

## Dépannage

### "Course non démarrée" à la saisie d'une arrivée
→ Vérifiez que la course est en statut "🟢 En cours" dans l'admin. Cliquez "▶ Démarrer".

### "Code d'accès invalide" sur l'interface bénévole
→ Vérifiez que le token saisi correspond exactement à `BENEVOLAT_TOKEN` (sensible à la casse).

### La base de données est vide après déploiement
→ Vous n'avez pas exécuté `npm run db:init:remote`. Cette commande est indispensable pour créer les tables.

### Erreur "database_id" dans wrangler.json
→ Remplacez `REMPLACER_PAR_VOTRE_DATABASE_ID` par l'ID obtenu lors du `wrangler d1 create`.

### Les QR codes ne se lisent pas
→ Assurez-vous que les dossards sont imprimés au minimum en **2,5 cm × 2,5 cm**. En dessous, la lecture est aléatoire.
