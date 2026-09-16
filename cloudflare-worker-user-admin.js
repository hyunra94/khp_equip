// Cloudflare Worker API server for GitHub Pages frontend
// Routes are served under /api/* by default.
// Required env vars are listed in worker-settings.md.

const NOTION_VERSION_DEFAULT = "2025-09-03";
const PHOTO_TOGGLE_TITLE_DEFAULT = "⑭ 장비 사진";
const MODEL_PHOTO_TOGGLE_TITLE_DEFAULT = "모델 공통사진";
const MONTHLY_PHOTO_TOGGLE_TITLE_DEFAULT = "점검 사진";
const encoder = new TextEncoder();

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return corsPreflight(request, env);

    try {
      const url = new URL(request.url);
      const path = normalizePath(url.pathname);
      const method = request.method;

      if (method === "GET" && path === "/api/health") return json({ ok: true }, 200, request, env);
      if (method === "GET" && path === "/api/version") return json({ ok: true, version: "monthly-auto-cron-v4-user-admin" }, 200, request, env);
      if (method === "GET" && path === "/api/debug") return debugInfo(request, env);
      if (method === "GET" && path === "/api/maintenance-debug") return json({ ok: true, hasMaintenanceDataSourceId: Boolean(env.NOTION_MAINTENANCE_DATA_SOURCE_ID), maintenanceDataSourceIdPrefix: String(env.NOTION_MAINTENANCE_DATA_SOURCE_ID || "").slice(0, 8) }, 200, request, env);
      if (method === "GET" && path === "/api/users") return getUsers(request, env);
      if (method === "GET" && path === "/api/login-debug") return loginDebug(request, env);
      if (method === "POST" && path === "/api/hash-debug") return hashDebug(request, env);
      if (method === "POST" && path === "/api/login") return login(request, env);
      if (method === "GET" && path === "/api/me") return me(request, env);

      const user = await requireAuth(request, env);

      if (path === "/api/admin/users") {
        const adminResponse = requireAdmin(user, request, env);
        if (adminResponse) return adminResponse;
        if (method === "GET") return listAdminUsers(request, env, user);
        if (method === "POST") return createAdminUser(request, env);
      }

      const adminUserResetMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/reset-code$/);
      if (adminUserResetMatch) {
        const adminResponse = requireAdmin(user, request, env);
        if (adminResponse) return adminResponse;
        if (method === "POST") return resetAdminUserCode(request, env, user, decodeURIComponent(adminUserResetMatch[1]));
      }

      const adminUserMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (adminUserMatch) {
        const adminResponse = requireAdmin(user, request, env);
        if (adminResponse) return adminResponse;
        if (method === "PATCH") return updateAdminUser(request, env, user, decodeURIComponent(adminUserMatch[1]));
      }

      if (method === "GET" && path === "/api/models") return listModels(request, env);
      const modelPhotoMatch = path.match(/^\/api\/models\/([^/]+)\/photos$/);
      if (method === "GET" && modelPhotoMatch) return getModelPhotos(request, env, decodeURIComponent(modelPhotoMatch[1]));
      if (method === "POST" && modelPhotoMatch) {
        const adminResponse = requireAdmin(user, request, env);
        return adminResponse || addModelPhotos(request, env, decodeURIComponent(modelPhotoMatch[1]));
      }

      if (method === "GET" && path === "/api/equipment") return listEquipment(request, env);
      if (method === "POST" && path === "/api/equipment") {
        const adminResponse = requireAdmin(user, request, env);
        return adminResponse || createEquipment(request, env);
      }

      const photoMatch = path.match(/^\/api\/equipment\/([^/]+)\/photos$/);
      if (method === "GET" && photoMatch) return getEquipmentPhotos(request, env, decodeURIComponent(photoMatch[1]));
      if (method === "POST" && photoMatch) {
        const adminResponse = requireAdmin(user, request, env);
        return adminResponse || addEquipmentPhotos(request, env, decodeURIComponent(photoMatch[1]));
      }

      if (method === "GET" && path === "/api/maintenance") return listMaintenance(request, env);
      if (method === "POST" && path === "/api/maintenance") return createMaintenance(request, env, user);

      const maintenanceMatch = path.match(/^\/api\/maintenance\/([^/]+)$/);
      if (method === "PATCH" && maintenanceMatch) return updateMaintenance(request, env, decodeURIComponent(maintenanceMatch[1]));

      if (method === "GET" && path === "/api/monthly") return listMonthly(request, env);
      if (method === "POST" && path === "/api/monthly/ensure") {
        const adminResponse = requireAdmin(user, request, env);
        return adminResponse || ensureMonthlyOne(request, env);
      }
      if (method === "POST" && path === "/api/monthly/generate") {
        const adminResponse = requireAdmin(user, request, env);
        return adminResponse || generateMonthly(request, env);
      }
      if (method === "POST" && path === "/api/monthly/auto-run") {
        const adminResponse = requireAdmin(user, request, env);
        return adminResponse || autoRunMonthly(request, env);
      }
      if (method === "POST" && path === "/api/monthly/sync-base-locations") {
        const adminResponse = requireAdmin(user, request, env);
        return adminResponse || syncMonthlyBaseLocations(request, env);
      }

      const monthlyPhotoMatch = path.match(/^\/api\/monthly\/([^/]+)\/photos$/);
      if (method === "GET" && monthlyPhotoMatch) return getMonthlyPhotos(request, env, decodeURIComponent(monthlyPhotoMatch[1]));
      if (method === "POST" && monthlyPhotoMatch) return addMonthlyPhotos(request, env, decodeURIComponent(monthlyPhotoMatch[1]));

      const monthlyMatch = path.match(/^\/api\/monthly\/([^/]+)$/);
      if (method === "PATCH" && monthlyMatch) return updateMonthly(request, env, user, decodeURIComponent(monthlyMatch[1]));

      return json({ error: "지원하지 않는 경로입니다." }, 404, request, env);
    } catch (error) {
      console.error(error);
      return json({ error: error.message || "서버 오류가 발생했습니다." }, error.status || 500, request, env);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const month = kstMonthNow();
      const limit = Math.max(1, Math.min(Number(env.AUTO_MONTHLY_LIMIT || 25), 50));
      const result = await autoGenerateMonthly(env, month, limit);
      console.log("monthly auto generation", JSON.stringify(result));
    })());
  }
};

function normalizePath(pathname) {
  // Worker route can be /api/* or full workers.dev/api/*. Keep /api prefix.
  if (pathname === "/") return "/api/health";
  return pathname.replace(/\/+$/, "") || "/";
}

function normalizeOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw === "*") return "*";
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);
}

function getCorsOrigin(request, env) {
  const origin = request.headers.get("Origin") || "*";
  return origin === "null" ? "*" : origin;
}

function corsHeaders(request, env) {
  const requestedHeaders = request.headers.get("Access-Control-Request-Headers");

  return {
    "Access-Control-Allow-Origin": getCorsOrigin(request, env),
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": requestedHeaders || "Authorization, Content-Type, X-Requested-With",
    "Access-Control-Expose-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

function corsPreflight(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

async function debugInfo(request, env) {
  const equipmentId = normalizeNotionId(env.NOTION_EQUIPMENT_DATA_SOURCE_ID || "");
  const monthlyId = normalizeNotionId(env.NOTION_MONTHLY_DATA_SOURCE_ID || "");
  let equipmentProbe = null;
  let monthlyProbe = null;

  if (equipmentId) equipmentProbe = await probeNotionId(env, equipmentId);
  if (monthlyId) monthlyProbe = await probeNotionId(env, monthlyId);

  return json({
    ok: true,
    origin: request.headers.get("Origin") || "",
    normalizedOrigin: normalizeOrigin(request.headers.get("Origin") || ""),
    allowedOrigins: allowedOrigins(env),
    hasNotionApiKey: Boolean(env.NOTION_API_KEY),
    hasEquipmentDataSourceId: Boolean(env.NOTION_EQUIPMENT_DATA_SOURCE_ID),
    hasMonthlyDataSourceId: Boolean(env.NOTION_MONTHLY_DATA_SOURCE_ID),
    hasModelDataSourceId: Boolean(env.NOTION_MODEL_DATA_SOURCE_ID),
    hasAccessUsersJson: Boolean(env.ACCESS_USERS_JSON),
    notionVersion: env.NOTION_VERSION || NOTION_VERSION_DEFAULT,
    equipmentProbe,
    monthlyProbe
  }, 200, request, env);
}

async function probeNotionId(env, id) {
  const result = { id: maskId(id), asDataSource: false, asDatabase: false, dataSourceFromDatabase: "" };
  try {
    await notion(env, `/data_sources/${id}`, { method: "GET" });
    result.asDataSource = true;
  } catch (error) {
    result.dataSourceError = error.message;
  }

  try {
    const db = await notion(env, `/databases/${id}`, { method: "GET" });
    result.asDatabase = true;
    result.dataSourceFromDatabase = db?.data_sources?.[0]?.id || db?.data_source?.id || "";
    if (result.dataSourceFromDatabase) result.dataSourceFromDatabase = maskId(result.dataSourceFromDatabase);
  } catch (error) {
    result.databaseError = error.message;
  }

  return result;
}

function maskId(id) {
  const v = String(id || "");
  return v.length > 12 ? `${v.slice(0, 6)}...${v.slice(-6)}` : v;
}

function json(data, status = 200, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(request && env ? corsHeaders(request, env) : {})
    }
  });
}

async function readJson(request) {
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}

function mustEnv(env, key) {
  if (!env[key]) throw new Error(`Cloudflare 환경변수 ${key} 값이 필요합니다.`);
  return env[key];
}

function getUsersFromEnv(env) {
  const raw = env.ACCESS_USERS_JSON || "[]";
  const users = JSON.parse(raw);
  if (!Array.isArray(users)) throw new Error("ACCESS_USERS_JSON은 배열 형식이어야 합니다.");
  return users;
}

async function sha256Hex(value) {
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function codeHash(name, code, env) {
  const secret = mustEnv(env, "LOGIN_SECRET");
  return sha256Hex(`${name}:${code}:${secret}`);
}

function base64UrlEncode(objOrString) {
  const raw = typeof objOrString === "string" ? objOrString : JSON.stringify(objOrString);
  const bytes = encoder.encode(raw);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmacSign(value, env) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(mustEnv(env, "SESSION_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function createToken(payload, env) {
  const body = base64UrlEncode(payload);
  const sig = await hmacSign(body, env);
  return `${body}.${sig}`;
}

async function verifyToken(token, env) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = await hmacSign(body, env);
  if (sig !== expected) return null;
  const payload = JSON.parse(base64UrlDecode(body));
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

async function requireAuth(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const user = await verifyToken(token, env);
  if (!user) throw new ResponseError("로그인이 필요합니다.", 401);
  return user;
}

function requireAdmin(user, request, env) {
  if (user.role === "admin") return null;
  return json({ error: "관리자 권한이 필요합니다." }, 403, request, env);
}

class ResponseError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}


function normalizeRole(value) {
  const role = String(value || "").trim();
  if (role === "관리자" || role.toLowerCase() === "admin") return "admin";
  if (role === "조회전용" || role.toLowerCase() === "readonly") return "readonly";
  return "staff";
}

function normalizeUserName(value) {
  return String(value || "").trim();
}

async function listUserRecords(env) {
  const configured = env.NOTION_USER_DATA_SOURCE_ID;
  if (!configured) return [];

  const pages = await queryDataSource(env, configured, {});
  return pages.map(page => ({
    id: page.id,
    사용자명: getText(page, "사용자명") || getText(page, "이름") || getTitleAny(page),
    사용자코드: getText(page, "사용자코드"),
    권한: getSelect(page, "권한") || getText(page, "권한") || "staff",
    사용여부: getCheckbox(page, "사용여부"),
    보안코드Hash: getText(page, "보안코드Hash"),
    기본담당위치: getMultiSelectNames(page, "기본담당위치"),
    url: page.url
  })).filter(user => user.사용자명);
}

async function compareSecurityHash(userName, code, storedHash, env) {
  const hash = String(storedHash || "").trim().toLowerCase();
  if (!hash) return false;

  const name = normalizeUserName(userName);
  const inputCode = String(code || "").trim();
  const secret = mustEnv(env, "LOGIN_SECRET");

  const candidates = [
    await sha256Hex(`${name}:${inputCode}:${secret}`),
    await sha256Hex(`${inputCode}:${secret}`),
    await sha256Hex(inputCode)
  ];

  return candidates.map(v => v.toLowerCase()).includes(hash);
}

async function findDbUserByName(env, name) {
  const target = normalizeUserName(name);
  const users = await listUserRecords(env);
  return users.find(user => normalizeUserName(user.사용자명) === target) || null;
}

async function hashDebug(request, env) {
  const input = await readJson(request);
  const name = String(input.name || "").trim();
  const code = String(input.code || "").trim();
  const secret = mustEnv(env, "LOGIN_SECRET");

  return json({
    ok: true,
    algorithms: {
      recommended: await sha256Hex(`${name}:${code}:${secret}`),
      codeSecret: await sha256Hex(`${code}:${secret}`),
      codeOnly: await sha256Hex(code)
    },
    note: "recommended 값을 사용자 관리 DB의 보안코드Hash에 넣는 것을 권장합니다."
  }, 200, request, env);
}

async function getUsers(request, env) {
  try {
    const dbUsers = await listUserRecords(env);
    const activeDbUsers = dbUsers
      .filter(user => user.사용여부 !== false)
      .map(user => ({
        name: user.사용자명,
        role: normalizeRole(user.권한)
      }));

    if (activeDbUsers.length) {
      return json({ users: activeDbUsers, source: "notion-user-db" }, 200, request, env);
    }
  } catch (error) {
    console.warn("사용자 관리 DB 조회 실패. ACCESS_USERS_JSON으로 fallback합니다.", error.message);
  }

  const users = getUsersFromEnv(env).map(user => ({
    name: user.name,
    role: user.role || "staff"
  }));
  return json({ users, source: "access-users-json" }, 200, request, env);
}

async function loginDebug(request, env) {
  let dbUsers = [];
  let dbError = "";

  try {
    dbUsers = await listUserRecords(env);
  } catch (error) {
    dbError = error.message || String(error);
  }

  const envUsers = getUsersFromEnv(env);

  return json({
    ok: true,
    sourcePriority: "사용자 관리 DB → ACCESS_USERS_JSON fallback",
    db: {
      error: dbError,
      count: dbUsers.length,
      users: dbUsers.map(user => ({
        name: user.사용자명,
        role: normalizeRole(user.권한),
        active: user.사용여부 !== false,
        hasSecurityHash: Boolean(user.보안코드Hash),
        notionUserPageId: user.id
      }))
    },
    env: {
      count: envUsers.length,
      users: envUsers.map(u => ({
        name: String(u.name || "").trim(),
        role: u.role || "staff",
        hasCode: u.code !== undefined && u.code !== null,
        hasCodeHash: Boolean(u.codeHash),
        notionUserPageId: Boolean(u.notionUserPageId)
      }))
    }
  }, 200, request, env);
}

async function login(request, env) {
  const input = await readJson(request);
  const inputName = String(input.name || "").trim();
  const inputCode = String(input.code || "").trim();

  // 1) 사용자 관리 DB 우선
  try {
    const dbUser = await findDbUserByName(env, inputName);

    if (dbUser) {
      if (dbUser.사용여부 === false) {
        return json({ error: "사용이 중지된 계정입니다." }, 401, request, env);
      }

      const ok = await compareSecurityHash(dbUser.사용자명, inputCode, dbUser.보안코드Hash, env);
      if (!ok) {
        return json({ error: "이름 또는 보안코드가 올바르지 않습니다." }, 401, request, env);
      }

      const payload = {
        name: dbUser.사용자명,
        role: normalizeRole(dbUser.권한),
        notionUserPageId: dbUser.id,
        defaultLocations: dbUser.기본담당위치 || [],
        exp: Date.now() + 1000 * 60 * 60 * 10
      };

      const token = await createToken(payload, env);
      return json({ token, user: { name: payload.name, role: payload.role } }, 200, request, env);
    }
  } catch (error) {
    console.warn("사용자 관리 DB 로그인 조회 실패. ACCESS_USERS_JSON으로 fallback합니다.", error.message);
  }

  // 2) fallback: Cloudflare ACCESS_USERS_JSON
  const users = getUsersFromEnv(env);
  const found = users.find(u => String(u.name || "").trim() === inputName);

  if (!found) return json({ error: "이름 또는 보안코드가 올바르지 않습니다." }, 401, request, env);

  let ok = false;

  if (found.code !== undefined && found.code !== null) {
    ok = ok || String(found.code).trim() === inputCode;
  }

  if (found.codeHash) {
    ok = ok || found.codeHash === await codeHash(String(found.name || "").trim(), inputCode, env);
  }

  if (!ok) return json({ error: "이름 또는 보안코드가 올바르지 않습니다." }, 401, request, env);

  const payload = {
    name: String(found.name || "").trim(),
    role: found.role || "staff",
    notionUserPageId: found.notionUserPageId || "",
    exp: Date.now() + 1000 * 60 * 60 * 10
  };

  const token = await createToken(payload, env);
  return json({ token, user: { name: payload.name, role: payload.role } }, 200, request, env);
}

async function me(request, env) {
  const user = await requireAuth(request, env);
  return json({ user: { name: user.name, role: user.role } }, 200, request, env);
}

function userRoleSelectName(role) {
  return normalizeRole(role) === "admin" ? "관리자" : "직원";
}

function isSameUserRecord(record, currentUser) {
  const currentId = normalizeNotionId(currentUser?.notionUserPageId || "");
  const recordId = normalizeNotionId(record?.id || "");
  if (currentId && recordId && currentId === recordId) return true;
  return normalizeUserName(record?.사용자명) === normalizeUserName(currentUser?.name);
}

function adminUserPayload(record) {
  const role = normalizeRole(record.권한);
  return {
    id: record.id,
    name: record.사용자명,
    role: role === "admin" ? "admin" : "staff",
    active: record.사용여부 !== false,
    hasSecurityHash: Boolean(record.보안코드Hash),
    defaultLocations: record.기본담당위치 || []
  };
}

function findUserRecordById(records, pageId) {
  const target = normalizeNotionId(pageId);
  return records.find(record => normalizeNotionId(record.id) === target) || null;
}

function activeAdminCount(records) {
  return records.filter(record => record.사용여부 !== false && normalizeRole(record.권한) === "admin").length;
}

async function listAdminUsers(request, env, currentUser) {
  const users = (await listUserRecords(env))
    .filter(record => !isSameUserRecord(record, currentUser))
    .map(adminUserPayload)
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));

  return json({ users }, 200, request, env);
}

function validateAdminUserInput(input, { requireCode = false } = {}) {
  const name = normalizeUserName(input.name);
  const code = String(input.code || "").trim();
  const role = normalizeRole(input.role);

  if (!name) throw new ResponseError("사용자명을 입력해주세요.", 400);
  if (requireCode && !/^\d{4,12}$/.test(code)) {
    throw new ResponseError("보안코드는 숫자 4~12자리로 입력해주세요.", 400);
  }
  if (!["staff", "admin"].includes(role)) {
    throw new ResponseError("권한은 직원 또는 관리자만 선택할 수 있습니다.", 400);
  }

  return { name, code, role };
}

async function createAdminUser(request, env) {
  const input = await readJson(request);
  const { name, code, role } = validateAdminUserInput(input, { requireCode: true });
  const active = input.active !== false;
  const existing = await findDbUserByName(env, name);
  if (existing) throw new ResponseError("이미 등록된 사용자명입니다.", 409);

  const hash = await codeHash(name, code, env);
  const sourceId = mustEnv(env, "NOTION_USER_DATA_SOURCE_ID");

  const created = await notion(env, "/pages", {
    method: "POST",
    body: {
      parent: pageParentFromResolvedSource(await resolveDataSourceIdForCreate(env, sourceId)),
      properties: {
        사용자명: pTitle(name),
        사용자코드: pText(""),
        보안코드Hash: pText(hash),
        권한: pSelect(userRoleSelectName(role)),
        사용여부: pCheckbox(active)
      }
    }
  });

  return json({ ok: true, user: { id: created.id, name, role, active, hasSecurityHash: true } }, 201, request, env);
}

async function updateAdminUser(request, env, currentUser, pageId) {
  const input = await readJson(request);
  const records = await listUserRecords(env);
  const target = findUserRecordById(records, pageId);
  if (!target) throw new ResponseError("사용자를 찾을 수 없습니다.", 404);

  const wantsRoleChange = Object.prototype.hasOwnProperty.call(input, "role");
  const wantsActiveChange = Object.prototype.hasOwnProperty.call(input, "active");

  if (!wantsRoleChange && !wantsActiveChange) {
    throw new ResponseError("변경할 항목이 없습니다.", 400);
  }

  if (isSameUserRecord(target, currentUser) && (wantsRoleChange || wantsActiveChange)) {
    throw new ResponseError("현재 로그인한 관리자 본인은 권한변경 또는 사용중지를 할 수 없습니다.", 403);
  }

  const nextRole = wantsRoleChange ? normalizeRole(input.role) : normalizeRole(target.권한);
  if (wantsRoleChange && !["staff", "admin"].includes(nextRole)) {
    throw new ResponseError("권한은 직원 또는 관리자만 선택할 수 있습니다.", 400);
  }

  const nextActive = wantsActiveChange ? Boolean(input.active) : target.사용여부 !== false;
  const currentlyActiveAdmin = target.사용여부 !== false && normalizeRole(target.권한) === "admin";
  const willRemainActiveAdmin = nextActive && nextRole === "admin";

  if (currentlyActiveAdmin && !willRemainActiveAdmin && activeAdminCount(records) <= 1) {
    throw new ResponseError("마지막 활성 관리자 1명은 사용중지하거나 직원으로 변경할 수 없습니다.", 409);
  }

  const properties = {};
  if (wantsRoleChange) properties.권한 = pSelect(userRoleSelectName(nextRole));
  if (wantsActiveChange) properties.사용여부 = pCheckbox(nextActive);

  await notion(env, `/pages/${normalizeNotionId(pageId)}`, {
    method: "PATCH",
    body: { properties }
  });

  return json({ ok: true }, 200, request, env);
}

async function resetAdminUserCode(request, env, currentUser, pageId) {
  const input = await readJson(request);
  const code = String(input.code || "").trim();
  if (!/^\d{4,12}$/.test(code)) {
    throw new ResponseError("보안코드는 숫자 4~12자리로 입력해주세요.", 400);
  }

  const records = await listUserRecords(env);
  const target = findUserRecordById(records, pageId);
  if (!target) throw new ResponseError("사용자를 찾을 수 없습니다.", 404);
  if (isSameUserRecord(target, currentUser)) {
    throw new ResponseError("현재 로그인한 관리자 본인의 보안코드는 사용자 관리 목록에서 재설정할 수 없습니다.", 403);
  }

  await notion(env, `/pages/${normalizeNotionId(pageId)}`, {
    method: "PATCH",
    body: {
      properties: {
        보안코드Hash: pText(await codeHash(target.사용자명, code, env)),
        사용자코드: pText("")
      }
    }
  });

  return json({ ok: true }, 200, request, env);
}

async function notion(env, path, options = {}) {
  const headers = {
    "Authorization": `Bearer ${mustEnv(env, "NOTION_API_KEY")}`,
    "Notion-Version": env.NOTION_VERSION || NOTION_VERSION_DEFAULT,
    ...(options.headers || {})
  };

  let body = options.body;
  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`https://api.notion.com/v1${path}`, {
      method: options.method || "GET",
      headers,
      body
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : {};

    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get("retry-after") || 1);
      await delay((retryAfter + 0.2) * 1000);
      continue;
    }

    if (!response.ok) {
      console.error("Notion API error", response.status, data);
      throw new Error(data.message || `Notion API ${response.status}`);
    }

    return data;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function queryDataSource(env, sourceOrDatabaseId, payload = {}) {
  const id = normalizeNotionId(sourceOrDatabaseId);

  // 1) New API: treat env value as data_source_id
  try {
    return await queryDataSourceDirect(env, id, payload);
  } catch (directError) {
    console.warn("data source direct query failed; trying database resolve/fallback", directError.message);

    // 2) Treat env value as database_id, retrieve database and use first data source
    try {
      const database = await notion(env, `/databases/${id}`, { method: "GET" });
      const dataSourceId = database?.data_sources?.[0]?.id || database?.data_source?.id;
      if (dataSourceId) {
        return await queryDataSourceDirect(env, dataSourceId, payload);
      }
    } catch (databaseError) {
      console.warn("database retrieve fallback failed", databaseError.message);
    }

    // 3) Legacy fallback: query database directly. Useful if the copied ID is the database ID.
    try {
      return await queryDatabaseLegacy(env, id, payload);
    } catch (legacyError) {
      console.warn("legacy database query fallback failed", legacyError.message);
      throw new Error(
        `Notion DB 조회 실패: ${directError.message} / fallback: ${legacyError.message}. ` +
        `DB가 Integration에 직접 연결되어 있는지, 또는 data source ID가 맞는지 확인하세요.`
      );
    }
  }
}

async function queryDataSourceDirect(env, dataSourceId, payload = {}) {
  const all = [];
  let cursor;
  do {
    const data = await notion(env, `/data_sources/${normalizeNotionId(dataSourceId)}/query`, {
      method: "POST",
      body: {
        page_size: 100,
        ...payload,
        ...(cursor ? { start_cursor: cursor } : {})
      }
    });
    all.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return all;
}

async function queryDatabaseLegacy(env, databaseId, payload = {}) {
  const all = [];
  let cursor;
  do {
    const data = await notion(env, `/databases/${normalizeNotionId(databaseId)}/query`, {
      method: "POST",
      body: {
        page_size: 100,
        ...payload,
        ...(cursor ? { start_cursor: cursor } : {})
      }
    });
    all.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return all;
}

async function resolveDataSourceIdForCreate(env, sourceOrDatabaseId) {
  const id = normalizeNotionId(sourceOrDatabaseId);

  // If it is a data source id, this endpoint should work.
  try {
    await notion(env, `/data_sources/${id}`, { method: "GET" });
    return { type: "data_source_id", id };
  } catch {}

  // If it is a database id, resolve first data source.
  try {
    const database = await notion(env, `/databases/${id}`, { method: "GET" });
    const dataSourceId = database?.data_sources?.[0]?.id || database?.data_source?.id;
    if (dataSourceId) return { type: "data_source_id", id: dataSourceId };
  } catch {}

  // Last resort: legacy database parent
  return { type: "database_id", id };
}

function pageParentFromResolvedSource(resolved) {
  if (resolved.type === "data_source_id") {
    return { type: "data_source_id", data_source_id: resolved.id };
  }
  return { type: "database_id", database_id: resolved.id };
}

function normalizeNotionId(id) {
  return String(id || "").trim().replaceAll("-", "");
}

async function listBlockChildren(env, blockId) {
  const all = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ page_size: "100" });
    if (cursor) qs.set("start_cursor", cursor);
    const data = await notion(env, `/blocks/${blockId}/children?${qs.toString()}`);
    all.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return all;
}

function rich(value) {
  return [{ type: "text", text: { content: String(value ?? "") } }];
}
function pTitle(v) { return { type: "title", title: rich(v || "미입력") }; }
function pText(v) { return { type: "rich_text", rich_text: v ? rich(v) : [] }; }
function pSelect(v) { return { type: "select", select: v ? { name: v } : null }; }
function pNumber(v) {
  const n = v === "" || v === null || v === undefined ? null : Number(String(v).replaceAll(",", ""));
  return { type: "number", number: Number.isFinite(n) ? n : null };
}
function pDate(v) { return { type: "date", date: v ? { start: String(v).slice(0, 10) } : null }; }
function pUrl(v) { return { type: "url", url: v || null }; }
function pCheckbox(v) { return { type: "checkbox", checkbox: Boolean(v) }; }
function pRelation(id) { return { type: "relation", relation: id ? [{ id }] : [] }; }

function getText(page, name) {
  const prop = page.properties?.[name];
  if (!prop) return "";
  if (prop.type === "title") return (prop.title || []).map(t => t.plain_text).join("");
  if (prop.type === "rich_text") return (prop.rich_text || []).map(t => t.plain_text).join("");
  if (prop.type === "url") return prop.url || "";
  return "";
}
function getTitleAny(page) {
  const props = page.properties || {};
  for (const [name, prop] of Object.entries(props)) {
    if (prop.type === "title") {
      return (prop.title || []).map(t => t.plain_text).join("");
    }
  }
  return "";
}

function getFirstText(page, names = []) {
  for (const name of names) {
    const value = getText(page, name);
    if (value) return value;
  }
  return "";
}

function getFirstDate(page, names = []) {
  for (const name of names) {
    const value = getDate(page, name);
    if (value) return value;
  }
  return "";
}

function getFirstSelect(page, names = []) {
  for (const name of names) {
    const value = getSelect(page, name);
    if (value) return value;
  }
  return "";
}

function getFirstNumber(page, names = []) {
  for (const name of names) {
    const value = getNumber(page, name);
    if (value !== null && value !== undefined) return value;
  }
  return null;
}


async function retrieveSourceObject(env, sourceOrDatabaseId) {
  const id = normalizeNotionId(sourceOrDatabaseId);

  try {
    return await notion(env, `/data_sources/${id}`, { method: "GET" });
  } catch {}

  try {
    const database = await notion(env, `/databases/${id}`, { method: "GET" });
    const dataSourceId = database?.data_sources?.[0]?.id || database?.data_source?.id;
    if (dataSourceId) {
      return await notion(env, `/data_sources/${normalizeNotionId(dataSourceId)}`, { method: "GET" });
    }
    return database;
  } catch {}

  return null;
}

function getNumber(page, name) { return page.properties?.[name]?.number ?? null; }
function getDate(page, name) { return page.properties?.[name]?.date?.start || ""; }
function getSelect(page, name) { return page.properties?.[name]?.select?.name || ""; }
function getCheckbox(page, name) { return Boolean(page.properties?.[name]?.checkbox); }
function getMultiSelectNames(page, name) {
  return (page.properties?.[name]?.multi_select || []).map(item => item.name);
}

function getRelations(page, name) { return (page.properties?.[name]?.relation || []).map(r => r.id); }


function mapModel(page) {
  return {
    id: page.id,
    url: page.url,
    모델명: getText(page, "모델명"),
    제작회사: getText(page, "제작회사"),
    규격: getText(page, "규격"),
    대표사진URL: getText(page, "대표사진URL"),
    비고: getText(page, "비고")
  };
}

async function retrievePageSafe(env, pageId) {
  try {
    return await notion(env, `/pages/${normalizeNotionId(pageId)}`, { method: "GET" });
  } catch {
    return null;
  }
}

async function enrichEquipmentWithModels(env, rows) {
  const ids = [...new Set(rows.map(row => row.장비모델).filter(Boolean))];
  if (!ids.length) return rows;

  const modelMap = {};
  for (const id of ids) {
    const page = await retrievePageSafe(env, id);
    if (page) modelMap[id] = mapModel(page);
  }

  return rows.map(row => ({
    ...row,
    장비모델정보: row.장비모델 ? (modelMap[row.장비모델] || null) : null
  }));
}

async function listModels(request, env) {
  const configured = env.NOTION_MODEL_DATA_SOURCE_ID;
  if (!configured) return json({ rows: [] }, 200, request, env);

  const pages = await queryDataSource(env, configured, {});
  const rows = pages.map(mapModel).filter(row => row.모델명);
  return json({ rows }, 200, request, env);
}

function mapEquipment(page) {
  return {
    id: page.id,
    url: page.url,
    장비명: getText(page, "장비명"),
    관리번호: getText(page, "관리번호"),
    장비모델: getRelations(page, "장비모델")[0] || "",
    SN번호: getText(page, "SN번호"),
    작성년월일: getDate(page, "작성년월일"),
    입고일: getDate(page, "입고일") || getDate(page, "취득년월일"),
    제작회사: getText(page, "제작회사"),
    배치장소: getSelect(page, "배치장소"),
    세부위치: getText(page, "세부위치"),
    규격: getText(page, "규격"),
    자체일련번호: getText(page, "자체일련번호"),
    장비점검일자: getDate(page, "장비점검일자"),
    취득가격: getNumber(page, "취득가격"),
    취득년월일: getDate(page, "취득년월일"),
    내용연수: getNumber(page, "내용연수"),
    취득근거: getText(page, "취득근거"),
    장비상태등: getSelect(page, "장비상태등"),
    기타: getText(page, "기타"),
    대표사진URL: getText(page, "대표사진URL"),
    자산유형: getSelect(page, "자산유형"),
    월별현황포함: getCheckbox(page, "월별현황포함"),
    사용상태: getSelect(page, "사용상태"),
    비고: getText(page, "비고")
  };
}

function equipmentProperties(input) {
  return {
    장비명: pTitle(input.장비명),
    ...(input.장비모델 ? { 장비모델: pRelation(input.장비모델) } : {}),
    SN번호: pText(input.SN번호),
    작성년월일: pDate(input.작성년월일),
    제작회사: pText(input.제작회사),
    배치장소: pSelect(input.배치장소),
    세부위치: pText(input.세부위치),
    규격: pText(input.규격),
    자체일련번호: pText(input.자체일련번호),
    장비점검일자: pDate(input.장비점검일자),
    취득가격: pNumber(input.취득가격),
    취득년월일: pDate(input.취득년월일),
    내용연수: pNumber(input.내용연수),
    취득근거: pText(input.취득근거),
    장비상태등: pSelect(input.장비상태등 || "정상"),
    기타: pText(input.기타),
    대표사진URL: pUrl(input.대표사진URL),
    자산유형: pSelect(input.자산유형 || "장비"),
    월별현황포함: pCheckbox(input.월별현황포함 === true || input.월별현황포함 === "true" || input.월별현황포함 === "on"),
    사용상태: pSelect(input.사용상태 || "사용중"),
    비고: pText(input.비고)
  };
}

async function listEquipment(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").toLowerCase().trim();
  const location = url.searchParams.get("location") || "";
  const status = url.searchParams.get("status") || "";

  const filters = [];
  if (location) filters.push({ property: "배치장소", select: { equals: location } });
  if (status) filters.push({ property: "장비상태등", select: { equals: status } });

  const pages = await queryDataSource(env, mustEnv(env, "NOTION_EQUIPMENT_DATA_SOURCE_ID"), {
    ...(filters.length ? { filter: { and: filters } } : {})
  });

  let rows = await enrichEquipmentWithModels(env, pages.map(mapEquipment));
  if (q) {
    rows = rows.filter(r => `${r.장비명} ${r.관리번호} ${r.SN번호} ${r.자체일련번호} ${r.규격} ${r.장비모델정보?.모델명 || ""}`.toLowerCase().includes(q));
  }
  return json({ rows }, 200, request, env);
}

async function createEquipment(request, env) {
  const form = await request.formData();
  const input = Object.fromEntries([...form.entries()].filter(([_, v]) => typeof v === "string"));
  const photos = form.getAll("photos").filter(v => typeof v === "object" && v.size > 0);

  const page = await notion(env, "/pages", {
    method: "POST",
    body: {
      parent: pageParentFromResolvedSource(await resolveDataSourceIdForCreate(env, mustEnv(env, "NOTION_EQUIPMENT_DATA_SOURCE_ID"))),
      properties: equipmentProperties(input),
      children: [
        { object: "block", type: "heading_2", heading_2: { rich_text: rich("장비관리대장") } },
        { object: "block", type: "paragraph", paragraph: { rich_text: rich("웹앱에서 생성된 장비 원장 페이지입니다.") } }
      ]
    }
  });

  if (photos.length) await appendPhotosToEquipmentPage(env, page.id, photos);
  return json({ ok: true, pageId: page.id, url: page.url }, 200, request, env);
}

function blockText(block) {
  const value = block[block.type];
  return (value?.rich_text || []).map(t => t.plain_text).join("").trim();
}

function imageUrlFromBlock(block) {
  if (block.type !== "image") return null;
  const img = block.image;
  if (img.type === "external") return img.external?.url || null;
  if (img.type === "file") return img.file?.url || null;
  return null;
}

async function findPhotoToggleBlock(env, pageId, title) {
  const children = await listBlockChildren(env, pageId);
  return children.find(b => b.type === "toggle" && blockText(b) === title) || null;
}

async function collectImageBlocksRecursive(env, blocks, depth = 0) {
  const photos = [];

  for (const block of blocks) {
    const url = imageUrlFromBlock(block);
    if (url) photos.push({ id: block.id, url });

    // Notion에서 사진을 컬럼/토글/콜아웃 안에 넣으면 직접 children에는 image가 없을 수 있어 재귀 탐색합니다.
    if (block.has_children && depth < 5) {
      try {
        const children = await listBlockChildren(env, block.id);
        photos.push(...await collectImageBlocksRecursive(env, children, depth + 1));
      } catch {}
    }
  }

  return photos;
}

async function getPhotosFromPage(request, env, pageId, title) {
  const toggle = await findPhotoToggleBlock(env, pageId, title);
  const blocks = toggle ? await listBlockChildren(env, toggle.id) : await listBlockChildren(env, pageId);
  const photos = await collectImageBlocksRecursive(env, blocks);
  return json({ photos }, 200, request, env);
}

async function getEquipmentPhotos(request, env, pageId) {
  return getPhotosFromPage(request, env, pageId, env.PHOTO_TOGGLE_TITLE || PHOTO_TOGGLE_TITLE_DEFAULT);
}

async function getModelPhotos(request, env, pageId) {
  return getPhotosFromPage(request, env, pageId, env.MODEL_PHOTO_TOGGLE_TITLE || MODEL_PHOTO_TOGGLE_TITLE_DEFAULT);
}

async function getMonthlyPhotos(request, env, pageId) {
  return getPhotosFromPage(request, env, pageId, env.MONTHLY_PHOTO_TOGGLE_TITLE || MONTHLY_PHOTO_TOGGLE_TITLE_DEFAULT);
}

async function appendPhotosToPage(env, pageId, files, title) {
  if (!files.length) return 0;

  const ids = [];
  for (const file of files) {
    ids.push(await uploadFileToNotion(env, file));
    await delay(250);
  }

  const imageBlocks = ids.map(imageBlockFromUploadId);
  const toggle = await findPhotoToggleBlock(env, pageId, title);

  if (toggle) {
    await notion(env, `/blocks/${toggle.id}/children`, { method: "PATCH", body: { children: imageBlocks } });
  } else {
    await notion(env, `/blocks/${pageId}/children`, {
      method: "PATCH",
      body: {
        children: [{
          object: "block",
          type: "toggle",
          toggle: {
            rich_text: rich(title),
            color: "default",
            children: imageBlocks
          }
        }]
      }
    });
  }

  return ids.length;
}

async function addEquipmentPhotos(request, env, pageId) {
  const form = await request.formData();
  const photos = form.getAll("photos").filter(v => typeof v === "object" && v.size > 0);
  const count = await appendPhotosToPage(env, pageId, photos, env.PHOTO_TOGGLE_TITLE || PHOTO_TOGGLE_TITLE_DEFAULT);
  return json({ ok: true, count }, 200, request, env);
}

async function addMonthlyPhotos(request, env, pageId) {
  const form = await request.formData();
  const photos = form.getAll("photos").filter(v => typeof v === "object" && v.size > 0);
  const count = await appendPhotosToPage(env, pageId, photos, env.MONTHLY_PHOTO_TOGGLE_TITLE || MONTHLY_PHOTO_TOGGLE_TITLE_DEFAULT);
  return json({ ok: true, count }, 200, request, env);
}

async function addModelPhotos(request, env, pageId) {
  const form = await request.formData();
  const photos = form.getAll("photos").filter(v => typeof v === "object" && v.size > 0);
  const count = await appendPhotosToPage(env, pageId, photos, env.MODEL_PHOTO_TOGGLE_TITLE || MODEL_PHOTO_TOGGLE_TITLE_DEFAULT);
  return json({ ok: true, count }, 200, request, env);
}

async function uploadFileToNotion(env, file) {
  const created = await notion(env, "/file_uploads", {
    method: "POST",
    body: {
      mode: "single_part",
      filename: file.name || "equipment-photo.jpg",
      content_type: file.type || "application/octet-stream"
    }
  });

  const form = new FormData();
  form.append("file", file, file.name || "equipment-photo.jpg");

  const sent = await notion(env, `/file_uploads/${created.id}/send`, {
    method: "POST",
    body: form
  });

  return sent.id;
}

function imageBlockFromUploadId(id) {
  return {
    object: "block",
    type: "image",
    image: {
      type: "file_upload",
      file_upload: { id }
    }
  };
}

async function appendPhotosToEquipmentPage(env, pageId, files) {
  return appendPhotosToPage(env, pageId, files, env.PHOTO_TOGGLE_TITLE || PHOTO_TOGGLE_TITLE_DEFAULT);
}

const MAINTENANCE_TOGGLE_TITLE_DEFAULT = "⑮ 유지보수 내역";

function maintenanceToggleTitle(env) {
  return env.MAINTENANCE_TOGGLE_TITLE || MAINTENANCE_TOGGLE_TITLE_DEFAULT;
}

function encodeMaintenanceLine(input = {}, equipment = null) {
  const parts = [
    "유지보수",
    input.일자 || "",
    input.구분 || "유지보수",
    input.상태 || "접수",
    `장비=${equipment?.장비명 || ""}`,
    `내용=${String(input.내용 || "").replaceAll("|", "/")}`,
    `처리결과=${String(input.처리결과 || "").replaceAll("|", "/")}`,
    `비용=${input.비용 || ""}`,
    `비고=${String(input.비고 || "").replaceAll("|", "/")}`
  ];
  return parts.join(" | ");
}

function parseMaintenanceLine(text = "", equipmentId = "") {
  const raw = String(text || "").trim();
  if (!raw.startsWith("유지보수 |")) return null;

  const parts = raw.split("|").map(v => v.trim());
  const map = {};
  for (const part of parts.slice(4)) {
    const idx = part.indexOf("=");
    if (idx > -1) map[part.slice(0, idx)] = part.slice(idx + 1);
  }

  return {
    id: `block_${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2)}`,
    url: "",
    유지보수명: `${parts[1] || ""} ${parts[2] || "유지보수"}`.trim(),
    장비: equipmentId,
    장비명: map["장비"] || "",
    일자: parts[1] || "",
    구분: parts[2] || "",
    상태: parts[3] || "",
    내용: map["내용"] || "",
    처리결과: map["처리결과"] || "",
    비용: map["비용"] ? Number(map["비용"]) : null,
    비고: map["비고"] || ""
  };
}

async function appendMaintenanceToEquipmentPage(env, pageId, input, equipment) {
  const title = maintenanceToggleTitle(env);
  const line = encodeMaintenanceLine(input, equipment);
  const toggle = await findPhotoToggleBlock(env, pageId, title);

  const block = {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: rich(line)
    }
  };

  if (toggle) {
    await notion(env, `/blocks/${toggle.id}/children`, {
      method: "PATCH",
      body: { children: [block] }
    });
  } else {
    await notion(env, `/blocks/${pageId}/children`, {
      method: "PATCH",
      body: {
        children: [{
          object: "block",
          type: "toggle",
          toggle: {
            rich_text: rich(title),
            color: "default",
            children: [block]
          }
        }]
      }
    });
  }

  return { ok: true, stored: "equipment-page-toggle", line };
}

async function listMaintenanceFromEquipmentPage(env, pageId) {
  const title = maintenanceToggleTitle(env);
  const toggle = await findPhotoToggleBlock(env, pageId, title);
  if (!toggle) return [];

  const blocks = await listBlockChildren(env, toggle.id);
  return blocks
    .map(block => parseMaintenanceLine(blockText(block), pageId))
    .filter(Boolean);
}

function maintenanceDateKey(item) {
  return String(item?.일자 || "0000-00-00").slice(0, 10);
}

function sortMaintenanceDesc(rows) {
  return [...rows].sort((a, b) => maintenanceDateKey(b).localeCompare(maintenanceDateKey(a)));
}

function maintenanceRelationId(page) {
  return getRelations(page, "장비")[0]
    || getRelations(page, "장비명")[0]
    || getRelations(page, "장비원장")[0]
    || "";
}

function mapMaintenance(page) {
  return {
    id: page.id,
    url: page.url,
    유지보수명: getText(page, "유지보수명") || getText(page, "제목") || getTitleAny(page),
    장비: maintenanceRelationId(page),
    장비명: getFirstText(page, ["장비명복사", "장비명", "장비"]),
    일자: getFirstDate(page, ["일자", "입고일", "발생일", "처리일", "등록일"]),
    구분: getFirstSelect(page, ["구분", "유지보수구분", "분류"]),
    상태: getFirstSelect(page, ["상태", "처리상태", "진행상태"]),
    내용: getFirstText(page, ["내용", "유지보수내용", "점검내용"]),
    처리결과: getFirstText(page, ["처리결과", "조치내용", "결과"]),
    담당자: getFirstText(page, ["담당자", "처리자"]),
    비용: getFirstNumber(page, ["비용", "금액"]),
    비고: getFirstText(page, ["비고", "메모"])
  };
}

async function listMaintenance(request, env) {
  const url = new URL(request.url);
  const equipmentId = url.searchParams.get("equipment") || "";

  // 유지보수 DB가 있으면 DB 조회
  if (env.NOTION_MAINTENANCE_DATA_SOURCE_ID) {
    const pages = await queryDataSource(env, env.NOTION_MAINTENANCE_DATA_SOURCE_ID, {});
    let rows = pages.map(mapMaintenance);
    if (equipmentId) rows = rows.filter(row => row.장비 === equipmentId);
    rows = sortMaintenanceDesc(rows);
    return json({ rows, source: "maintenance-db" }, 200, request, env);
  }

  // 유지보수 DB가 없으면 장비 원장 페이지 내부 ⑮ 유지보수 내역 토글 조회
  if (equipmentId) {
    const rows = sortMaintenanceDesc(await listMaintenanceFromEquipmentPage(env, equipmentId));
    return json({ rows, source: "equipment-page-toggle" }, 200, request, env);
  }

  return json({
    rows: [],
    source: "none",
    warning: "NOTION_MAINTENANCE_DATA_SOURCE_ID가 없어서 전체 유지보수 DB 조회는 생략했습니다. 장비 상세에서는 페이지 내부 ⑮ 유지보수 내역을 조회합니다."
  }, 200, request, env);
}

function propExists(schema, name) {
  return Boolean(schema?.properties?.[name]);
}

function firstPropName(schema, names, type = null) {
  const props = schema?.properties || {};

  for (const name of names) {
    if (props[name] && (!type || props[name].type === type)) return name;
  }

  if (type) {
    const found = Object.entries(props).find(([_, prop]) => prop.type === type);
    if (found) return found[0];
  }

  return "";
}

async function maintenanceProperties(env, input, equipment) {
  const schema = await retrieveSourceObject(env, mustEnv(env, "NOTION_MAINTENANCE_DATA_SOURCE_ID"));
  const props = {};

  const titleName = firstPropName(schema, ["유지보수명", "제목", "내용"], "title");
  if (titleName) {
    props[titleName] = pTitle(input.유지보수명 || `${input.일자 || ""}_${equipment?.장비명 || "유지보수"}`);
  }

  const relationName = firstPropName(schema, ["장비", "장비명", "장비원장"], "relation");
  if (relationName && input.장비) {
    props[relationName] = pRelation(input.장비);
  }

  const dateName = firstPropName(schema, ["일자", "입고일", "발생일", "처리일", "등록일"], "date");
  if (dateName) props[dateName] = pDate(input.일자);

  const typeName = firstPropName(schema, ["구분", "유지보수구분", "분류"], "select");
  if (typeName) props[typeName] = pSelect(input.구분 || "유지보수");

  const statusName = firstPropName(schema, ["상태", "처리상태", "진행상태"], "select");
  if (statusName) props[statusName] = pSelect(input.상태 || "접수");

  const contentName = firstPropName(schema, ["내용", "유지보수내용", "점검내용"], "rich_text");
  if (contentName) props[contentName] = pText(input.내용);

  const resultName = firstPropName(schema, ["처리결과", "조치내용", "결과"], "rich_text");
  if (resultName) props[resultName] = pText(input.처리결과);

  const equipmentNameCopy = firstPropName(schema, ["장비명복사", "장비명텍스트"], "rich_text");
  if (equipmentNameCopy) props[equipmentNameCopy] = pText(equipment?.장비명 || "");

  const costName = firstPropName(schema, ["비용", "금액"], "number");
  if (costName) props[costName] = pNumber(input.비용);

  const noteName = firstPropName(schema, ["비고", "메모"], "rich_text");
  if (noteName) props[noteName] = pText(input.비고);

  return props;
}

async function createMaintenance(request, env, user) {
  const input = await readJson(request);
  let equipment = null;

  if (input.장비) {
    const page = await retrievePageSafe(env, input.장비);
    if (page) equipment = mapEquipment(page);
  }

  if (!input.장비) {
    return json({ error: "유지보수 내역을 저장할 장비가 필요합니다." }, 400, request, env);
  }

  // 유지보수 DB가 있으면 DB에 저장
  if (env.NOTION_MAINTENANCE_DATA_SOURCE_ID) {
    const props = await maintenanceProperties(env, input, equipment);
    if (!Object.keys(props).length) {
      return json({ error: "유지보수 DB 속성을 찾지 못했습니다. 제목 속성 또는 유지보수명 속성이 필요합니다." }, 500, request, env);
    }

    const page = await notion(env, "/pages", {
      method: "POST",
      body: {
        parent: pageParentFromResolvedSource(await resolveDataSourceIdForCreate(env, env.NOTION_MAINTENANCE_DATA_SOURCE_ID)),
        properties: props
      }
    });

    return json({ ok: true, pageId: page.id, url: page.url, source: "maintenance-db" }, 200, request, env);
  }

  // 유지보수 DB가 없으면 장비 원장 페이지 내부에 저장
  const saved = await appendMaintenanceToEquipmentPage(env, input.장비, input, equipment);
  return json({ ok: true, source: "equipment-page-toggle", ...saved }, 200, request, env);
}

async function updateMaintenance(request, env, pageId) {
  const input = await readJson(request);
  let equipment = null;

  if (input.장비) {
    const page = await retrievePageSafe(env, input.장비);
    if (page) equipment = mapEquipment(page);
  }

  const props = await maintenanceProperties(env, input, equipment);
  await notion(env, `/pages/${normalizeNotionId(pageId)}`, {
    method: "PATCH",
    body: { properties: props }
  });

  return json({ ok: true }, 200, request, env);
}

function mapMonthly(page) {
  return {
    id: page.id,
    url: page.url,
    현황명: getText(page, "현황명"),
    기준월: getText(page, "기준월"),
    중복방지키: getText(page, "중복방지키"),
    장비: getRelations(page, "장비")[0] || "",
    자체일련번호복사: getText(page, "자체일련번호복사"),
    SN번호복사: getText(page, "SN번호복사"),
    장비명복사: getText(page, "장비명복사"),
    원장기준배치장소: getSelect(page, "원장기준배치장소"),
    이번달위치: getSelect(page, "이번달위치"),
    원장기준상태: getSelect(page, "원장기준상태"),
    이번달상태: getSelect(page, "이번달상태"),
    확인여부: getCheckbox(page, "확인여부"),
    확인자명복사: getText(page, "확인자명복사"),
    확인일: getDate(page, "확인일"),
    메모: getText(page, "메모"),
    이슈여부: getCheckbox(page, "이슈여부")
  };
}

async function listMonthly(request, env) {
  const month = new URL(request.url).searchParams.get("month") || "";
  if (!month) return json({ error: "기준월이 필요합니다. 예: 2026-06" }, 400, request, env);
  const pages = await queryDataSource(env, mustEnv(env, "NOTION_MONTHLY_DATA_SOURCE_ID"), {
    filter: { property: "기준월", rich_text: { equals: month } }
  });
  return json({ rows: pages.map(mapMonthly) }, 200, request, env);
}

async function syncMonthlyBaseLocations(request, env) {
  const input = await readJson(request).catch(() => ({}));
  const month = String(input.month || kstMonthNow()).trim();
  if (!month) return json({ error: "기준월이 필요합니다. 예: 2026-09" }, 400, request, env);

  const pages = await queryDataSource(env, mustEnv(env, "NOTION_MONTHLY_DATA_SOURCE_ID"), {
    filter: { property: "기준월", rich_text: { equals: month } }
  });
  const rows = pages.map(mapMonthly);

  let synced = 0;
  let unchanged = 0;
  let skippedUnchecked = 0;
  let skippedRental = 0;
  let missingRelation = 0;
  let failed = 0;
  const failures = [];

  for (const row of rows) {
    // 점검 완료된 기록만 원장에 반영합니다. 미확인 행은 실수로 위치가 바뀌었을 가능성이 있어 제외합니다.
    if (row.확인여부 !== true) {
      skippedUnchecked++;
      continue;
    }

    const location = String(row.이번달위치 || "").trim();
    if (!row.장비 || !location) {
      missingRelation++;
      continue;
    }

    // 대여중은 임시 이동으로 취급해 기본 위치를 덮어쓰지 않습니다.
    if (location.includes("대여")) {
      skippedRental++;
      continue;
    }

    // 해당 월의 원장 기준 위치와 같으면 따로 반영할 변경사항이 없습니다.
    if (location === String(row.원장기준배치장소 || "").trim()) {
      unchanged++;
      continue;
    }

    try {
      await notion(env, `/pages/${normalizeNotionId(row.장비)}`, {
        method: "PATCH",
        body: { properties: { 배치장소: pSelect(location) } }
      });
      synced++;
      await delay(120);
    } catch (error) {
      failed++;
      failures.push({
        monthlyId: row.id,
        equipmentId: row.장비,
        name: row.장비명복사 || "",
        location,
        error: error.message || "원장 위치 반영 실패"
      });
    }
  }

  return json({
    ok: failed === 0,
    month,
    total: rows.length,
    synced,
    unchanged,
    skippedUnchecked,
    skippedRental,
    missingRelation,
    failed,
    failures: failures.slice(0, 20)
  }, 200, request, env);
}

function managementKey(eq) {
  // 중복방지 기준 우선순위:
  // 1) 관리번호 2) 자체일련번호 3) SN번호 4) Notion page id
  return String(eq.관리번호 || eq.자체일련번호 || eq.SN번호 || eq.id || "").trim();
}

function monthlyKey(month, eq) {
  return `${month}_${managementKey(eq)}`;
}

function makeMonthlyProperties(month, eq) {
  const key = monthlyKey(month, eq);
  const status = eq.장비상태등 || "정상";
  return {
    현황명: pTitle(`${key}_${eq.장비명}`),
    기준월: pText(month),
    중복방지키: pText(key),
    장비: pRelation(eq.id),
    자체일련번호복사: pText(eq.자체일련번호 || eq.관리번호 || eq.SN번호 || eq.id),
    SN번호복사: pText(eq.SN번호),
    장비명복사: pText(eq.장비명),
    원장기준배치장소: pSelect(eq.배치장소),
    이번달위치: pSelect(eq.배치장소),
    원장기준상태: pSelect(status),
    이번달상태: pSelect(status),
    확인여부: pCheckbox(false),
    확인자명복사: pText(""),
    확인일: pDate(null),
    메모: pText(""),
    이슈여부: pCheckbox(true)
  };
}

function kstMonthNow() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const year = kst.getUTCFullYear();
  const month = String(kst.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function isAutoMonthlyTarget(eq) {
  const assetType = String(eq.자산유형 || "").trim();
  const usageStatus = String(eq.사용상태 || "").trim();
  const equipmentStatus = String(eq.장비상태등 || "").trim();

  const excludedAsset = ["소프트웨어", "유지보수", "소모품"].includes(assetType);
  const excludedUsage = ["제외", "폐기"].includes(usageStatus);
  const excludedStatus = equipmentStatus === "폐기";

  return !excludedAsset && !excludedUsage && !excludedStatus;
}

async function autoGenerateMonthly(env, month, limit = 25) {
  const equipmentPages = await queryDataSource(env, mustEnv(env, "NOTION_EQUIPMENT_DATA_SOURCE_ID"), {});
  const equipment = equipmentPages.map(mapEquipment).filter(isAutoMonthlyTarget);

  const existingPages = await queryDataSource(env, mustEnv(env, "NOTION_MONTHLY_DATA_SOURCE_ID"), {
    filter: { property: "기준월", rich_text: { equals: month } }
  });
  const existingKeys = new Set(existingPages.map(p => getText(p, "중복방지키")));

  const monthlyParent = pageParentFromResolvedSource(
    await resolveDataSourceIdForCreate(env, mustEnv(env, "NOTION_MONTHLY_DATA_SOURCE_ID"))
  );

  let created = 0;
  let skipped = 0;
  let remaining = 0;

  for (const eq of equipment) {
    const key = monthlyKey(month, eq);

    if (existingKeys.has(key)) {
      skipped++;
      continue;
    }

    if (created >= limit) {
      remaining++;
      continue;
    }

    await notion(env, "/pages", {
      method: "POST",
      body: {
        parent: monthlyParent,
        properties: makeMonthlyProperties(month, eq)
      }
    });

    existingKeys.add(key);
    created++;
    await delay(120);
  }

  return {
    ok: true,
    month,
    target: equipment.length,
    created,
    skipped,
    remaining,
    done: remaining === 0,
    limit
  };
}

async function autoRunMonthly(request, env) {
  const input = await readJson(request).catch(() => ({}));
  const month = String(input.month || kstMonthNow()).trim();
  const limit = Math.max(1, Math.min(Number(input.limit || env.AUTO_MONTHLY_LIMIT || 25), 50));
  const result = await autoGenerateMonthly(env, month, limit);
  return json(result, 200, request, env);
}

async function ensureMonthlyOne(request, env) {
  const input = await readJson(request);
  const month = String(input.month || "").trim();
  const eq = input.equipment || {};

  if (!month) return json({ error: "기준월이 필요합니다. 예: 2026-06" }, 400, request, env);
  if (!eq.id) return json({ error: "장비 page id가 필요합니다." }, 400, request, env);

  // 웹에서 이미 불러온 장비 원장 데이터를 이용해 1건씩 생성합니다.
  // 장비 수가 많아도 Worker가 한 번에 오래 실행되지 않게 하기 위한 endpoint입니다.
  const normalizedEq = {
    id: eq.id,
    장비명: eq.장비명 || "",
    관리번호: eq.관리번호 || "",
    SN번호: eq.SN번호 || "",
    자체일련번호: eq.자체일련번호 || "",
    배치장소: eq.배치장소 || "미지정",
    장비상태등: eq.장비상태등 || "정상"
  };

  const key = monthlyKey(month, normalizedEq);

  const existing = await queryDataSource(env, mustEnv(env, "NOTION_MONTHLY_DATA_SOURCE_ID"), {
    filter: { property: "중복방지키", rich_text: { equals: key } }
  });

  if (existing.length > 0) {
    return json({ ok: true, created: 0, skipped: 1, key }, 200, request, env);
  }

  const monthlyParent = pageParentFromResolvedSource(
    await resolveDataSourceIdForCreate(env, mustEnv(env, "NOTION_MONTHLY_DATA_SOURCE_ID"))
  );

  await notion(env, "/pages", {
    method: "POST",
    body: {
      parent: monthlyParent,
      properties: makeMonthlyProperties(month, normalizedEq)
    }
  });

  return json({ ok: true, created: 1, skipped: 0, key }, 200, request, env);
}

async function generateMonthly(request, env) {
  const { month } = await readJson(request);
  if (!month) return json({ error: "기준월이 필요합니다. 예: 2026-06" }, 400, request, env);

  const equipmentPages = await queryDataSource(env, mustEnv(env, "NOTION_EQUIPMENT_DATA_SOURCE_ID"), {
    filter: {
      and: [
        { property: "자산유형", select: { equals: "장비" } },
        { property: "월별현황포함", checkbox: { equals: true } },
        { or: [
          { property: "사용상태", select: { equals: "사용중" } },
          { property: "사용상태", select: { equals: "보관" } }
        ] }
      ]
    }
  });
  const equipment = equipmentPages.map(mapEquipment);

  const existingPages = await queryDataSource(env, mustEnv(env, "NOTION_MONTHLY_DATA_SOURCE_ID"), {
    filter: { property: "기준월", rich_text: { equals: month } }
  });
  const existingKeys = new Set(existingPages.map(p => getText(p, "중복방지키")));

  let created = 0;
  let skipped = 0;
  for (const eq of equipment) {
    const key = monthlyKey(month, eq);
    if (existingKeys.has(key)) {
      skipped++;
      continue;
    }

    await notion(env, "/pages", {
      method: "POST",
      body: {
        parent: pageParentFromResolvedSource(await resolveDataSourceIdForCreate(env, mustEnv(env, "NOTION_MONTHLY_DATA_SOURCE_ID"))),
        properties: makeMonthlyProperties(month, eq)
      }
    });
    existingKeys.add(key);
    created++;
    await delay(250);
  }

  return json({ ok: true, month, target: equipment.length, created, skipped }, 200, request, env);
}

function isIssue(row) {
  return row.확인여부 !== true ||
    (row.이번달위치 || "") !== (row.원장기준배치장소 || "") ||
    (row.이번달상태 || "") !== "정상" ||
    Boolean((row.메모 || "").trim());
}

async function updateMonthly(request, env, user, pageId) {
  const input = await readJson(request);
  const oldPage = await notion(env, `/pages/${pageId}`);
  const old = mapMonthly(oldPage);
  const checked = Boolean(input.확인여부);
  const today = new Date().toISOString().slice(0, 10);

  const merged = {
    ...old,
    이번달위치: input.이번달위치 ?? old.이번달위치,
    이번달상태: input.이번달상태 ?? old.이번달상태,
    메모: input.메모 ?? old.메모,
    확인여부: checked
  };

  const properties = {
    이번달위치: pSelect(merged.이번달위치),
    이번달상태: pSelect(merged.이번달상태),
    메모: pText(merged.메모),
    확인여부: pCheckbox(checked),
    확인자명복사: checked ? pText(user.name) : pText(old.확인자명복사 || ""),
    확인일: checked ? pDate(today) : pDate(old.확인일 || null),
    이슈여부: pCheckbox(isIssue(merged)),
    마지막수정일: pDate(today)
  };

  if (user.notionUserPageId) {
    properties.마지막수정자 = pRelation(user.notionUserPageId);
    if (checked) properties.확인자 = pRelation(user.notionUserPageId);
  }

  await notion(env, `/pages/${pageId}`, { method: "PATCH", body: { properties } });

  // 월별 점검에서 위치를 영구 반영하도록 선택한 경우 장비 원장의 기본 배치장소도 같이 갱신합니다.
  // 대여중 같은 임시 이동은 프론트에서 기본적으로 반영 해제 상태로 전달됩니다.
  let baseLocationSynced = false;
  if (input.기본위치반영 === true && old.장비 && merged.이번달위치) {
    await notion(env, `/pages/${normalizeNotionId(old.장비)}`, {
      method: "PATCH",
      body: {
        properties: {
          배치장소: pSelect(merged.이번달위치)
        }
      }
    });
    baseLocationSynced = true;
  }

  return json({
    ok: true,
    baseLocationSynced,
    baseLocation: baseLocationSynced ? merged.이번달위치 : null
  }, 200, request, env);
}
