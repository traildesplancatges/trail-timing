-- =============================================================
-- Migration : Support des "slots" d'arrivée (temps capturé sans dossard)
-- =============================================================
-- 
-- Objectif : Permettre de capturer un temps d'arrivée AVANT de scanner
-- le dossard (cas des arrivées groupées / sprints).
--
-- Changements :
--   1. dossard devient nullable (NULL = slot en attente d'association)
--   2. La contrainte UNIQUE est modifiée pour ignorer les NULL
--      (SQLite : les NULL sont considérés distincts par défaut dans UNIQUE)
--   3. Ajout d'un index pour retrouver rapidement les slots en attente
--
-- Note : En SQLite, on ne peut pas modifier une contrainte existante.
--        Il faut recréer la table. Cette migration préserve les données.
-- =============================================================

-- 1. Renommer l'ancienne table
ALTER TABLE arrivees RENAME TO arrivees_old;

-- 2. Créer la nouvelle table avec dossard nullable
CREATE TABLE arrivees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dossard       INTEGER DEFAULT NULL,         -- NULL = slot en attente
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  heure_arrivee TEXT    NOT NULL,             -- ISO 8601 UTC
  ordre_arrivee INTEGER DEFAULT NULL,
  saisie_par    TEXT    DEFAULT ''
);

-- 3. Contrainte UNIQUE seulement quand dossard est non-null
-- En SQLite, UNIQUE sur une colonne nullable ignore les NULL (comportement standard)
-- Mais pour être explicite, on utilise un index unique partiel
CREATE UNIQUE INDEX idx_arrivees_dossard_course 
  ON arrivees (dossard, course_id) 
  WHERE dossard IS NOT NULL;

-- 4. Index pour les classements (tri par heure d'arrivée)
CREATE INDEX idx_arrivees_course ON arrivees (course_id, heure_arrivee ASC);

-- 5. Index pour retrouver les slots en attente (dossard NULL)
CREATE INDEX idx_arrivees_slots ON arrivees (course_id, heure_arrivee ASC) 
  WHERE dossard IS NULL;

-- 6. Migrer les données existantes
INSERT INTO arrivees (id, dossard, course_id, heure_arrivee, ordre_arrivee, saisie_par)
SELECT id, dossard, course_id, heure_arrivee, ordre_arrivee, saisie_par
FROM arrivees_old;

-- 7. Supprimer l'ancienne table
DROP TABLE arrivees_old;
