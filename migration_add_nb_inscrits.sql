-- Migration : ajout de la colonne nb_inscrits sur la table courses
-- Valeur manuelle optionnelle — NULL = calculé dynamiquement depuis la table coureurs
-- Commande : npx wrangler d1 execute trail-timing-db --remote --file=migration_add_nb_inscrits.sql

ALTER TABLE courses ADD COLUMN nb_inscrits INTEGER DEFAULT NULL;
