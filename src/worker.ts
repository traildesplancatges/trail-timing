/**
 * Trail Timing — Cloudflare Worker
 *
 * Endpoints publics :
 *   GET  /api/courses                          → liste des courses + statut
 *   GET  /api/classement/:courseId             → classement complet d'une course
 *
 * Endpoints bénévoles (token requis) :
 *   POST /api/arrivee                          → enregistre une arrivée
 *   GET  /api/arrivee/:courseId/:dossard       → vérifie si un dossard est déjà enregistré
 *
 * Endpoints admin (mot de passe requis) :
 *   POST /api/admin/login                      → obtenir un token JWT
 *   POST /api/admin/course/:id/start           → démarre une course (enregistre heure_depart)
 *   POST /api/admin/course/:id/stop            → clôture une course
 *   POST /api/admin/coureurs/import            → import CSV des coureurs
 *   GET  /api/admin/coureurs/:courseId         → liste des coureurs d'une course
 *   DELETE /api/admin/arrivee/:id              → supprime une arrivée (correction)
 *   GET  /api/admin/export/:courseId           → export CSV du classement
 *   GET  /api/admin/stats                      → statistiques globales
 *
 * Sécurité concurrence :
 *   La table arrivees a une contrainte UNIQUE (dossard, course_id).
 *   Un INSERT concurrent échoue avec SQLITE_CONSTRAINT → réponse 409 Conflict.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Env {
  DB: D1Database;
  ADMIN_PASSWORD: string;
  JWT_SECRET: string;
  BENEVOLAT_TOKEN: string; // token partagé pour les bénévoles
  ASSETS: { fetch(request: Request): Promise<Response> };
}

interface Course {
  id: number;
  nom: string;
  distance_km: number;
  heure_depart: string | null;
  statut: 'attente' | 'en_cours' | 'terminee';
}

interface LigneClassement {
  position: number;
  dossard: number;
  nom: string;
  prenom: string;
  sexe: string;
  categorie: string;
  club: string;
  heure_arrivee: string;
  temps_brut: string;   // "HH:MM:SS"
  temps_sec: number;    // secondes depuis le départ
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────

function cors(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...extra,
  };
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(), ...headers },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** Formate un nombre de secondes en HH:MM:SS */
function formatTemps(secondes: number): string {
  if (secondes < 0) return '--:--:--';
  const h = Math.floor(secondes / 3600);
  const m = Math.floor((secondes % 3600) / 60);
  const s = secondes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── JWT minimal ─────────────────────────────────────────────────────────────

async function signToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const payloadB64 = btoa(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${payloadB64}.${sigB64}`;
}

async function verifyToken(
  token: string,
  secret: string,
): Promise<{ valid: boolean; payload?: Record<string, unknown> }> {
  try {
    const [payloadB64, sigB64] = token.split('.');
    if (!payloadB64 || !sigB64) return { valid: false };
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    const sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(payloadB64));
    if (!ok) return { valid: false };
    const payload = JSON.parse(atob(payloadB64)) as Record<string, unknown>;
    if (typeof payload.exp === 'number' && payload.exp < Date.now()) return { valid: false };
    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}

function bearerToken(request: Request): string | null {
  const h = request.headers.get('Authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

// ─── Middlewares auth ─────────────────────────────────────────────────────────

async function requireAdmin(request: Request, env: Env): Promise<boolean> {
  const token = bearerToken(request);
  if (!token) return false;
  const { valid, payload } = await verifyToken(token, env.JWT_SECRET);
  return valid && payload?.role === 'admin';
}

function requireBenevole(request: Request, env: Env): boolean {
  const token = bearerToken(request);
  // Le token bénévole est un simple secret partagé (pas de JWT)
  return token === env.BENEVOLAT_TOKEN;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

// GET /api/courses
async function getCourses(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.nom, c.distance_km, c.heure_depart, c.statut,
            COUNT(a.id) AS nb_arrives
     FROM courses c
     LEFT JOIN arrivees a ON a.course_id = c.id
     GROUP BY c.id
     ORDER BY c.id`,
  ).all<Course & { nb_arrives: number }>();
  return json(results);
}

// GET /api/classement/:courseId
async function getClassement(courseId: number, env: Env): Promise<Response> {
  const course = await env.DB.prepare(
    'SELECT * FROM courses WHERE id = ?',
  ).bind(courseId).first<Course>();

  if (!course) return err('Course introuvable', 404);
  if (!course.heure_depart) return json({ course, classement: [], message: 'Course pas encore démarrée' });

  const { results } = await env.DB.prepare(
    `SELECT
       ROW_NUMBER() OVER (ORDER BY a.heure_arrivee ASC) AS position,
       a.id AS id_arrivee,
       a.dossard,
       COALESCE(c.nom,    'Inconnu')   AS nom,
       COALESCE(c.prenom, '')          AS prenom,
       COALESCE(c.sexe,   '?')         AS sexe,
       COALESCE(c.categorie, '')       AS categorie,
       COALESCE(c.club, '')            AS club,
       a.heure_arrivee,
       a.saisie_par
     FROM arrivees a
     LEFT JOIN coureurs c ON c.dossard = a.dossard AND c.course_id = a.course_id
     WHERE a.course_id = ?
     ORDER BY a.heure_arrivee ASC`,
  ).bind(courseId).all<Omit<LigneClassement, 'temps_brut' | 'temps_sec'>>();

  const depart = new Date(course.heure_depart).getTime();
  const classement: LigneClassement[] = results.map((r) => {
    const temps_sec = Math.round((new Date(r.heure_arrivee).getTime() - depart) / 1000);
    return { ...r, temps_sec, temps_brut: formatTemps(temps_sec) };
  });

  return json({ course, classement });
}

// POST /api/arrivee  body: { dossard, course_id, benevole_id? }
async function postArrivee(request: Request, env: Env): Promise<Response> {
  if (!requireBenevole(request, env)) return err('Non autorisé', 401);

  let body: { dossard?: unknown; course_id?: unknown; benevole_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return err('Corps JSON invalide');
  }

  const dossard = Number(body.dossard);
  const courseId = Number(body.course_id);
  const benevoleId = String(body.benevole_id ?? '').slice(0, 50);

  if (!Number.isInteger(dossard) || dossard < 1) return err('Numéro de dossard invalide');
  if (!Number.isInteger(courseId) || courseId < 1) return err('course_id invalide');

  // Vérifier que la course est en cours
  const course = await env.DB.prepare(
    "SELECT * FROM courses WHERE id = ? AND statut = 'en_cours'",
  ).bind(courseId).first<Course>();

  if (!course) return err('Course non démarrée ou introuvable', 422);

  const heureArrivee = new Date().toISOString();

  try {
    await env.DB.prepare(
      `INSERT INTO arrivees (dossard, course_id, heure_arrivee, saisie_par)
       VALUES (?, ?, ?, ?)`,
    ).bind(dossard, courseId, heureArrivee, benevoleId).run();
  } catch (e: unknown) {
    // Contrainte UNIQUE violée → dossard déjà enregistré
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('unique')) {
      const existing = await env.DB.prepare(
        'SELECT heure_arrivee, saisie_par FROM arrivees WHERE dossard = ? AND course_id = ?',
      ).bind(dossard, courseId).first<{ heure_arrivee: string; saisie_par: string }>();
      return json(
        {
          error: 'Dossard déjà enregistré',
          dossard,
          heure_arrivee: existing?.heure_arrivee,
          saisie_par: existing?.saisie_par,
        },
        409,
      );
    }
    return err(`Erreur base de données : ${msg}`, 500);
  }

  // Récupérer la position obtenue
  const position = await env.DB.prepare(
    `SELECT COUNT(*) AS pos FROM arrivees
     WHERE course_id = ? AND heure_arrivee <= ?`,
  ).bind(courseId, heureArrivee).first<{ pos: number }>();

  const coureur = await env.DB.prepare(
    'SELECT nom, prenom FROM coureurs WHERE dossard = ? AND course_id = ?',
  ).bind(dossard, courseId).first<{ nom: string; prenom: string }>();

  const depart = new Date(course.heure_depart!).getTime();
  const temps_sec = Math.round((new Date(heureArrivee).getTime() - depart) / 1000);

  return json({
    success: true,
    dossard,
    position: position?.pos ?? '?',
    heure_arrivee: heureArrivee,
    temps_brut: formatTemps(temps_sec),
    coureur: coureur ?? null,
  }, 201);
}

// GET /api/arrivee/:courseId/:dossard — vérifie si dossard déjà enregistré
async function checkArrivee(courseId: number, dossard: number, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT * FROM arrivees WHERE course_id = ? AND dossard = ?',
  ).bind(courseId, dossard).first();
  return json({ enregistre: !!row, arrivee: row ?? null });
}

// POST /api/admin/login  body: { password }
async function adminLogin(request: Request, env: Env): Promise<Response> {
  let body: { password?: unknown };
  try { body = await request.json(); } catch { return err('JSON invalide'); }

  if (!body.password || body.password !== env.ADMIN_PASSWORD) {
    return err('Mot de passe incorrect', 401);
  }
  const token = await signToken(
    { role: 'admin', exp: Date.now() + 8 * 60 * 60 * 1000 },
    env.JWT_SECRET,
  );
  return json({ token });
}

// POST /api/admin/course/:id/start
async function startCourse(courseId: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);

  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first<Course>();
  if (!course) return err('Course introuvable', 404);
  if (course.statut !== 'attente') return err(`La course est déjà en statut "${course.statut}"`, 409);

  // Permettre une heure de départ personnalisée (utile pour départ groupé décalé)
  let heureDepart: string;
  try {
    const body = await request.json() as { heure_depart?: string };
    heureDepart = body.heure_depart ? new Date(body.heure_depart).toISOString() : new Date().toISOString();
  } catch {
    heureDepart = new Date().toISOString();
  }

  await env.DB.prepare(
    "UPDATE courses SET statut = 'en_cours', heure_depart = ? WHERE id = ?",
  ).bind(heureDepart, courseId).run();

  return json({ success: true, course_id: courseId, heure_depart: heureDepart });
}

// POST /api/admin/course/:id/stop
async function stopCourse(courseId: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);

  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first<Course>();
  if (!course) return err('Course introuvable', 404);
  if (course.statut !== 'en_cours') return err('Course non en cours', 409);

  await env.DB.prepare(
    "UPDATE courses SET statut = 'terminee' WHERE id = ?",
  ).bind(courseId).run();

  return json({ success: true, course_id: courseId });
}

// POST /api/admin/course/:id/reset  (remet en "attente" et efface les arrivées — utile en test)
async function resetCourse(courseId: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);

  await env.DB.prepare('DELETE FROM arrivees WHERE course_id = ?').bind(courseId).run();
  await env.DB.prepare(
    "UPDATE courses SET statut = 'attente', heure_depart = NULL WHERE id = ?",
  ).bind(courseId).run();

  return json({ success: true });
}

// POST /api/admin/coureurs/import  body: { course_id, coureurs: [...] }
// Accepte aussi du texte CSV (Content-Type: text/csv)
async function importCoureurs(request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);

  const contentType = request.headers.get('Content-Type') ?? '';
  let courseId: number;
  let lignes: Array<{ dossard: number; nom: string; prenom: string; sexe: string; categorie: string; club: string }>;

  if (contentType.includes('application/json')) {
    let body: { course_id?: unknown; coureurs?: unknown };
    try { body = await request.json(); } catch { return err('JSON invalide'); }
    courseId = Number(body.course_id);
    if (!Array.isArray(body.coureurs)) return err('coureurs doit être un tableau');
    lignes = body.coureurs.map((c: Record<string, unknown>) => ({
      dossard: Number(c.dossard),
      nom: String(c.nom ?? '').trim().toUpperCase(),
      prenom: String(c.prenom ?? '').trim(),
      sexe: String(c.sexe ?? 'M').toUpperCase().charAt(0),
      categorie: String(c.categorie ?? '').trim().toUpperCase(),
      club: String(c.club ?? '').trim(),
    }));
  } else {
    // CSV : dossard,nom,prenom,sexe,categorie,club  (première ligne = header)
    const url = new URL(request.url);
    courseId = Number(url.searchParams.get('course_id'));
    const text = await request.text();
    const rows = text.trim().split('\n').slice(1); // skip header
    lignes = rows.map((row) => {
      const [dossard, nom, prenom, sexe, categorie, club] = row.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
      return {
        dossard: Number(dossard),
        nom: (nom ?? '').toUpperCase(),
        prenom: prenom ?? '',
        sexe: (sexe ?? 'M').toUpperCase().charAt(0),
        categorie: (categorie ?? '').toUpperCase(),
        club: club ?? '',
      };
    });
  }

  if (!Number.isInteger(courseId) || courseId < 1) return err('course_id invalide');

  const course = await env.DB.prepare('SELECT id FROM courses WHERE id = ?').bind(courseId).first();
  if (!course) return err('Course introuvable', 404);

  // Upsert en batch
  let ok = 0, ko = 0;
  for (const c of lignes) {
    if (!c.dossard || !c.nom) { ko++; continue; }
    try {
      await env.DB.prepare(
        `INSERT INTO coureurs (dossard, course_id, nom, prenom, sexe, categorie, club)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (dossard, course_id) DO UPDATE SET
           nom=excluded.nom, prenom=excluded.prenom, sexe=excluded.sexe,
           categorie=excluded.categorie, club=excluded.club`,
      ).bind(c.dossard, courseId, c.nom, c.prenom, c.sexe, c.categorie, c.club).run();
      ok++;
    } catch { ko++; }
  }

  return json({ success: true, importes: ok, erreurs: ko });
}

// GET /api/admin/coureurs/:courseId
async function getCoureurs(courseId: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  const { results } = await env.DB.prepare(
    'SELECT * FROM coureurs WHERE course_id = ? ORDER BY dossard',
  ).bind(courseId).all();
  return json(results);
}

// DELETE /api/admin/arrivee/:id
async function deleteArrivee(arriveeId: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  const row = await env.DB.prepare('SELECT * FROM arrivees WHERE id = ?').bind(arriveeId).first();
  if (!row) return err('Arrivée introuvable', 404);
  await env.DB.prepare('DELETE FROM arrivees WHERE id = ?').bind(arriveeId).run();
  return json({ success: true, deleted: row });
}

// GET /api/admin/export/:courseId  → CSV
async function exportClassement(courseId: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);

  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first<Course>();
  if (!course) return err('Course introuvable', 404);

  const { results } = await env.DB.prepare(
    `SELECT
       ROW_NUMBER() OVER (ORDER BY a.heure_arrivee ASC) AS position,
       a.dossard,
       COALESCE(c.nom,    'INCONNU') AS nom,
       COALESCE(c.prenom, '')        AS prenom,
       COALESCE(c.sexe,   '?')       AS sexe,
       COALESCE(c.categorie, '')     AS categorie,
       COALESCE(c.club, '')          AS club,
       a.heure_arrivee,
       a.saisie_par
     FROM arrivees a
     LEFT JOIN coureurs c ON c.dossard = a.dossard AND c.course_id = a.course_id
     WHERE a.course_id = ?
     ORDER BY a.heure_arrivee ASC`,
  ).bind(courseId).all<Record<string, unknown>>();

  const depart = course.heure_depart ? new Date(course.heure_depart).getTime() : 0;
  const headers = ['Position', 'Dossard', 'Nom', 'Prénom', 'Sexe', 'Catégorie', 'Club', 'Temps', 'Heure arrivée', 'Saisi par'];
  const rows = results.map((r) => {
    const ts = depart > 0 ? Math.round((new Date(r.heure_arrivee as string).getTime() - depart) / 1000) : 0;
    return [
      r.position, r.dossard, r.nom, r.prenom, r.sexe, r.categorie, r.club,
      formatTemps(ts), r.heure_arrivee, r.saisie_par,
    ].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
  });

  const csv = [headers.join(','), ...rows].join('\n');
  const filename = `classement_${course.nom}_${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csv, {
    headers: {
      ...cors(),
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

// GET /api/admin/stats
async function getStats(request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);

  const { results } = await env.DB.prepare(
    `SELECT
       c.id, c.nom, c.statut, c.heure_depart,
       COUNT(DISTINCT cr.dossard) AS nb_inscrits,
       COUNT(DISTINCT a.dossard)  AS nb_arrives
     FROM courses c
     LEFT JOIN coureurs cr ON cr.course_id = c.id
     LEFT JOIN arrivees a  ON a.course_id  = c.id
     GROUP BY c.id`,
  ).all();
  return json(results);
}

// POST /api/admin/arrivee-manuelle  body: { dossard, course_id, heure_forcee?, benevole_id? }
async function arriveeManuelle(request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);

  let body: { dossard?: unknown; course_id?: unknown; heure_forcee?: unknown; benevole_id?: unknown };
  try { body = await request.json(); } catch { return err('JSON invalide'); }

  const dossard  = Number(body.dossard);
  const courseId = Number(body.course_id);
  const benevoleId = 'admin';

  if (!Number.isInteger(dossard) || dossard < 1) return err('Dossard invalide');
  if (!Number.isInteger(courseId) || courseId < 1) return err('course_id invalide');

  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first<Course>();
  if (!course) return err('Course introuvable', 404);

  // Heure forcée ou maintenant
  let heureArrivee: string;
  if (body.heure_forcee && typeof body.heure_forcee === 'string') {
    try { heureArrivee = new Date(body.heure_forcee).toISOString(); } catch { return err('heure_forcee invalide'); }
  } else {
    heureArrivee = new Date().toISOString();
  }

  try {
    await env.DB.prepare(
      `INSERT INTO arrivees (dossard, course_id, heure_arrivee, saisie_par)
       VALUES (?, ?, ?, ?)`,
    ).bind(dossard, courseId, heureArrivee, benevoleId).run();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('unique')) {
      return err(`Dossard ${dossard} déjà enregistré`, 409);
    }
    return err(`Erreur DB : ${msg}`, 500);
  }

  const depart = course.heure_depart ? new Date(course.heure_depart).getTime() : 0;
  const temps_sec = depart > 0 ? Math.round((new Date(heureArrivee).getTime() - depart) / 1000) : 0;

  return json({ success: true, dossard, heure_arrivee: heureArrivee, temps_brut: formatTemps(temps_sec) }, 201);
}

// POST /api/admin/course  body: { nom, distance_km }
async function createCourse(request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  let body: { nom?: unknown; distance_km?: unknown };
  try { body = await request.json(); } catch { return err('JSON invalide'); }
  const nom = String(body.nom ?? '').trim();
  const dist = Number(body.distance_km);
  if (!nom)          return err('nom requis');
  if (isNaN(dist) || dist <= 0) return err('distance_km invalide');
  const result = await env.DB.prepare(
    'INSERT INTO courses (nom, distance_km) VALUES (?, ?)',
  ).bind(nom, dist).run();
  return json({ success: true, id: (result.meta as Record<string, unknown>).last_row_id }, 201);
}

// PUT /api/admin/course/:id  body: { nom?, distance_km? }
async function updateCourse(courseId: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first<Course>();
  if (!course) return err('Course introuvable', 404);
  let body: { nom?: unknown; distance_km?: unknown };
  try { body = await request.json(); } catch { return err('JSON invalide'); }
  const nom  = body.nom  !== undefined ? String(body.nom).trim()  : course.nom;
  const dist = body.distance_km !== undefined ? Number(body.distance_km) : course.distance_km;
  if (!nom)              return err('nom requis');
  if (isNaN(dist) || dist <= 0) return err('distance_km invalide');
  await env.DB.prepare(
    'UPDATE courses SET nom = ?, distance_km = ? WHERE id = ?',
  ).bind(nom, dist, courseId).run();
  return json({ success: true });
}

// DELETE /api/admin/course/:id
async function deleteCourse(courseId: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first<Course>();
  if (!course) return err('Course introuvable', 404);
  if (course.statut === 'en_cours') return err('Impossible de supprimer une course en cours', 409);
  // La contrainte ON DELETE CASCADE supprime coureurs et arrivées liés
  await env.DB.prepare('DELETE FROM courses WHERE id = ?').bind(courseId).run();
  return json({ success: true });
}

// PUT /api/admin/coureur/:courseId/:dossard  body: { nom?, prenom?, sexe?, categorie?, club? }
async function updateCoureur(courseId: number, dossard: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  const coureur = await env.DB.prepare(
    'SELECT * FROM coureurs WHERE course_id = ? AND dossard = ?',
  ).bind(courseId, dossard).first<{ nom: string; prenom: string; sexe: string; categorie: string; club: string }>();
  if (!coureur) return err('Coureur introuvable', 404);
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return err('JSON invalide'); }
  const nom       = body.nom       !== undefined ? String(body.nom).trim().toUpperCase()  : coureur.nom;
  const prenom    = body.prenom    !== undefined ? String(body.prenom).trim()             : coureur.prenom;
  const sexe      = body.sexe      !== undefined ? String(body.sexe).toUpperCase().charAt(0) : coureur.sexe;
  const categorie = body.categorie !== undefined ? String(body.categorie).trim().toUpperCase() : coureur.categorie;
  const club      = body.club      !== undefined ? String(body.club).trim()               : coureur.club;
  if (!nom || !prenom) return err('nom et prenom requis');
  await env.DB.prepare(
    `UPDATE coureurs SET nom=?, prenom=?, sexe=?, categorie=?, club=?
     WHERE course_id=? AND dossard=?`,
  ).bind(nom, prenom, sexe, categorie, club, courseId, dossard).run();
  return json({ success: true });
}

// DELETE /api/admin/coureur/:courseId/:dossard
async function deleteCoureur(courseId: number, dossard: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  const coureur = await env.DB.prepare(
    'SELECT * FROM coureurs WHERE course_id = ? AND dossard = ?',
  ).bind(courseId, dossard).first();
  if (!coureur) return err('Coureur introuvable', 404);
  await env.DB.prepare(
    'DELETE FROM coureurs WHERE course_id = ? AND dossard = ?',
  ).bind(courseId, dossard).run();
  return json({ success: true });
}

// ─── Router principal ─────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }

    // ── Routes API ──────────────────────────────────────────────────────────

    if (path === '/api/courses' && method === 'GET') {
      return getCourses(env);
    }

    const classementMatch = path.match(/^\/api\/classement\/(\d+)$/);
    if (classementMatch && method === 'GET') {
      return getClassement(Number(classementMatch[1]), env);
    }

    if (path === '/api/arrivee' && method === 'POST') {
      return postArrivee(request, env);
    }

    const checkArriveeMatch = path.match(/^\/api\/arrivee\/(\d+)\/(\d+)$/);
    if (checkArriveeMatch && method === 'GET') {
      return checkArrivee(Number(checkArriveeMatch[1]), Number(checkArriveeMatch[2]), env);
    }

    // Admin
    if (path === '/api/admin/login' && method === 'POST') {
      return adminLogin(request, env);
    }

    const startMatch = path.match(/^\/api\/admin\/course\/(\d+)\/start$/);
    if (startMatch && method === 'POST') {
      return startCourse(Number(startMatch[1]), request, env);
    }

    const stopMatch = path.match(/^\/api\/admin\/course\/(\d+)\/stop$/);
    if (stopMatch && method === 'POST') {
      return stopCourse(Number(stopMatch[1]), request, env);
    }

    const resetMatch = path.match(/^\/api\/admin\/course\/(\d+)\/reset$/);
    if (resetMatch && method === 'POST') {
      return resetCourse(Number(resetMatch[1]), request, env);
    }

    if (path === '/api/admin/coureurs/import' && method === 'POST') {
      return importCoureurs(request, env);
    }

    const courseursMatch = path.match(/^\/api\/admin\/coureurs\/(\d+)$/);
    if (courseursMatch && method === 'GET') {
      return getCoureurs(Number(courseursMatch[1]), request, env);
    }

    const deleteArriveeMatch = path.match(/^\/api\/admin\/arrivee\/(\d+)$/);
    if (deleteArriveeMatch && method === 'DELETE') {
      return deleteArrivee(Number(deleteArriveeMatch[1]), request, env);
    }

    const exportMatch = path.match(/^\/api\/admin\/export\/(\d+)$/);
    if (exportMatch && method === 'GET') {
      return exportClassement(Number(exportMatch[1]), request, env);
    }

    if (path === '/api/admin/stats' && method === 'GET') {
      return getStats(request, env);
    }

    // POST /api/admin/arrivee-manuelle  — saisie admin avec heure libre
    if (path === '/api/admin/arrivee-manuelle' && method === 'POST') {
      return arriveeManuelle(request, env);
    }

    // Course CRUD
    if (path === '/api/admin/course' && method === 'POST') {
      return createCourse(request, env);
    }
    const updateCourseMatch = path.match(/^\/api\/admin\/course\/(\d+)$/);
    if (updateCourseMatch && method === 'PUT') {
      return updateCourse(Number(updateCourseMatch[1]), request, env);
    }
    if (updateCourseMatch && method === 'DELETE') {
      return deleteCourse(Number(updateCourseMatch[1]), request, env);
    }

    // Coureur CRUD
    const coureurMatch = path.match(/^\/api\/admin\/coureur\/(\d+)\/(\d+)$/);
    if (coureurMatch && method === 'PUT') {
      return updateCoureur(Number(coureurMatch[1]), Number(coureurMatch[2]), request, env);
    }
    if (coureurMatch && method === 'DELETE') {
      return deleteCoureur(Number(coureurMatch[1]), Number(coureurMatch[2]), request, env);
    }

    // ── Assets statiques ────────────────────────────────────────────────────
    if (path.startsWith('/api/')) {
      return err('Endpoint inconnu', 404);
    }

    return env.ASSETS.fetch(request);
  },
};
