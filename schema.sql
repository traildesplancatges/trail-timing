-- =============================================================
-- Trail Timing - Schéma D1 (SQLite)
-- =============================================================

-- Table des courses (5km, 10km, 18km)
CREATE TABLE IF NOT EXISTS courses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nom         TEXT    NOT NULL,           -- ex: "5km", "10km", "18km"
  distance_km REAL    NOT NULL,
  annee       INTEGER NOT NULL DEFAULT 2026, -- édition (année)
  heure_depart TEXT   DEFAULT NULL,       -- ISO 8601 UTC, null = pas encore démarrée
  statut      TEXT    NOT NULL DEFAULT 'attente'
                      CHECK (statut IN ('attente', 'en_cours', 'terminee'))
);

-- Table des coureurs (import CSV avant la course)
CREATE TABLE IF NOT EXISTS coureurs (
  dossard     INTEGER NOT NULL,
  course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  nom         TEXT    NOT NULL,
  prenom      TEXT    NOT NULL,
  sexe        TEXT    NOT NULL CHECK (sexe IN ('M', 'F')),
  categorie   TEXT    NOT NULL DEFAULT '',  -- ex: SE, V1, V2, JU...
  club        TEXT    DEFAULT '',
  PRIMARY KEY (dossard, course_id)
);

-- Table des arrivées (cœur du système)
-- La contrainte UNIQUE garantit qu'un dossard ne peut arriver qu'une fois par course
-- → gestion automatique de la concurrence (INSERT échoue si doublon)
CREATE TABLE IF NOT EXISTS arrivees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dossard       INTEGER NOT NULL,
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  heure_arrivee TEXT    NOT NULL,           -- ISO 8601 UTC (enregistré côté serveur)
  ordre_arrivee INTEGER DEFAULT NULL,       -- calculé après coup si besoin
  saisie_par    TEXT    DEFAULT '',         -- identifiant du bénévole (optionnel)
  UNIQUE (dossard, course_id)               -- ← verrou anti-doublon
);

-- Index pour les classements (tri par heure d'arrivée)
CREATE INDEX IF NOT EXISTS idx_arrivees_course ON arrivees (course_id, heure_arrivee ASC);
CREATE INDEX IF NOT EXISTS idx_coureurs_course  ON coureurs (course_id);

-- =============================================================
-- Données initiales : les 3 courses
-- =============================================================
INSERT OR IGNORE INTO courses (id, nom, distance_km, annee) VALUES
  (1, '5km',  5.0,  2026),
  (2, '10km', 10.0, 2026),
  (3, '18km', 18.0, 2026);
