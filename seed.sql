-- =============================================================
-- Données de test — Trail Timing
-- Exécuter APRÈS schema.sql
-- =============================================================

-- Coureurs 5km (course_id = 1, dossards 1-30)
INSERT OR IGNORE INTO coureurs (dossard, course_id, nom, prenom, sexe, categorie, club) VALUES
  (1,  1, 'DUPONT',    'Jean',     'M', 'SE', 'Trail Club 34'),
  (2,  1, 'MARTIN',    'Sophie',   'F', 'V1', 'Les Pieds Agiles'),
  (3,  1, 'BERNARD',   'Pierre',   'M', 'V2', ''),
  (4,  1, 'LEROY',     'Marie',    'F', 'SE', 'Athlé Montpellier'),
  (5,  1, 'MOREAU',    'Thomas',   'M', 'JU', 'Trail Club 34'),
  (6,  1, 'PETIT',     'Isabelle', 'F', 'V2', ''),
  (7,  1, 'ROUX',      'Julien',   'M', 'SE', 'Run & Trail 66'),
  (8,  1, 'GARCIA',    'Camille',  'F', 'SE', 'Run & Trail 66'),
  (9,  1, 'LEFEBVRE',  'Nicolas',  'M', 'V1', ''),
  (10, 1, 'PERRIN',    'Aurélie',  'F', 'V1', 'Trail Club 34');

-- Coureurs 10km (course_id = 2, dossards 101-130)
INSERT OR IGNORE INTO coureurs (dossard, course_id, nom, prenom, sexe, categorie, club) VALUES
  (101, 2, 'SIMON',     'Alexis',   'M', 'SE', 'Trail Club 34'),
  (102, 2, 'LAURENT',   'Nathalie', 'F', 'V1', 'Les Gazelles'),
  (103, 2, 'MICHEL',    'François', 'M', 'V2', ''),
  (104, 2, 'HENRY',     'Laetitia', 'F', 'SE', 'Athlé Montpellier'),
  (105, 2, 'RICHARD',   'Maxime',   'M', 'ES', 'Trail Club 34'),
  (106, 2, 'GIRARD',    'Sylvie',   'F', 'V2', ''),
  (107, 2, 'THOMAS',    'Romain',   'M', 'SE', 'Run & Trail 66'),
  (108, 2, 'ROBERT',    'Claire',   'F', 'SE', 'Run & Trail 66'),
  (109, 2, 'FONTAINE',  'Éric',     'M', 'V3', ''),
  (110, 2, 'LEGRAND',   'Sandrine', 'F', 'V1', 'Trail Club 34');

-- Coureurs 18km (course_id = 3, dossards 201-230)
INSERT OR IGNORE INTO coureurs (dossard, course_id, nom, prenom, sexe, categorie, club) VALUES
  (201, 3, 'ROUSSEAU',  'Sébastien','M', 'SE', 'Trail Club 34'),
  (202, 3, 'PERROT',    'Émilie',   'F', 'SE', 'Les Gazelles'),
  (203, 3, 'CHEVALIER', 'Olivier',  'M', 'V1', ''),
  (204, 3, 'MERCIER',   'Véronique','F', 'V2', 'Athlé Montpellier'),
  (205, 3, 'DURAND',    'Antoine',  'M', 'SE', 'Trail Club 34'),
  (206, 3, 'MORIN',     'Céline',   'F', 'V1', ''),
  (207, 3, 'FAURE',     'Baptiste', 'M', 'JU', 'Run & Trail 66'),
  (208, 3, 'GARNIER',   'Lucie',    'F', 'SE', 'Run & Trail 66'),
  (209, 3, 'BONNET',    'Stéphane', 'M', 'V2', ''),
  (210, 3, 'VASSEUR',   'Patricia', 'F', 'V3', 'Trail Club 34');
