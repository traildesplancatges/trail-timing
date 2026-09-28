-- Migration : ajout de la colonne annee sur la table courses
-- A executer UNE SEULE FOIS sur la base remote existante
-- Commande : npx wrangler d1 execute trail-timing-db --remote --file=migration_add_annee.sql

ALTER TABLE courses ADD COLUMN annee INTEGER NOT NULL DEFAULT 2026;
