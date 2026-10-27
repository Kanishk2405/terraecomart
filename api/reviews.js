// api/reviews.js — Global Cloud Reviews & Owner Moderation API
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

// Fallback in-memory store if cloud env vars aren't added yet
let memoryStore = [...INITIAL_REVIEWS];

const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").trim();
const REDIS_TOKEN = (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const GIST_ID = (process.env.GITHUB_GIST_ID || "").trim();
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || "").trim();

// Your secret owner password (set TERRA_ADMIN_KEY in Vercel Environment Variables)
const ADMIN_KEY = (process.env.TERRA_ADMIN_KEY || "kanishk2405").trim();
const STORAGE_KEY = "terra_global_reviews_v1";

async function readReviewsFromCloud() {
  // Option A: Vercel KV / Upstash Redis
  if (REDIS_URL && REDIS_TOKEN) {
    const res = await fetch(`${REDIS_URL}/get/${STORAGE_KEY}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.result) {
      const parsed = typeof data.result === "string" ? JSON.parse(data.result) : data.result;
      if (Array.isArray(parsed)) return { reviews: parsed, storage: "vercel-kv" };
    }
    // Seed initial reviews on first run
    await writeReviewsToCloud(INITIAL_REVIEWS);
    return { reviews: INITIAL_REVIEWS, storage: "vercel-kv" };
  }

  // Option B: GitHub Gist Database
  if (GIST_ID && GITHUB_TOKEN) {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json"
      }
    });
    if (res.ok) {
      const gist = await res.json();
      const fileContent = gist.files?.["terra-reviews.json"]?.content;
      if (fileContent) {
        return { reviews: JSON.parse(fileContent), storage: "github-gist" };
      }
    }
  }

  // Option C: Warm Serverless Memory Fallback
  return { reviews: memoryStore, storage: "server-memory" };
}

async function writeReviewsToCloud(reviewsArray) {
  memoryStore = reviewsArray;

  if (REDIS_URL && REDIS_TOKEN) {
    await fetch(`${REDIS_URL}/set/${STORAGE_KEY}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(JSON.stringify(reviewsArray))
    });
    return "vercel-kv";
  }

  if (GIST_ID && GITHUB_TOKEN) {
    await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        files: {
          "terra-reviews.json": {
            content: JSON.stringify(reviewsArray, null, 2)
          }
        }
      })
    });
    return "github-gist";
  }

  return "server-memory";
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");

  if (req.method === "OPTIONS") return res.status(204).end();

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body || "{}"); } catch { body = {}; }
  }
  body = body || {};

  try {
    // 1. GET: Anyone can view all reviews
    if (req.method === "GET") {
      const { reviews, storage } = await readReviewsFromCloud();
      // If owner sends x-admin-key on GET, verify if it's valid
      const reqAdminKey = (req.headers["x-admin-key"] || "").trim();
      const isOwnerVerified = Boolean(reqAdminKey && reqAdminKey === ADMIN_KEY);
      return res.status(200).json({ ok: true, storage, isOwnerVerified, reviews });
    }

    // 2. POST: Any visitor can submit a new review
    if (req.method === "POST") {
      const name = String(body.name || "").trim().slice(0, 60);
      const city = String(body.city || "India").trim().slice(0, 60);
      const comment = String(body.comment || "").trim().slice(0, 500);
      const stars = Math.min(5, Math.max(1, Number(body.stars) || 5));
      const badge = String(body.badge || "Community Dispatch").trim().slice(0, 60);

      if (!name || !comment) {
        return res.status(400).json({ ok: false, message: "Name and review comment are required." });
      }

      const { reviews } = await readReviewsFromCloud();
      const newReview = {
        id: "rev-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        name,
        city,
        stars,
        comment,
        badge,
        createdAt: new Date().toISOString()
      };

      const updated = [newReview, ...reviews];
      const storage = await writeReviewsToCloud(updated);
      return res.status(201).json({ ok: true, storage, review: newReview, reviews: updated });
    }

    // 3. Verify Owner Password for PUT (Edit) & DELETE (Remove)
    const providedKey = (req.headers["x-admin-key"] || body.adminKey || "").trim();
    if (!providedKey || providedKey !== ADMIN_KEY) {
      return res.status(401).json({
        ok: false,
        errorCode: "UNAUTHORIZED_OWNER",
        message: "Invalid Owner Passkey. Only the creator can edit or delete reviews."
      });
    }

    // 4. PUT: Owner edits an existing review
    if (req.method === "PUT") {
      const targetId = String(body.id || "").trim();
      const { reviews } = await readReviewsFromCloud();
      const idx = reviews.findIndex(r => r.id === targetId);
      if (idx === -1) {
        return res.status(404).json({ ok: false, message: "Review not found on server." });
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

    // 5. DELETE: Owner removes a review
    if (req.method === "DELETE") {
      const targetId = String(body.id || req.query?.id || "").trim();
      const { reviews } = await readReviewsFromCloud();
      const filtered = reviews.filter(r => r.id !== targetId);

      if (filtered.length === reviews.length) {
        return res.status(404).json({ ok: false, message: "Review ID not found." });
      }

      const storage = await writeReviewsToCloud(filtered);
      return res.status(200).json({ ok: true, storage, deletedId: targetId, reviews: filtered });
    }

    return res.status(405).json({ ok: false, message: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message || "Server error in /api/reviews" });
  }
}