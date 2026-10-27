// api/reviews.js — True Shared Cloud Database (Supports Deleting ALL Reviews + Cross-Device Sync)
import fs from "fs";
import path from "path";

const INITIAL_REVIEWS = [
  {
    id: "rev-1",
    name: "Ka",
    city: "New Delhi",
    stars: 5,
    comment: "It is the BEST",
    badge: "Community Dispatch",
    createdAt: "2026-10-27T10:00:00.000Z"
  },
  {
    id: "rev-2",
    name: "Ka",
    city: "110018",
    stars: 5,
    comment: "Its decent",
    badge: "Verified Order • MAMTAMODERN40",
    createdAt: "2026-10-27T09:30:00.000Z"
  },
  {
    id: "rev-3",
    name: "Kanishk Gulati",
    city: "New Delhi • 110003",
    stars: 5,
    comment: "Good",
    badge: "Verified Order • KANISHK2405",
    createdAt: "2026-10-27T09:00:00.000Z"
  },
  {
    id: "rev-4",
    name: "Kanishk Gulati",
    city: "New Delhi",
    stars: 5,
    comment: "Best website for eco shopping.",
    badge: "Community Dispatch",
    createdAt: "2026-10-27T08:30:00.000Z"
  }
];

const TMP_FILE = path.join("/tmp", "terra_reviews_state_v3.json");
const ADMIN_KEY = (process.env.TERRA_ADMIN_KEY || "kanishk2405").trim();
const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim();
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const STORAGE_KEY = "terra_global_reviews_state_v3";

// Dedicated Cloud Bucket for TERRA Storefront (stores { reviews, deletedIds })
const CLOUD_BUCKET_URL = "https://kvdb.io/A6Xy9mPq7Vz2Lk8Wn4Jr1T/terra_global_reviews_state_v3";

function normalizeState(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    return { reviews: raw, deletedIds: [] };
  }
  if (typeof raw === "object" && Array.isArray(raw.reviews)) {
    return {
      reviews: raw.reviews,
      deletedIds: Array.isArray(raw.deletedIds) ? raw.deletedIds : []
    };
  }
  return null;
}

function readTmpState() {
  try {
    if (fs.existsSync(TMP_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
      return normalizeState(parsed);
    }
  } catch (e) {}
  return null;
}

function writeTmpState(stateObj) {
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(stateObj), "utf8");
  } catch (e) {}
}

async function readStateFromCloud() {
  // 1. Vercel KV / Upstash Redis (if linked)
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const res = await fetch(`${REDIS_URL}/get/${STORAGE_KEY}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.result) {
        const parsed = typeof data.result === "string" ? JSON.parse(data.result) : data.result;
        const norm = normalizeState(parsed);
        if (norm) {
          writeTmpState(norm);
          return { state: norm, storage: "vercel-kv" };
        }
      }
    } catch (e) {}
  }

  // 2. Permanent Cloud KV Bucket (Shared across all users & devices)
  try {
    const res = await fetch(CLOUD_BUCKET_URL, {
      method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" }
    });
    if (res.ok) {
      const text = await res.text();
      if (text) {
        const norm = normalizeState(JSON.parse(text));
        if (norm) {
          writeTmpState(norm);
          return { state: norm, storage: "cloud-db" };
        }
      }
    } else if (res.status === 404) {
      const initial = { reviews: [...INITIAL_REVIEWS], deletedIds: [] };
      await writeStateToCloud(initial);
      return { state: initial, storage: "cloud-db" };
    }
  } catch (e) {}

  // 3. Fallback to /tmp or initial seed
  const cached = readTmpState();
  if (cached) return { state: cached, storage: "cloud-cache" };

  const fallback = { reviews: [...INITIAL_REVIEWS], deletedIds: [] };
  writeTmpState(fallback);
  return { state: fallback, storage: "cloud-cache" };
}

async function writeStateToCloud(stateObj) {
  const cleanState = {
    reviews: Array.isArray(stateObj.reviews) ? stateObj.reviews : [],
    deletedIds: Array.isArray(stateObj.deletedIds) ? [...new Set(stateObj.deletedIds)] : []
  };
  writeTmpState(cleanState);

  if (REDIS_URL && REDIS_TOKEN) {
    try {
      await fetch(`${REDIS_URL}/set/${STORAGE_KEY}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(JSON.stringify(cleanState))
      });
      return "vercel-kv";
    } catch (e) {}
  }

  try {
    const res = await fetch(CLOUD_BUCKET_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cleanState)
    });
    if (res.ok) return "cloud-db";
  } catch (e) {}

  return "cloud-cache";
}

function mergeState(serverState, clientReviews = [], clientDeletedIds = []) {
  const deletedSet = new Set([
    ...(serverState.deletedIds || []),
    ...(Array.isArray(clientDeletedIds) ? clientDeletedIds : [])
  ]);

  const map = new Map();
  [...(serverState.reviews || []), ...(Array.isArray(clientReviews) ? clientReviews : [])].forEach(r => {
    if (r && r.id && r.name && r.comment && !deletedSet.has(r.id)) {
      const existing = map.get(r.id);
      if (!existing || r.editedByOwner) {
        map.set(r.id, r);
      }
    }
  });

  const mergedReviews = Array.from(map.values()).sort((a, b) => {
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });

  return {
    reviews: mergedReviews,
    deletedIds: Array.from(deletedSet)
  };
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  if (req.method === "OPTIONS") return res.status(204).end();

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body || "{}"); } catch { body = {}; }
  }
  body = body || {};

  const reqAdminKey = (req.headers["x-admin-key"] || body.adminKey || "").trim();
  const isOwnerVerified = Boolean(reqAdminKey && (reqAdminKey === ADMIN_KEY || reqAdminKey === "kanishk2405"));

  try {
    // 1. GET or SYNC
    if (req.method === "GET" || (req.method === "POST" && body.action === "sync")) {
      const { state: serverState, storage } = await readStateFromCloud();
      const merged = mergeState(serverState, body.clientReviews, body.deletedIds);

      if (
        merged.reviews.length !== serverState.reviews.length ||
        merged.deletedIds.length !== serverState.deletedIds.length
      ) {
        await writeStateToCloud(merged);
      }

      return res.status(200).json({
        ok: true,
        storage,
        isOwnerVerified,
        reviews: merged.reviews,
        deletedIds: merged.deletedIds
      });
    }

    // 2. POST: Any user on any device submits a new review
    if (req.method === "POST" && body.action !== "delete" && body.action !== "edit") {
      const name = String(body.name || "").trim().slice(0, 60);
      const city = String(body.city || "India").trim().slice(0, 60);
      const comment = String(body.comment || "").trim().slice(0, 500);
      const stars = Math.min(5, Math.max(1, Number(body.stars) || 5));
      const badge = String(body.badge || "Community Dispatch").trim().slice(0, 60);

      if (!name || !comment) {
        return res.status(400).json({ ok: false, message: "Name and review comment are required." });
      }

      const { state: serverState } = await readStateFromCloud();
      const merged = mergeState(serverState, body.clientReviews, body.deletedIds);

      const newReview = {
        id: "rev-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        name,
        city,
        stars,
        comment,
        badge,
        createdAt: new Date().toISOString()
      };

      const nextState = {
        reviews: [newReview, ...merged.reviews],
        deletedIds: merged.deletedIds
      };
      const storage = await writeStateToCloud(nextState);

      return res.status(201).json({
        ok: true,
        storage,
        review: newReview,
        reviews: nextState.reviews,
        deletedIds: nextState.deletedIds
      });
    }

    // 3. Verify Owner Passkey for Edit & Delete
    if (!isOwnerVerified) {
      return res.status(401).json({
        ok: false,
        errorCode: "UNAUTHORIZED_OWNER",
        message: "Invalid Owner Passkey. Click Owner Login first."
      });
    }

    // 4. PUT (or POST action="edit"): Owner edits a review
    if (req.method === "PUT" || (req.method === "POST" && body.action === "edit")) {
      const targetId = String(body.id || "").trim();
      const { state: serverState } = await readStateFromCloud();
      const merged = mergeState(serverState, body.clientReviews, body.deletedIds);
      const idx = merged.reviews.findIndex(r => r.id === targetId);

      if (idx === -1) {
        return res.status(404).json({ ok: false, message: "Review not found." });
      }

      merged.reviews[idx] = {
        ...merged.reviews[idx],
        name: body.name !== undefined ? String(body.name).trim().slice(0, 60) : merged.reviews[idx].name,
        city: body.city !== undefined ? String(body.city).trim().slice(0, 60) : merged.reviews[idx].city,
        stars: body.stars !== undefined ? Math.min(5, Math.max(1, Number(body.stars))) : merged.reviews[idx].stars,
        comment: body.comment !== undefined ? String(body.comment).trim().slice(0, 500) : merged.reviews[idx].comment,
        badge: body.badge !== undefined ? String(body.badge).trim().slice(0, 60) : merged.reviews[idx].badge,
        editedByOwner: true
      };

      const storage = await writeStateToCloud(merged);
      return res.status(200).json({
        ok: true,
        storage,
        review: merged.reviews[idx],
        reviews: merged.reviews,
        deletedIds: merged.deletedIds
      });
    }

    // 5. DELETE (or POST action="delete"): Owner permanently removes a review
    if (req.method === "DELETE" || (req.method === "POST" && body.action === "delete")) {
      const targetId = String(body.id || req.query?.id || "").trim();
      const { state: serverState } = await readStateFromCloud();
      const nextDeletedIds = [...new Set([...(serverState.deletedIds || []), ...(body.deletedIds || []), targetId])];
      const nextReviews = (serverState.reviews || []).filter(r => r.id !== targetId && !nextDeletedIds.includes(r.id));

      const nextState = {
        reviews: nextReviews,
        deletedIds: nextDeletedIds
      };
      const storage = await writeStateToCloud(nextState);

      return res.status(200).json({
        ok: true,
        storage,
        deletedId: targetId,
        reviews: nextState.reviews,
        deletedIds: nextState.deletedIds
      });
    }

    return res.status(405).json({ ok: false, message: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message || "Server error" });
  }
}
