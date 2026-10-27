// api/reviews.js — Permanent Cloud JSON Database + Owner Moderation API
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

const TMP_FILE = path.join("/tmp", "terra_reviews_db.json");
const ADMIN_KEY = (process.env.TERRA_ADMIN_KEY || "kanishk2405").trim();
const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim();
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const STORAGE_KEY = "terra_global_reviews_v2";

// Free Instant Cloud Key-Value Store (kvdb.io bucket dedicated to TERRA Storefront)
const CLOUD_BUCKET_URL = "https://kvdb.io/A6Xy9mPq7Vz2Lk8Wn4Jr1T/terra_global_reviews_v2";

function readTmpCache() {
  try {
    if (fs.existsSync(TMP_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TMP_FILE, "utf8"));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {}
  return null;
}

function writeTmpCache(reviews) {
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify(reviews), "utf8");
  } catch (e) {}
}

async function readReviewsFromCloud() {
  // 1. Vercel KV / Upstash Redis (if connected)
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      const res = await fetch(`${REDIS_URL}/get/${STORAGE_KEY}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.result) {
        const parsed = typeof data.result === "string" ? JSON.parse(data.result) : data.result;
        if (Array.isArray(parsed)) {
          writeTmpCache(parsed);
          return { reviews: parsed, storage: "vercel-kv" };
        }
      }
    } catch (e) {}
  }

  // 2. Zero-Config Cloud KV Bucket (Persists across all Vercel serverless cold starts)
  try {
    const res = await fetch(CLOUD_BUCKET_URL, {
      method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" }
    });
    if (res.ok) {
      const text = await res.text();
      if (text) {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          writeTmpCache(parsed);
          return { reviews: parsed, storage: "cloud-db" };
        }
      }
    } else if (res.status === 404) {
      await writeReviewsToCloud(INITIAL_REVIEWS);
      return { reviews: INITIAL_REVIEWS, storage: "cloud-db" };
    }
  } catch (e) {}

  // 3. /tmp Disk Cache + Initial Seed Fallback
  const cached = readTmpCache();
  if (cached) return { reviews: cached, storage: "cloud-cache" };

  writeTmpCache(INITIAL_REVIEWS);
  return { reviews: [...INITIAL_REVIEWS], storage: "cloud-cache" };
}

async function writeReviewsToCloud(reviewsArray) {
  writeTmpCache(reviewsArray);

  if (REDIS_URL && REDIS_TOKEN) {
    try {
      await fetch(`${REDIS_URL}/set/${STORAGE_KEY}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(JSON.stringify(reviewsArray))
      });
      return "vercel-kv";
    } catch (e) {}
  }

  try {
    const res = await fetch(CLOUD_BUCKET_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reviewsArray)
    });
    if (res.ok) return "cloud-db";
  } catch (e) {}

  return "cloud-cache";
}

// Merge client-known reviews with server reviews so no review is ever lost on refresh
function mergeReviews(serverList, clientList, deletedIds = []) {
  const deletedSet = new Set(Array.isArray(deletedIds) ? deletedIds : []);
  const map = new Map();
  [...(Array.isArray(serverList) ? serverList : []), ...(Array.isArray(clientList) ? clientList : [])].forEach(r => {
    if (r && r.id && r.name && r.comment && !deletedSet.has(r.id)) {
      const existing = map.get(r.id);
      if (!existing || r.editedByOwner) {
        map.set(r.id, r);
      }
    }
  });
  const merged = Array.from(map.values()).sort((a, b) => {
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });
  return merged.length > 0 ? merged : [...INITIAL_REVIEWS];
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

  try {
    // 1. GET or SYNC
    if (req.method === "GET" || (req.method === "POST" && body.action === "sync")) {
      const { reviews: serverReviews, storage } = await readReviewsFromCloud();
      let finalReviews = serverReviews;

      if (Array.isArray(body.clientReviews) && body.clientReviews.length > 0) {
        finalReviews = mergeReviews(serverReviews, body.clientReviews, body.deletedIds);
        if (finalReviews.length !== serverReviews.length) {
          await writeReviewsToCloud(finalReviews);
        }
      }

      const reqAdminKey = (req.headers["x-admin-key"] || body.adminKey || "").trim();
      const isOwnerVerified = Boolean(reqAdminKey && reqAdminKey === ADMIN_KEY);
      return res.status(200).json({ ok: true, storage, isOwnerVerified, reviews: finalReviews });
    }

    // 2. POST: Submit a New Review
    if (req.method === "POST") {
      const name = String(body.name || "").trim().slice(0, 60);
      const city = String(body.city || "India").trim().slice(0, 60);
      const comment = String(body.comment || "").trim().slice(0, 500);
      const stars = Math.min(5, Math.max(1, Number(body.stars) || 5));
      const badge = String(body.badge || "Community Dispatch").trim().slice(0, 60);

      if (!name || !comment) {
        return res.status(400).json({ ok: false, message: "Name and review comment are required." });
      }

      const { reviews: serverReviews } = await readReviewsFromCloud();
      const baseReviews = mergeReviews(serverReviews, body.clientReviews, body.deletedIds);

      const newReview = {
        id: "rev-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        name,
        city,
        stars,
        comment,
        badge,
        createdAt: new Date().toISOString()
      };

      const updated = [newReview, ...baseReviews];
      const storage = await writeReviewsToCloud(updated);
      return res.status(201).json({ ok: true, storage, review: newReview, reviews: updated });
    }

    // 3. Verify Owner Passkey for PUT & DELETE
    const providedKey = (req.headers["x-admin-key"] || body.adminKey || "").trim();
    if (!providedKey || providedKey !== ADMIN_KEY) {
      return res.status(401).json({
        ok: false,
        errorCode: "UNAUTHORIZED_OWNER",
        message: "Invalid Owner Passkey. Only the creator can edit or delete reviews."
      });
    }

    // 4. PUT: Owner Edits a Review
    if (req.method === "PUT") {
      const targetId = String(body.id || "").trim();
      const { reviews: serverReviews } = await readReviewsFromCloud();
      const reviews = mergeReviews(serverReviews, body.clientReviews, body.deletedIds);
      const idx = reviews.findIndex(r => r.id === targetId);
      if (idx === -1) {
        return res.status(404).json({ ok: false, message: "Review not found." });
      }

      reviews[idx] = {
        ...reviews[idx],
        name: body.name !== undefined ? String(body.name).trim().slice(0, 60) : reviews[idx].name,
        city: body.city !== undefined ? String(body.city).trim().slice(0, 60) : reviews[idx].city,
        stars: body.stars !== undefined ? Math.min(5, Math.max(1, Number(body.stars))) : reviews[idx].stars,
        comment: body.comment !== undefined ? String(body.comment).trim().slice(0, 500) : reviews[idx].comment,
        badge: body.badge !== undefined ? String(body.badge).trim().slice(0, 60) : reviews[idx].badge,
        editedByOwner: true
      };

      const storage = await writeReviewsToCloud(reviews);
      return res.status(200).json({ ok: true, storage, review: reviews[idx], reviews });
    }

    // 5. DELETE: Owner Removes a Review
    if (req.method === "DELETE") {
      const targetId = String(body.id || req.query?.id || "").trim();
      const { reviews: serverReviews } = await readReviewsFromCloud();
      const merged = mergeReviews(serverReviews, body.clientReviews, body.deletedIds);
      const filtered = merged.filter(r => r.id !== targetId);

      const storage = await writeReviewsToCloud(filtered);
      return res.status(200).json({ ok: true, storage, deletedId: targetId, reviews: filtered });
    }

    return res.status(405).json({ ok: false, message: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message || "Server error" });
  }
}
