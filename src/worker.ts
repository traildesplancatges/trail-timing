/**
 * Trail Timing — Cloudflare Worker
 *
 * Endpoints publics :
 *   GET  /api/annees                           → liste des années disponibles
 *   GET  /api/courses?annee=2026               → liste des courses (filtre optionnel par année)
 *   GET  /api/classement/:courseId             → classement complet d'une course
 *
 * Endpoints bénévoles (token requis) :
 *   POST /api/arrivee                          → enregistre une arrivée
 *   GET  /api/arrivee/:courseId/:dossard       → vérifie si un dossard est déjà enregistré
 *
 * Endpoints admin (mot de passe requis) :
 *   POST /api/admin/login                      → obtenir un token JWT
 *   POST /api/admin/course/:id/start           → démarre une course
 *   POST /api/admin/course/:id/stop            → clôture une course
 *   POST /api/admin/course/:id/reset           → remet en attente
 *   POST /api/admin/coureurs/import            → import CSV des coureurs
 *   GET  /api/admin/coureurs/:courseId         → liste des coureurs d'une course
 *   DELETE /api/admin/arrivee/:id              → supprime une arrivée (correction)
 *   POST /api/admin/arrivee-manuelle           → saisie admin avec heure libre
 *   GET  /api/admin/export/:courseId           → export CSV du classement
 *   GET  /api/admin/stats                      → statistiques globales
 *   POST /api/admin/course                     → créer une course
 *   PUT  /api/admin/course/:id                 → modifier une course
 *   DELETE /api/admin/course/:id               → supprimer une course
 *   PUT  /api/admin/coureur/:courseId/:dossard → modifier un coureur
 *   DELETE /api/admin/coureur/:courseId/:dossard → supprimer un coureur
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Env {
  DB: D1Database;
  ADMIN_PASSWORD: string;
  JWT_SECRET: string;
  BENEVOLAT_TOKEN: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

interface Course {
  id: number;
  nom: string;
  distance_km: number;
  annee: number;
  heure_depart: string | null;
  statut: 'attente' | 'en_cours' | 'terminee';
}

interface LigneClassement {
  position: number;
  id_arrivee: number;
  dossard: number;
  nom: string;
  prenom: string;
  sexe: string;
  categorie: string;
  club: string;
  heure_arrivee: string;
  saisie_par: string;
  temps_brut: string;
  temps_sec: number;
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
  return token === env.BENEVOLAT_TOKEN;
}

// ─── Handlers publics ────────────────────────────────────────────────────────

// GET /api/annees → liste des années disponibles (tri décroissant)
// ?terminee=1 → seulement les années avec au moins une course terminée
async function getAnnees(url: URL, env: Env): Promise<Response> {
  const termineeOnly = url.searchParams.get('terminee') === '1';
  const query = termineeOnly
    ? "SELECT DISTINCT annee FROM courses WHERE statut = 'terminee' ORDER BY annee DESC"
    : 'SELECT DISTINCT annee FROM courses ORDER BY annee DESC';
  const { results } = await env.DB.prepare(query).all<{ annee: number }>();
  return json(results.map(r => r.annee));
}

// GET /api/courses?annee=2026 → liste des courses, avec filtre annee optionnel
async function getCourses(url: URL, env: Env): Promise<Response> {
  const anneeParam = url.searchParams.get('annee');
  const annee = anneeParam ? Number(anneeParam) : null;

  let query: string;
  let stmt: D1PreparedStatement;

  if (annee && Number.isInteger(annee)) {
    query = `SELECT c.id, c.nom, c.distance_km, c.annee, c.heure_depart, c.statut,
                    COUNT(a.id) AS nb_arrives
             FROM courses c
             LEFT JOIN arrivees a ON a.course_id = c.id
             WHERE c.annee = ?
             GROUP BY c.id
             ORDER BY c.distance_km ASC`;
    stmt = env.DB.prepare(query).bind(annee);
  } else {
    query = `SELECT c.id, c.nom, c.distance_km, c.annee, c.heure_depart, c.statut,
                    COUNT(a.id) AS nb_arrives
             FROM courses c
             LEFT JOIN arrivees a ON a.course_id = c.id
             GROUP BY c.id
             ORDER BY c.annee DESC, c.distance_km ASC`;
    stmt = env.DB.prepare(query);
  }

  const { results } = await stmt.all<Course & { nb_arrives: number }>();
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
    const vitesse_moy = temps_sec > 0
      ? (course.distance_km / (temps_sec / 3600)).toFixed(2) + ' km/h'
      : '—';
    return { ...r, temps_sec, temps_brut: formatTemps(temps_sec), vitesse_moy };
  });

  return json({ course, classement });
}

// ─── Handlers bénévoles ───────────────────────────────────────────────────────

// POST /api/arrivee
async function postArrivee(request: Request, env: Env): Promise<Response> {
  if (!requireBenevole(request, env)) return err('Non autorisé', 401);

  let body: { dossard?: unknown; course_id?: unknown; benevole_id?: unknown };
  try { body = await request.json(); } catch { return err('Corps JSON invalide'); }

  const dossard   = Number(body.dossard);
  const courseId  = Number(body.course_id);
  const benevoleId = String(body.benevole_id ?? '').slice(0, 50);

  if (!Number.isInteger(dossard) || dossard < 1)  return err('Numéro de dossard invalide');
  if (!Number.isInteger(courseId) || courseId < 1) return err('course_id invalide');

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
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('unique')) {
      const existing = await env.DB.prepare(
        'SELECT heure_arrivee, saisie_par FROM arrivees WHERE dossard = ? AND course_id = ?',
      ).bind(dossard, courseId).first<{ heure_arrivee: string; saisie_par: string }>();
      return json({ error: 'Dossard déjà enregistré', dossard,
                    heure_arrivee: existing?.heure_arrivee, saisie_par: existing?.saisie_par }, 409);
    }
    return err(`Erreur base de données : ${msg}`, 500);
  }

  const position = await env.DB.prepare(
    'SELECT COUNT(*) AS pos FROM arrivees WHERE course_id = ? AND heure_arrivee <= ?',
  ).bind(courseId, heureArrivee).first<{ pos: number }>();

  const coureur = await env.DB.prepare(
    'SELECT nom, prenom FROM coureurs WHERE dossard = ? AND course_id = ?',
  ).bind(dossard, courseId).first<{ nom: string; prenom: string }>();

  const depart = new Date(course.heure_depart!).getTime();
  const temps_sec = Math.round((new Date(heureArrivee).getTime() - depart) / 1000);

  return json({
    success: true, dossard, position: position?.pos ?? '?',
    heure_arrivee: heureArrivee, temps_brut: formatTemps(temps_sec), coureur: coureur ?? null,
  }, 201);
}

// GET /api/arrivee/:courseId/:dossard
async function checkArrivee(courseId: number, dossard: number, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT * FROM arrivees WHERE course_id = ? AND dossard = ?',
  ).bind(courseId, dossard).first();
  return json({ enregistre: !!row, arrivee: row ?? null });
}

// ─── Handlers admin ───────────────────────────────────────────────────────────

// POST /api/admin/login
async function adminLogin(request: Request, env: Env): Promise<Response> {
  let body: { password?: unknown };
  try { body = await request.json(); } catch { return err('JSON invalide'); }
  if (!body.password || body.password !== env.ADMIN_PASSWORD) return err('Mot de passe incorrect', 401);
  const token = await signToken({ role: 'admin', exp: Date.now() + 8 * 60 * 60 * 1000 }, env.JWT_SECRET);
  return json({ token });
}

// POST /api/admin/course/:id/start
async function startCourse(courseId: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first<Course>();
  if (!course) return err('Course introuvable', 404);
  if (course.statut !== 'attente') return err(`La course est déjà en statut "${course.statut}"`, 409);
  let heureDepart: string;
  try {
    const b = await request.json() as { heure_depart?: string };
    heureDepart = b.heure_depart ? new Date(b.heure_depart).toISOString() : new Date().toISOString();
  } catch { heureDepart = new Date().toISOString(); }
  await env.DB.prepare("UPDATE courses SET statut='en_cours', heure_depart=? WHERE id=?")
    .bind(heureDepart, courseId).run();
  return json({ success: true, course_id: courseId, heure_depart: heureDepart });
}

// POST /api/admin/course/:id/stop
async function stopCourse(courseId: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first<Course>();
  if (!course) return err('Course introuvable', 404);
  if (course.statut !== 'en_cours') return err('Course non en cours', 409);
  await env.DB.prepare("UPDATE courses SET statut='terminee' WHERE id=?").bind(courseId).run();
  return json({ success: true, course_id: courseId });
}

// POST /api/admin/course/:id/reset
async function resetCourse(courseId: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  await env.DB.prepare('DELETE FROM arrivees WHERE course_id = ?').bind(courseId).run();
  await env.DB.prepare("UPDATE courses SET statut='attente', heure_depart=NULL WHERE id=?").bind(courseId).run();
  return json({ success: true });
}

// POST /api/admin/coureurs/import
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
    const url = new URL(request.url);
    courseId = Number(url.searchParams.get('course_id'));
    const text = await request.text();
    const lines = text.trim().split('\n');
    
    // Détecter le séparateur (virgule ou point-virgule)
    const separator = lines[0]?.includes(';') ? ';' : ',';
    
    // Parser l'en-tête et mapper les index des colonnes
    const headers = lines[0]?.split(separator).map((h) => h.trim().toLowerCase()) ?? [];
    const colIndex = {
      dossard: headers.indexOf('dossard'),
      nom: headers.indexOf('nom'),
      prenom: headers.indexOf('prenom'),
      sexe: headers.indexOf('sexe'),
      categorie: headers.indexOf('categorie'),
      club: headers.indexOf('club'),
    };
    
    const rows = lines.slice(1);
    lignes = rows.map((row) => {
      const cells = row.split(separator).map(v => v.trim().replace(/^"|"$/g, ''));
      return {
        dossard: Number(cells[colIndex.dossard] ?? ''),
        nom: (cells[colIndex.nom] ?? '').toUpperCase(),
        prenom: cells[colIndex.prenom] ?? '',
        sexe: (cells[colIndex.sexe] ?? 'M').toUpperCase().charAt(0),
        categorie: (cells[colIndex.categorie] ?? '').toUpperCase(),
        club: cells[colIndex.club] ?? '',
      };
    });
  }

  if (!Number.isInteger(courseId) || courseId < 1) return err('course_id invalide');
  const course = await env.DB.prepare('SELECT id FROM courses WHERE id = ?').bind(courseId).first();
  if (!course) return err('Course introuvable', 404);

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

// GET /api/admin/export/:courseId → CSV
async function exportClassement(courseId: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first<Course>();
  if (!course) return err('Course introuvable', 404);

  const { results } = await env.DB.prepare(
    `SELECT ROW_NUMBER() OVER (ORDER BY a.heure_arrivee ASC) AS position,
            a.dossard,
            COALESCE(c.nom,'INCONNU') AS nom, COALESCE(c.prenom,'') AS prenom,
            COALESCE(c.sexe,'?') AS sexe, COALESCE(c.categorie,'') AS categorie,
            COALESCE(c.club,'') AS club, a.heure_arrivee, a.saisie_par
     FROM arrivees a
     LEFT JOIN coureurs c ON c.dossard = a.dossard AND c.course_id = a.course_id
     WHERE a.course_id = ? ORDER BY a.heure_arrivee ASC`,
  ).bind(courseId).all<Record<string, unknown>>();

  const depart = course.heure_depart ? new Date(course.heure_depart).getTime() : 0;
  const headers = ['Position','Dossard','Nom','Prénom','Sexe','Catégorie','Club','Temps','Heure arrivée','Saisi par'];
  const rows = results.map(r => {
    const ts = depart > 0 ? Math.round((new Date(r.heure_arrivee as string).getTime() - depart) / 1000) : 0;
    return [r.position, r.dossard, r.nom, r.prenom, r.sexe, r.categorie, r.club,
            formatTemps(ts), r.heure_arrivee, r.saisie_par]
      .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
  });
  const csv = [headers.join(','), ...rows].join('\n');
  const filename = `classement_${course.nom}_${course.annee}_${new Date().toISOString().slice(0,10)}.csv`;
  return new Response(csv, {
    headers: { ...cors(), 'Content-Type': 'text/csv; charset=utf-8',
               'Content-Disposition': `attachment; filename="${filename}"` },
  });
}

// GET /api/admin/stats
async function getStats(request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.nom, c.annee, c.statut, c.heure_depart,
            COUNT(DISTINCT cr.dossard) AS nb_inscrits,
            COUNT(DISTINCT a.dossard)  AS nb_arrives
     FROM courses c
     LEFT JOIN coureurs cr ON cr.course_id = c.id
     LEFT JOIN arrivees a  ON a.course_id  = c.id
     GROUP BY c.id
     ORDER BY c.annee DESC, c.distance_km ASC`,
  ).all();
  return json(results);
}

// POST /api/admin/arrivee-manuelle
async function arriveeManuelle(request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  let body: { dossard?: unknown; course_id?: unknown; heure_forcee?: unknown };
  try { body = await request.json(); } catch { return err('JSON invalide'); }
  const dossard  = Number(body.dossard);
  const courseId = Number(body.course_id);
  if (!Number.isInteger(dossard) || dossard < 1)  return err('Dossard invalide');
  if (!Number.isInteger(courseId) || courseId < 1) return err('course_id invalide');
  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first<Course>();
  if (!course) return err('Course introuvable', 404);
  let heureArrivee: string;
  if (body.heure_forcee && typeof body.heure_forcee === 'string') {
    try { heureArrivee = new Date(body.heure_forcee).toISOString(); } catch { return err('heure_forcee invalide'); }
  } else { heureArrivee = new Date().toISOString(); }
  try {
    await env.DB.prepare(
      'INSERT INTO arrivees (dossard, course_id, heure_arrivee, saisie_par) VALUES (?, ?, ?, ?)',
    ).bind(dossard, courseId, heureArrivee, 'admin').run();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') || msg.includes('unique')) return err(`Dossard ${dossard} déjà enregistré`, 409);
    return err(`Erreur DB : ${msg}`, 500);
  }
  const depart = course.heure_depart ? new Date(course.heure_depart).getTime() : 0;
  const temps_sec = depart > 0 ? Math.round((new Date(heureArrivee).getTime() - depart) / 1000) : 0;
  return json({ success: true, dossard, heure_arrivee: heureArrivee, temps_brut: formatTemps(temps_sec) }, 201);
}

// POST /api/admin/course  body: { nom, distance_km, annee? }
async function createCourse(request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  let body: { nom?: unknown; distance_km?: unknown; annee?: unknown };
  try { body = await request.json(); } catch { return err('JSON invalide'); }
  const nom  = String(body.nom ?? '').trim();
  const dist = Number(body.distance_km);
  const annee = body.annee !== undefined ? Number(body.annee) : new Date().getFullYear();
  if (!nom)              return err('nom requis');
  if (isNaN(dist) || dist <= 0)   return err('distance_km invalide');
  if (!Number.isInteger(annee) || annee < 2000) return err('annee invalide');
  const result = await env.DB.prepare(
    'INSERT INTO courses (nom, distance_km, annee) VALUES (?, ?, ?)',
  ).bind(nom, dist, annee).run();
  const newId = (result.meta as Record<string, unknown>)['last_row_id'] ?? null;
  return json({ success: true, id: newId }, 201);
}

// PUT /api/admin/course/:id  body: { nom?, distance_km?, annee? }
async function updateCourse(courseId: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first<Course>();
  if (!course) return err('Course introuvable', 404);
  let body: { nom?: unknown; distance_km?: unknown; annee?: unknown };
  try { body = await request.json(); } catch { return err('JSON invalide'); }
  const nom   = body.nom   !== undefined ? String(body.nom).trim()   : course.nom;
  const dist  = body.distance_km !== undefined ? Number(body.distance_km) : course.distance_km;
  const annee = body.annee !== undefined ? Number(body.annee) : course.annee;
  if (!nom)              return err('nom requis');
  if (isNaN(dist) || dist <= 0)   return err('distance_km invalide');
  if (!Number.isInteger(annee) || annee < 2000) return err('annee invalide');
  await env.DB.prepare(
    'UPDATE courses SET nom=?, distance_km=?, annee=? WHERE id=?',
  ).bind(nom, dist, annee, courseId).run();
  return json({ success: true });
}

// DELETE /api/admin/course/:id
async function deleteCourse(courseId: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first<Course>();
  if (!course) return err('Course introuvable', 404);
  if (course.statut === 'en_cours') return err('Impossible de supprimer une course en cours', 409);
  await env.DB.prepare('DELETE FROM courses WHERE id = ?').bind(courseId).run();
  return json({ success: true });
}

// PUT /api/admin/coureur/:courseId/:dossard
async function updateCoureur(courseId: number, dossard: number, request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);
  const coureur = await env.DB.prepare(
    'SELECT * FROM coureurs WHERE course_id = ? AND dossard = ?',
  ).bind(courseId, dossard).first<{ nom: string; prenom: string; sexe: string; categorie: string; club: string }>();
  if (!coureur) return err('Coureur introuvable', 404);
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return err('JSON invalide'); }
  const nom       = body.nom       !== undefined ? String(body.nom).trim().toUpperCase()       : coureur.nom;
  const prenom    = body.prenom    !== undefined ? String(body.prenom).trim()                  : coureur.prenom;
  const sexe      = body.sexe      !== undefined ? String(body.sexe).toUpperCase().charAt(0)   : coureur.sexe;
  const categorie = body.categorie !== undefined ? String(body.categorie).trim().toUpperCase() : coureur.categorie;
  const club      = body.club      !== undefined ? String(body.club).trim()                    : coureur.club;
  if (!nom || !prenom) return err('nom et prenom requis');
  await env.DB.prepare(
    'UPDATE coureurs SET nom=?, prenom=?, sexe=?, categorie=?, club=? WHERE course_id=? AND dossard=?',
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
  await env.DB.prepare('DELETE FROM coureurs WHERE course_id=? AND dossard=?').bind(courseId, dossard).run();
  return json({ success: true });
}


// POST /api/admin/classement/import
// CSV : position,dossard,nom,prenom,sexe,categorie,club,temps
//       - position : optionnel (recalculé au tri par temps)
//       - temps    : HH:MM:SS ou H:MM:SS
// Si la course n'a pas de heure_depart, elle est calculée comme :
//   heure_depart = now - temps_du_premier_coureur
// La course est marquée "terminee" après import.
async function importClassement(request: Request, env: Env): Promise<Response> {
  if (!await requireAdmin(request, env)) return err('Non autorisé', 401);

  const url = new URL(request.url);
  const courseId = Number(url.searchParams.get('course_id'));
  if (!Number.isInteger(courseId) || courseId < 1) return err('course_id invalide');

  const course = await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(courseId).first<Course>();
  if (!course) return err('Course introuvable', 404);
  if (course.statut === 'en_cours') return err('Impossible d\'importer pendant une course en cours', 409);

  const text = await request.text();
  const rows = text.trim().split('\n');
  if (rows.length < 2) return err('Fichier vide ou sans données');

  // Détecter le séparateur (virgule ou point-virgule) depuis la première ligne
  const sep = rows[0].includes(';') ? ';' : ',';
  const header = rows[0].split(sep).map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const col = (name: string) => header.indexOf(name);

  const iDossard  = col('dossard');
  const iTemps    = col('temps');
  const iNom      = col('nom');
  const iPrenom   = col('prenom');
  const iSexe     = col('sexe');
  const iCateg    = col('categorie');
  const iClub     = col('club');

  if (iDossard < 0) return err('Colonne "dossard" manquante dans l\'en-tête');
  if (iTemps   < 0) return err('Colonne "temps" manquante dans l\'en-tête (format HH:MM:SS)');

  // Parser les lignes de données
  interface LigneImport {
    dossard: number;
    tempsStr: string;
    tempsSec: number;
    nom: string;
    prenom: string;
    sexe: string;
    categorie: string;
    club: string;
  }

  const lignes: LigneImport[] = [];
  for (const row of rows.slice(1)) {
    if (!row.trim()) continue;
    const cells = row.split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
    const dossard = Number(cells[iDossard]);
    const tempsStr = cells[iTemps] ?? '';
    if (!dossard || !tempsStr) continue;

    // Parser HH:MM:SS ou H:MM:SS en secondes
    const parts = tempsStr.split(':').map(Number);
    let tempsSec = 0;
    if (parts.length === 3) tempsSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) tempsSec = parts[0] * 60 + parts[1];
    if (isNaN(tempsSec) || tempsSec < 0) continue;

    lignes.push({
      dossard,
      tempsStr,
      tempsSec,
      nom:       iNom    >= 0 ? (cells[iNom] ?? '').toUpperCase()        : '',
      prenom:    iPrenom >= 0 ? (cells[iPrenom] ?? '')                    : '',
      sexe:      iSexe   >= 0 ? (cells[iSexe] ?? 'M').toUpperCase().charAt(0) : 'M',
      categorie: iCateg  >= 0 ? (cells[iCateg] ?? '').toUpperCase()       : '',
      club:      iClub   >= 0 ? (cells[iClub] ?? '')                      : '',
    });
  }

  if (lignes.length === 0) return err('Aucune ligne valide dans le fichier');

  // Trier par temps croissant (au cas où le CSV n'est pas trié)
  lignes.sort((a, b) => a.tempsSec - b.tempsSec);

  // Calculer ou utiliser heure_depart
  let heureDepart: string;
  if (course.heure_depart) {
    heureDepart = course.heure_depart;
  } else {
    // Synthétique : on part d'un temps de référence fixe (9h00 UTC)
    // afin que les temps affichés correspondent exactement au CSV
    const ref = new Date();
    ref.setUTCHours(9, 0, 0, 0);
    heureDepart = ref.toISOString();
  }

  const departMs = new Date(heureDepart).getTime();

  // Calculer les heures d'arrivée
  const arrivees = lignes.map(l => ({
    ...l,
    heureArrivee: new Date(departMs + l.tempsSec * 1000).toISOString(),
  }));

  // Upsert coureurs (si les colonnes sont présentes)
  let courseursOk = 0;
  if (iNom >= 0 && iPrenom >= 0) {
    for (const a of arrivees) {
      if (!a.nom) continue;
      try {
        await env.DB.prepare(
          `INSERT INTO coureurs (dossard, course_id, nom, prenom, sexe, categorie, club)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (dossard, course_id) DO UPDATE SET
             nom=excluded.nom, prenom=excluded.prenom, sexe=excluded.sexe,
             categorie=excluded.categorie, club=excluded.club`,
        ).bind(a.dossard, courseId, a.nom, a.prenom, a.sexe, a.categorie, a.club).run();
        courseursOk++;
      } catch { /* ignore */ }
    }
  }

  // Insérer les arrivées
  let arriveeOk = 0, arriveeSkip = 0;
  for (const a of arrivees) {
    try {
      await env.DB.prepare(
        `INSERT INTO arrivees (dossard, course_id, heure_arrivee, saisie_par)
         VALUES (?, ?, ?, ?)`,
      ).bind(a.dossard, courseId, a.heureArrivee, 'import').run();
      arriveeOk++;
    } catch {
      arriveeSkip++; // UNIQUE contrainte → déjà présent
    }
  }

  // Mettre à jour la course : heure_depart si non définie + statut terminée
  if (!course.heure_depart) {
    await env.DB.prepare(
      "UPDATE courses SET heure_depart = ?, statut = 'terminee' WHERE id = ?",
    ).bind(heureDepart, courseId).run();
  } else if (course.statut !== 'terminee') {
    await env.DB.prepare(
      "UPDATE courses SET statut = 'terminee' WHERE id = ?",
    ).bind(courseId).run();
  }

  return json({
    success: true,
    importes: arriveeOk,
    ignores: arriveeSkip,
    coureurs_mis_a_jour: courseursOk,
    total: lignes.length,
  }, 201);
}

// ─── Router principal ─────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }

    // ── Routes publiques ────────────────────────────────────────────────────

    if (path === '/api/annees' && method === 'GET') {
      return getAnnees(url, env);
    }

    if (path === '/api/courses' && method === 'GET') {
      return getCourses(url, env);
    }

    const classementMatch = path.match(/^\/api\/classement\/(\d+)$/);
    if (classementMatch && method === 'GET') {
      return getClassement(Number(classementMatch[1]), env);
    }

    // ── Routes bénévoles ────────────────────────────────────────────────────

    if (path === '/api/arrivee' && method === 'POST') {
      return postArrivee(request, env);
    }

    const checkArriveeMatch = path.match(/^\/api\/arrivee\/(\d+)\/(\d+)$/);
    if (checkArriveeMatch && method === 'GET') {
      return checkArrivee(Number(checkArriveeMatch[1]), Number(checkArriveeMatch[2]), env);
    }

    // ── Routes admin ────────────────────────────────────────────────────────

    if (path === '/api/admin/login' && method === 'POST') {
      return adminLogin(request, env);
    }

    const startMatch = path.match(/^\/api\/admin\/course\/(\d+)\/start$/);
    if (startMatch && method === 'POST') return startCourse(Number(startMatch[1]), request, env);

    const stopMatch = path.match(/^\/api\/admin\/course\/(\d+)\/stop$/);
    if (stopMatch && method === 'POST') return stopCourse(Number(stopMatch[1]), request, env);

    const resetMatch = path.match(/^\/api\/admin\/course\/(\d+)\/reset$/);
    if (resetMatch && method === 'POST') return resetCourse(Number(resetMatch[1]), request, env);

    if (path === '/api/admin/coureurs/import' && method === 'POST') {
      return importCoureurs(request, env);
    }

    if (path === '/api/admin/classement/import' && method === 'POST') {
      return importClassement(request, env);
    }

    const courseursMatch = path.match(/^\/api\/admin\/coureurs\/(\d+)$/);
    if (courseursMatch && method === 'GET') return getCoureurs(Number(courseursMatch[1]), request, env);

    const deleteArriveeMatch = path.match(/^\/api\/admin\/arrivee\/(\d+)$/);
    if (deleteArriveeMatch && method === 'DELETE') return deleteArrivee(Number(deleteArriveeMatch[1]), request, env);

    const exportMatch = path.match(/^\/api\/admin\/export\/(\d+)$/);
    if (exportMatch && method === 'GET') return exportClassement(Number(exportMatch[1]), request, env);

    if (path === '/api/admin/stats' && method === 'GET') return getStats(request, env);

    if (path === '/api/admin/arrivee-manuelle' && method === 'POST') return arriveeManuelle(request, env);

    // Course CRUD
    if (path === '/api/admin/course' && method === 'POST') return createCourse(request, env);

    const courseAdminMatch = path.match(/^\/api\/admin\/course\/(\d+)$/);
    if (courseAdminMatch && method === 'PUT')    return updateCourse(Number(courseAdminMatch[1]), request, env);
    if (courseAdminMatch && method === 'DELETE') return deleteCourse(Number(courseAdminMatch[1]), request, env);

    // Coureur CRUD
    const coureurMatch = path.match(/^\/api\/admin\/coureur\/(\d+)\/(\d+)$/);
    if (coureurMatch && method === 'PUT')    return updateCoureur(Number(coureurMatch[1]), Number(coureurMatch[2]), request, env);
    if (coureurMatch && method === 'DELETE') return deleteCoureur(Number(coureurMatch[1]), Number(coureurMatch[2]), request, env);

    // ── Assets statiques ────────────────────────────────────────────────────
    if (path.startsWith('/api/')) return err('Endpoint inconnu', 404);
    return env.ASSETS.fetch(request);
  },
};
